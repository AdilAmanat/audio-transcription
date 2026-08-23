/**
 * Postprocessing + publish layer.
 *
 * Two responsibilities:
 *
 * 1. Clean up raw STT output before it reaches downstream consumers:
 *    - collapse whitespace / fix casing at segment boundaries
 *    - light PII redaction (emails, phone numbers) — STT transcripts of
 *      real calls routinely contain PII, and scrubbing it before it lands
 *      in logs, search indexes, or analytics pipelines is cheap insurance.
 *    - flag low-confidence segments so downstream systems can route
 *      transcripts for review rather than silently trusting garbage text.
 *
 * 2. Publish the final TranscriptResult to "downstream" — modeled here as
 *    an in-memory event sink, but structured exactly like you'd structure
 *    a Kafka/SQS/PubSub producer call, so swapping in a real queue is a
 *    small, localized change.
 */
import { makeTranscriptSegment } from './models.js';

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\b(?:\+?\d[\d\-\s()]{7,}\d)\b/g;

export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** @param {import('./models.js').TranscriptSegment[]} segments */
export function cleanSegments(segments) {
  return segments.map((seg) => {
    let text = seg.text.replace(/\s+/g, ' ').trim();
    if (text) text = text[0].toUpperCase() + text.slice(1);
    text = text.replace(EMAIL_RE, '[REDACTED_EMAIL]');
    text = text.replace(PHONE_RE, '[REDACTED_PHONE]');
    return makeTranscriptSegment({
      start: seg.start, end: seg.end, text, confidence: seg.confidence, speaker: seg.speaker,
    });
  });
}

/** @param {import('./models.js').TranscriptSegment[]} segments */
export function flagLowConfidence(segments) {
  const flagged = segments.filter((s) => s.confidence < LOW_CONFIDENCE_THRESHOLD);
  if (!flagged.length) return [];
  const total = flagged.reduce((sum, s) => sum + (s.end - s.start), 0);
  return [`${flagged.length} segment(s) (${total.toFixed(1)}s) below confidence threshold ${LOW_CONFIDENCE_THRESHOLD}`];
}

/**
 * Stand-in for a real event bus / queue producer. In production this
 * constructor would take a Kafka/SQS/PubSub client; publish() would
 * serialize and send. Kept in-memory here so the pipeline is testable
 * without external infra, but the call shape (`publish(topic, result)`)
 * is what you'd keep if you swapped the backend.
 */
export class DownstreamPublisher {
  constructor() {
    this.published = [];
  }

  /** @param {string} topic @param {import('./models.js').TranscriptResult} result */
  publish(topic, result) {
    this.published.push({ topic, payload: result });
  }
}

export function buildPublisher() {
  return new DownstreamPublisher();
}
