/**
 * STT engine layer.
 *
 * Key engineering decision: define a narrow interface (`transcribeChunk`)
 * so the pipeline is agnostic to which speech recognizer sits behind it.
 * Today that's a mock or a local whisper.cpp binding; tomorrow it could be
 * Deepgram, AssemblyAI, AWS Transcribe, or a fine-tuned in-house model —
 * swapping engines should never require touching preprocessing,
 * postprocessing, or orchestration code.
 *
 * Three implementations are provided:
 * - MockSTTEngine: deterministic, offline, zero dependencies. Used for
 *   tests, demos, and local dev so the rest of the pipeline can be
 *   validated without a GPU or network access.
 * - NodeWhisperEngine: real transcription via `nodejs-whisper` (a
 *   whisper.cpp binding), loaded lazily so the dependency is optional.
 * - CloudAPIEngineTemplate: shows the shape of a hosted-API integration
 *   (Deepgram/AssemblyAI/AWS Transcribe/etc) — swap in the same way.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { makeTranscriptSegment } from './models.js';

/**
 * @abstract
 */
export class STTEngine {
  name = 'base';
  canTranscribeFile = false;

  /**
   * Transcribe one bounded audio chunk, returning segments with timestamps
   * relative to the *original* audio (caller offsets).
   * @param {import('./preprocess.js').AudioChunk} chunk
   * @returns {Promise<import('./models.js').TranscriptSegment[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async transcribeChunk(chunk) {
    throw new Error('transcribeChunk() must be implemented by subclass');
  }

  // eslint-disable-next-line no-unused-vars
  async transcribeFile(audioPath) {
    throw new Error('transcribeFile() is not supported by this engine');
  }
}

const PHRASE_BANK = [
  "thanks for calling support, how can I help you today",
  "I'm having trouble logging into my account",
  "let me pull up your account details",
  "can you confirm the email address on file",
  "I've reset your password, you should get an email shortly",
  "is there anything else I can help you with",
  "thank you for your patience, have a great day",
];

/**
 * Deterministic fake transcription for offline dev/testing. Text is
 * derived from a hash of the chunk's samples so the same input always
 * produces the same output (reproducible tests), while different chunks
 * produce visibly different text.
 */
export class MockSTTEngine extends STTEngine {
  name = 'mock-stt-v1';

  async transcribeChunk(chunk) {
    const digest = crypto
      .createHash('sha256')
      .update(chunk.samples.slice(0, 50).join(','))
      .digest('hex');
    const idx = parseInt(digest, 16) % PHRASE_BANK.length;
    const text = PHRASE_BANK[idx];
    const confidence = 0.8 + (parseInt(digest.slice(0, 4), 16) % 20) / 100;
    return [
      makeTranscriptSegment({
        start: chunk.startSec,
        end: chunk.endSec,
        text,
        confidence: Math.round(Math.min(confidence, 0.99) * 1000) / 1000,
      }),
    ];
  }
}

/**
 * Real local transcription via `nodejs-whisper` (a whisper.cpp binding).
 * Lazily imports the dependency so environments without it installed can
 * still run the pipeline with MockSTTEngine. To use this:
 *   npm install nodejs-whisper
 * (nodejs-whisper additionally requires a compiled whisper.cpp model file
 * — see its README for the model-download step.)
 */
export class NodeWhisperEngine extends STTEngine {
  name = 'nodejs-whisper';

  constructor({ modelName = 'base.en' } = {}) {
    super();
    this.modelName = modelName;
    this._nodewhisper = null;
  }

  async _ensureLoaded() {
    if (this._nodewhisper) return;
    try {
      const mod = await import('nodejs-whisper');
      this._nodewhisper = mod.nodewhisper;
    } catch (e) {
      throw new Error(
        'nodejs-whisper is not installed. Run `npm install nodejs-whisper` ' +
        'or use MockSTTEngine instead.'
      );
    }
  }

  async transcribeChunk(chunk) {
    await this._ensureLoaded();
    // nodejs-whisper operates on a WAV file path rather than raw samples,
    // so a real implementation would write `chunk.samples` to a temp WAV
    // file here before calling it. Left as the integration point rather
    // than adding a temp-file dependency to this reference implementation.
    const result = await this._nodewhisper(chunk._tempWavPath, {
      modelName: this.modelName,
      whisperOptions: { outputInText: false },
    });
    return (result.segments || []).map((seg) =>
      makeTranscriptSegment({
        start: chunk.startSec + seg.start,
        end: chunk.startSec + seg.end,
        text: seg.text.trim(),
        confidence: seg.confidence ?? 0.75,
      })
    );
  }
}

/**
 * Real cloud transcription via ElevenLabs Scribe v2 STT API using official SDK.
 * Requires an ElevenLabs API key.
 *
 * Usage:
 *   const engine = new ElevenLabsEngine({ apiKey: 'your-xi-api-key' });
 */
export class ElevenLabsEngine extends STTEngine {
  name = 'elevenlabs-scribe-v2';

  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - ElevenLabs API key
   * @param {string} [opts.languageCode] - Language code (e.g. 'eng'), null for auto-detect
   * @param {boolean} [opts.diarize] - Whether to annotate who is speaking
   * @param {string} [opts.modelId] - Model to use (default: scribe_v2)
   */
  canTranscribeFile = true;

