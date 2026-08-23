/**
 * Shared data shapes passed between pipeline stages.
 *
 * Node doesn't have dataclasses, so we use plain factory functions that
 * return frozen-ish objects with a fixed shape. Keeping this as one file
 * with JSDoc typedefs gives us the same benefit the Python dataclasses did:
 * one place to change the schema if downstream consumers need more fields
 * (e.g. speaker labels, word-level timestamps), and editor autocomplete
 * everywhere these shapes are used.
 */

/**
 * @typedef {Object} AudioBuffer
 * @property {number[]} samples - mono PCM samples, normalized to [-1, 1]
 * @property {number} sampleRate
 * @property {string} sourcePath
 * @property {number} durationSec
 */

/**
 * @typedef {Object} TranscriptSegment
 * @property {number} start - seconds from start of audio
 * @property {number} end
 * @property {string} text
 * @property {number} confidence - 0-1, engine-reported or estimated
 * @property {string|null} speaker - populated only if diarization is enabled
 */

/**
 * @typedef {Object} TranscriptResult
 * @property {string} requestId
 * @property {string} sourcePath
 * @property {string} language
 * @property {number} durationSec
 * @property {TranscriptSegment[]} segments
 * @property {string} text - full concatenated transcript
 * @property {string} engine - which STT engine produced this
 * @property {number} createdAt
 * @property {Object.<string, number>} stageTimingsMs
 * @property {string[]} warnings
 */

export function makeAudioBuffer({ samples, sampleRate, sourcePath, durationSec }) {
  return { samples, sampleRate, sourcePath, durationSec };
}

export function makeTranscriptSegment({ start, end, text, confidence, speaker = null }) {
  return { start, end, text, confidence, speaker };
}

export function makeTranscriptResult({
  requestId, sourcePath, language, durationSec, segments, text, engine,
  stageTimingsMs = {}, warnings = [],
}) {
  return {
    requestId,
    sourcePath,
    language,
    durationSec,
    segments,
    text,
    engine,
    createdAt: Date.now() / 1000,
    stageTimingsMs,
    warnings,
  };
}
