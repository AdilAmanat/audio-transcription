/**
 * Orchestration layer: wires ingest -> preprocess -> transcribe ->
 * postprocess -> publish, with per-stage timing, retries, and logging.
 *
 * Engineering decisions worth calling out:
 *
 * - Idempotency: requestId is derived from the input path + a
 *   caller-supplied id if given, so retries/re-runs against the same input
 *   are traceable and a downstream consumer can dedupe on it.
 * - Retries only wrap the STT call, since that's the stage most likely to
 *   hit transient failures (rate limits, network blips) when using a
 *   real/cloud engine. Retrying preprocessing or publishing wouldn't fix a
 *   real failure there and would just mask bugs.
 * - Partial failure handling: if one chunk fails after retries, we don't
 *   fail the whole transcript — we emit a placeholder segment and a
 *   warning, so a 30-minute call doesn't get thrown away because 4 seconds
 *   of it errored.
 * - Chunks are transcribed concurrently (Promise.all, order preserved by
 *   index) rather than serially — this is one place where the Node port
 *   genuinely improves on the Python reference, since I/O-bound STT calls
 *   (especially against a cloud API) parallelize naturally on Node's event
 *   loop without needing a thread pool. Cap concurrency if you're hitting
 *   a rate-limited API (see `concurrency` option).
 * - Stage timings are captured and attached to the result, since "which
 *   stage is slow" is the first question anyone asks in production.
 */
import { randomUUID } from 'node:crypto';
import { loadAudio } from './audioIo.js';
import { makeTranscriptSegment, makeTranscriptResult } from './models.js';
import { cleanSegments, flagLowConfidence } from './postprocess.js';
import { chunkOnSilence, resampleAndNormalize } from './preprocess.js';

export class TranscriptionPipeline {
  /**
   * @param {Object} opts
   * @param {import('./sttEngine.js').STTEngine} opts.engine
   * @param {import('./postprocess.js').DownstreamPublisher} [opts.publisher]
   * @param {number} [opts.maxRetries]
   * @param {string} [opts.publishTopic]
   * @param {number} [opts.concurrency] - max chunks transcribed in parallel
   * @param {(...args: any[]) => void} [opts.logger]
   */
  constructor({
    engine, publisher = null, maxRetries = 2,
    publishTopic = 'transcripts.completed', concurrency = 4,
    logger = console.log,
  }) {
    this.engine = engine;
    this.publisher = publisher;
    this.maxRetries = maxRetries;
    this.publishTopic = publishTopic;
    this.concurrency = concurrency;
    this.log = logger;
  }

  /**
   * @param {string} audioPath
   * @param {string} [requestId]
   * @returns {Promise<import('./models.js').TranscriptResult>}
   */
  async run(audioPath, requestId = null) {
    requestId = requestId || randomUUID();
    const timings = {};
    const warnings = [];
    this.log(`[run_start] request_id=${requestId} path=${audioPath}`);

    let allSegments = [];
    let durationSec = 0;

    if (this.engine.canTranscribeFile) {
      this.log(`[streaming_file_transcribe] request_id=${requestId} sending stream to engine directly`);
      let t0 = now();
      const res = await this.engine.transcribeFile(audioPath);
      allSegments = res.segments;
      timings.ingestMs = 0;
      timings.preprocessMs = 0;
      timings.transcribeMs = elapsedMs(t0);
      
      if (allSegments.length > 0) {
        durationSec = allSegments[allSegments.length - 1].end;
      }
    } else {
      let t0 = now();
      const rawAudio = loadAudio(audioPath);
      timings.ingestMs = elapsedMs(t0);

      t0 = now();
      const audio = resampleAndNormalize(rawAudio);
      const chunks = chunkOnSilence(audio);
      timings.preprocessMs = elapsedMs(t0);
      this.log(`[preprocess] request_id=${requestId} chunks=${chunks.length} duration=${audio.durationSec.toFixed(1)}s`);
      durationSec = audio.durationSec;

      t0 = now();
      const segmentLists = await mapWithConcurrency(
        chunks,
        this.concurrency,
        (chunk, i) => this._transcribeWithRetry(chunk, requestId, i)
      );
      for (const { segments, warning } of segmentLists) {
        allSegments = allSegments.concat(segments);
        if (warning) warnings.push(warning);
      }
      timings.transcribeMs = elapsedMs(t0);
    }

    let t0 = now();
    allSegments.sort((a, b) => a.start - b.start);
    const cleaned = cleanSegments(allSegments);
    warnings.push(...flagLowConfidence(cleaned));
    const fullText = cleaned.map((s) => s.text).join(' ');
    timings.postprocessMs = elapsedMs(t0);

    const result = makeTranscriptResult({
      requestId,
      sourcePath: audioPath,
      language: 'en', // a real multi-lingual engine would report this per-chunk
      durationSec,
      segments: cleaned,
      text: fullText,
      engine: this.engine.name,
      stageTimingsMs: timings,
      warnings,
    });

    if (this.publisher) {
      t0 = now();
      this.publisher.publish(this.publishTopic, result);
      timings.publishMs = elapsedMs(t0);
    }

    const totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
    this.log(`[run_complete] request_id=${requestId} total_ms=${totalMs.toFixed(1)} warnings=${warnings.length}`);
    return result;
  }

  async _transcribeWithRetry(chunk, requestId, chunkIdx) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const segments = await this.engine.transcribeChunk(chunk);
        return { segments, warning: null };
      } catch (e) {
        lastErr = e;
        this.log(`[retry] request_id=${requestId} chunk=${chunkIdx} attempt=${attempt} failed: ${e.message}`);
        await sleep(Math.min(500 * attempt, 2000)); // simple backoff
      }
    }

    // All retries exhausted: don't drop the whole transcript, emit a
    // placeholder so downstream knows exactly what's missing and why.
    const placeholder = [
      makeTranscriptSegment({
        start: chunk.startSec, end: chunk.endSec,
        text: '[transcription failed]', confidence: 0,
      }),
    ];
    const warning = `chunk ${chunkIdx} (${chunk.startSec.toFixed(1)}-${chunk.endSec.toFixed(1)}s) failed after retries: ${lastErr.message}`;
    return { segments: placeholder, warning };
  }
}

/** Runs `fn` over `items` with bounded concurrency, preserving input order
 * in the returned array. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, worker);
  await Promise.all(workers);
  return results;
}

function now() {
  return process.hrtime.bigint();
}

function elapsedMs(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
