import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAudio } from '../src/audioIo.js';
import { chunkOnSilence, resampleAndNormalize } from '../src/preprocess.js';
import { cleanSegments } from '../src/postprocess.js';
import { makeTranscriptSegment } from '../src/models.js';
import { MockSTTEngine } from '../src/sttEngine.js';
import { TranscriptionPipeline } from '../src/pipeline.js';
import { buildPublisher } from '../src/postprocess.js';

test('mock audio generation is deterministic', () => {
  const a1 = loadAudio('nonexistent_a.wav');
  const a2 = loadAudio('nonexistent_a.wav');
  assert.deepEqual(a1.samples.slice(0, 10), a2.samples.slice(0, 10));
  assert.ok(a1.durationSec > 0);
});

test('different paths produce different audio', () => {
  const a1 = loadAudio('file_a.wav');
  const a2 = loadAudio('file_b.wav');
  assert.notDeepEqual(a1.samples.slice(0, 10), a2.samples.slice(0, 10));
});

test('resample normalizes peak amplitude', () => {
  const audio = loadAudio('test.wav');
  const norm = resampleAndNormalize(audio);
  const peak = Math.max(...norm.samples.map(Math.abs));
  assert.ok(peak <= 0.96);
});

test('chunking respects max length', () => {
  const audio = loadAudio('long.wav');
  const norm = resampleAndNormalize(audio);
  const chunks = chunkOnSilence(norm, 2.0);
  assert.ok(chunks.length >= 1);
  for (const c of chunks) {
    assert.ok(c.endSec - c.startSec <= 2.5); // small tolerance for silence-cut alignment
  }
});

test('chunks cover full duration contiguously', () => {
  const audio = loadAudio('contig.wav');
  const norm = resampleAndNormalize(audio);
  const chunks = chunkOnSilence(norm, 2.0);
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.ok(Math.abs(chunks[i].endSec - chunks[i + 1].startSec) < 1e-4);
  }
});

test('PII redaction removes emails and phone numbers', () => {
  const segs = [makeTranscriptSegment({
    start: 0, end: 1, text: 'call me at 415-555-0199 or a@b.com', confidence: 0.9,
  })];
  const cleaned = cleanSegments(segs);
  assert.ok(!cleaned[0].text.includes('415-555-0199'));
  assert.ok(!cleaned[0].text.includes('a@b.com'));
  assert.ok(cleaned[0].text.includes('[REDACTED_PHONE]'));
  assert.ok(cleaned[0].text.includes('[REDACTED_EMAIL]'));
});

test('pipeline run produces full transcript and publishes', async () => {
  const engine = new MockSTTEngine();
  const publisher = buildPublisher();
  const pipeline = new TranscriptionPipeline({ engine, publisher });

  const result = await pipeline.run('some/mock/call.wav', 'test-req-1');

  assert.equal(result.requestId, 'test-req-1');
  assert.ok(result.segments.length > 0);
  assert.ok(result.text.length > 0);
  assert.equal(publisher.published.length, 1);
  assert.equal(publisher.published[0].payload.requestId, 'test-req-1');
});

test('pipeline recovers from engine failure without throwing', async () => {
  class FlakyEngine extends MockSTTEngine {
    name = 'flaky';
    async transcribeChunk() {
      throw new Error('simulated transient failure');
    }
  }

  const pipeline = new TranscriptionPipeline({ engine: new FlakyEngine(), maxRetries: 1, logger: () => {} });
  const result = await pipeline.run('flaky.wav');

  assert.ok(result.warnings.some((w) => w.includes('failed after retries')));
  assert.ok(result.segments.some((s) => s.text.toLowerCase().includes('transcription failed')));
});
