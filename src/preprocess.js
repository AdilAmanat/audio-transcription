/**
 * Preprocessing layer: resample/normalize, then split into bounded chunks.
 *
 * Two engineering decisions live here:
 *
 * 1. Resample to a fixed 16kHz mono target. Most STT engines (Whisper
 *    included) expect 16kHz mono — doing this once, centrally, means engine
 *    code never has to worry about input format variance.
 *
 * 2. Chunk long audio into bounded windows using simple energy-based VAD
 *    (voice activity detection). This matters because:
 *    - Most STT engines have a max input length (Whisper: 30s windows).
 *    - Splitting on silence instead of a hard time cut avoids severing
 *      words mid-utterance at chunk boundaries, which measurably hurts
 *      accuracy.
 *    - It also unlocks parallelism: independent chunks can be transcribed
 *      concurrently instead of one long serial call.
 */
import { makeAudioBuffer } from './models.js';

export const TARGET_SAMPLE_RATE = 16000;
export const MAX_CHUNK_SEC = 30.0;
export const MIN_SILENCE_SEC = 0.3;
export const SILENCE_ENERGY_THRESHOLD = 0.01;

/**
 * @typedef {Object} AudioChunk
 * @property {number[]} samples
 * @property {number} sampleRate
 * @property {number} startSec
 * @property {number} endSec
 */

/** @param {import('./models.js').AudioBuffer} audio */
export function resampleAndNormalize(audio) {
  let { samples, sampleRate: sr } = audio;

  if (sr !== TARGET_SAMPLE_RATE && sr > 0) {
    samples = naiveResample(samples, sr, TARGET_SAMPLE_RATE);
    sr = TARGET_SAMPLE_RATE;
  }

  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) {
    samples = samples.map((s) => (s / peak) * 0.95);
  }

  return makeAudioBuffer({
    samples,
    sampleRate: sr,
    sourcePath: audio.sourcePath,
    durationSec: sr ? samples.length / sr : 0,
  });
}

/** Linear-interpolation resampler. Good enough for speech; a real system
 * would use a proper polyphase resampler — flagged as a known
 * simplification, not hidden. */
function naiveResample(samples, srcSr, dstSr) {
  if (srcSr === dstSr || samples.length === 0) return samples;
  const ratio = dstSr / srcSr;
  const nOut = Math.floor(samples.length * ratio);
  const out = new Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const srcIdx = i / ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIdx - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** Split audio into <= maxChunkSec windows, preferring to cut during
 * low-energy (silent) regions rather than mid-utterance.
 * @param {import('./models.js').AudioBuffer} audio
 * @returns {AudioChunk[]}
 */
export function chunkOnSilence(audio, maxChunkSec = MAX_CHUNK_SEC) {
  const { sampleRate: sr, samples } = audio;
  if (!samples.length) return [];

  const frameSize = Math.max(1, Math.floor(0.02 * sr)); // 20ms frames
  const energies = [];
  for (let i = 0; i < samples.length; i += frameSize) {
    energies.push(rms(samples.slice(i, i + frameSize)));
  }

  const maxChunkSamples = Math.floor(maxChunkSec * sr);
  const minSilenceFrames = Math.max(1, Math.floor((MIN_SILENCE_SEC * sr) / frameSize));

  const chunks = [];
  let chunkStartSample = 0;

  for (let i = 0; i < energies.length; i++) {
    const curSample = i * frameSize;
    if (curSample - chunkStartSample >= maxChunkSamples) {
      const cutFrame = findRecentSilence(energies, i, minSilenceFrames);
      let cutSample = cutFrame !== null ? cutFrame * frameSize : curSample;
      cutSample = Math.max(cutSample, chunkStartSample + frameSize);
      chunks.push(makeChunk(samples, sr, chunkStartSample, cutSample));
      chunkStartSample = cutSample;
    }
  }

  if (chunkStartSample < samples.length) {
    chunks.push(makeChunk(samples, sr, chunkStartSample, samples.length));
  }

  return chunks;
}

function findRecentSilence(energies, upToFrame, minSilenceFrames) {
  let run = 0;
  const floor = Math.max(0, upToFrame - 200);
  for (let f = upToFrame; f > floor; f--) {
    if (energies[f] < SILENCE_ENERGY_THRESHOLD) {
      run += 1;
      if (run >= minSilenceFrames) return f;
    } else {
      run = 0;
    }
  }
  return null;
}

function makeChunk(samples, sr, startSample, endSample) {
  return {
    samples: samples.slice(startSample, endSample),
    sampleRate: sr,
    startSec: startSample / sr,
    endSec: endSample / sr,
  };
}

function rms(frame) {
  if (!frame.length) return 0;
  let sumSq = 0;
  for (const s of frame) sumSq += s * s;
  return Math.sqrt(sumSq / frame.length);
}