  constructor({ apiKey, languageCode = null, diarize = false, modelId = 'scribe_v2' } = {}) {
    super();
    if (!apiKey) throw new Error('ElevenLabsEngine requires an apiKey');
    this.client = new ElevenLabsClient({ apiKey });
    this.languageCode = languageCode;
    this.diarize = diarize;
    this.modelId = modelId;
  }

  async transcribeFile(audioPath) {
    const fileStream = fs.createReadStream(audioPath);

    const results = await this.client.speechToText.convert({
      file: fileStream,
      modelId: this.modelId,
      languageCode: this.languageCode || undefined,
      diarize: this.diarize,
      tagAudioEvents: true,
    });

    if (!results.words || results.words.length === 0) {
      return {
        segments: [
          makeTranscriptSegment({
            start: 0,
            end: 0,
            text: results.text || '',
            confidence: results.languageProbability ?? 0.9,
            speaker: null,
          }),
        ],
        text: results.text || '',
      };
    }

    let parsedSegments;
    const chunkMock = { startSec: 0, endSec: 0 };
    if (this.diarize) {
      parsedSegments = this._groupBySpeaker(results, chunkMock);
    } else {
      const firstWord = results.words[0];
      const lastWord = results.words[results.words.length - 1];
      parsedSegments = [
        makeTranscriptSegment({
          start: firstWord.start ?? 0,
          end: lastWord.end ?? 0,
          text: results.text.trim(),
          confidence: results.languageProbability ?? 0.9,
          speaker: firstWord.speakerId ?? null,
        }),
      ];
    }

    return {
      segments: parsedSegments,
      text: results.text.trim(),
    };
  }

  async transcribeChunk(chunk) {
    const wavBuffer = makeWavBuffer(chunk.samples, chunk.sampleRate);
    const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });

    const results = await this.client.speechToText.convert({
      file: audioBlob,
      modelId: this.modelId,
      languageCode: this.languageCode || undefined,
      diarize: this.diarize,
      tagAudioEvents: true,
    });

    if (!results.words || results.words.length === 0) {
      return [
        makeTranscriptSegment({
          start: chunk.startSec,
          end: chunk.endSec,
          text: results.text || '',
          confidence: results.languageProbability ?? 0.9,
          speaker: null,
        }),
      ];
    }

    if (this.diarize) {
      return this._groupBySpeaker(results, chunk);
    }

    // Single segment per chunk
    const firstWord = results.words[0];
    const lastWord = results.words[results.words.length - 1];
    return [
      makeTranscriptSegment({
        start: chunk.startSec + (firstWord.start ?? 0),
        end: chunk.startSec + (lastWord.end ?? chunk.endSec - chunk.startSec),
        text: results.text.trim(),
        confidence: results.languageProbability ?? 0.9,
        speaker: firstWord.speakerId ?? null,
      }),
    ];
  }

  /** Group consecutive words by speakerId into separate segments. */
  _groupBySpeaker(data, chunk) {
    const segments = [];
    let currentSpeaker = null;
    let segWords = [];

    for (const word of data.words) {
      if (word.type !== 'word') continue;
      if (word.speakerId !== currentSpeaker && segWords.length > 0) {
        segments.push(this._wordsToSegment(segWords, currentSpeaker, chunk, data));
        segWords = [];
      }
      currentSpeaker = word.speakerId;
      segWords.push(word);
    }
    if (segWords.length > 0) {
      segments.push(this._wordsToSegment(segWords, currentSpeaker, chunk, data));
    }

    return segments;
  }

  _wordsToSegment(words, speaker, chunk, data) {
    return makeTranscriptSegment({
      start: chunk.startSec + (words[0].start ?? 0),
      end: chunk.startSec + (words[words.length - 1].end ?? 0),
      text: words.map((w) => w.text).join(' ').trim(),
      confidence: data.languageProbability ?? 0.9,
      speaker: speaker ?? null,
    });
  }
}

/** Generates standard 16-bit mono PCM WAV bytes from float samples */
function makeWavBuffer(samples, sampleRate) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const dataBytes = numSamples * bytesPerSample;
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataBytes);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);

  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // chunk size
  buf.writeUInt16LE(1, 20);           // PCM format
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(sampleRate, 24);  // sample rate
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32);              // block align
  buf.writeUInt16LE(16, 34);          // bits per sample

  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = Math.round(clamped * 32767);
    buf.writeInt16LE(int16, headerSize + i * bytesPerSample);
  }

  return buf;
}
