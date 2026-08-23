# audio-transcription

A modular audio transcription pipeline in Node.js: **ingest → preprocess → transcribe → postprocess → publish**.

Transcription results carry **per-segment timestamps** (`start`/`end` in seconds, relative to the original audio), per-segment confidence, and — when diarization is enabled — speaker labels.

```text
audio file ─► ingest ─► preprocess ─► transcribe ─► postprocess ─► publish
             load      resample+      chunk/        clean, PII,      in-memory
             audio     normalize      stream        flag low-conf    event sink
```

## Quick start

```bash
npm install
cp .env.example .env        # then put your ELEVENLABS_API_KEY in .env
export ELEVENLABS_API_KEY   # or load your .env another way
npm test                     # run the test suite (8 tests, no network)
node demo.js ./mock_audio/<your-file>.oga   # end-to-end demo
```

The demo scripts and tests work with **zero external dependencies** by default: the `MockSTTEngine` produces deterministic, offline transcriptions, so the whole pipeline is exercisable without a GPU or an API key. Wire up a real engine (below) when you want actual speech recognition.

## The data model

Shared shapes are defined once in [`src/models.js`](src/models.js) and flow through every stage:

- **`TranscriptSegment`** — `start` (seconds), `end` (seconds), `text`, `confidence` (0–1), `speaker` (string | null, populated only when diarization is on). This is the per-segment timestamped unit.
- **`TranscriptResult`** — `requestId`, `sourcePath`, `language`, `durationSec`, `segments[]`, full `text`, `engine`, `createdAt`, `stageTimingsMs`, `warnings`.

## Engines

`src/sttEngine.js` defines a narrow interface — `transcribeChunk(chunk)` (and `transcribeFile(path)` for engines that can accept the whole file) — so the pipeline is agnostic to which recognizer sits behind it. Three implementations are provided:

| Engine | Notes |
| --- | --- |
| `MockSTTEngine` | Deterministic, offline. Text is derived from a hash of the chunk's samples, so identical input always yields identical output (reproducible tests) while different chunks differ. |
| `NodeWhisperEngine` | Real local transcription via `nodejs-whisper` (a whisper.cpp binding). Loaded lazily so it stays optional. |
| `ElevenLabsEngine` | Cloud STT (Scribe v2) via the official SDK. Supports `diarize` for per-speaker segmentation and `languageCode` for language hints. |

Swapping engines never touches preprocessing, postprocessing, or orchestration — that is the whole point of the interface.

### Timestamps & diarization

Every engine emits segments with real `start`/`end` times. Note the difference in granularity:

- **Chunked engines** (mock, whisper) emit at least one timestamped segment per 30s chunk.
- **`ElevenLabsEngine` without diarization** collapses the whole file (or chunk) into a *single* segment spanning first-word start to last-word end — one timestamp pair, not per-turn.
- **`ElevenLabsEngine` with `diarize: true`** groups consecutive words by their `speakerId` into separate segments, producing fine-grained, per-speaker timestamps across a long file.

If you want per-turn granularity without speaker labels, that would be a separate segmentation strategy — currently the non-diarized path intentionally returns a single segment.

> **Implementation note:** the ElevenLabs SDK returns camelCase fields (`speakerId`, `languageProbability`). The engine reads those exact names. Historically this code referenced snake_case (`speaker_id`, `language_probability`), which silently disabled diarization — every segment came back as one block with `speaker: null`. If you port this code, double-check your SDK's casing; a field-name mismatch fails silently, not loudly.

## Preprocessing

`src/preprocess.js` makes two decisions up front:

1. **Resample to 16 kHz mono** — the format most STT engines expect (Whisper included). Doing it once, centrally, keeps engine code free of input-format variance. The resampler is a naive linear-interpolation implementation — a deliberate simplification, flagged in a comment rather than hidden.
2. **Chunk long audio into ≤30 second windows using energy-based VAD** (voice activity detection), preferring to cut during silence rather than mid-utterance. That matters because:
   - Most STT engines have a max input length (Whisper: 30s).
   - Cutting on silence instead of a hard time boundary avoids severing words mid-utterance, which measurably hurts accuracy.
   - Independent chunks unlock **parallel transcription** (below).

## Orchestration

`src/pipeline.js` wires the stages and encodes several production-oriented decisions:

- **Idempotency** — `requestId` is derived from the input path and an optional caller-supplied id, so re-runs against the same input are traceable and downstream consumers can dedupe on it.
- **Retries** — only the STT call is retried (with simple backoff), since that is the stage most likely to hit transient failures (rate limits, network blips). Retrying preprocessing or publishing would only mask real failures there.
- **Partial-failure handling** — if a chunk fails after retries, the pipeline doesn't discard the whole transcript. It emits a placeholder segment (`[transcription failed]`) and a warning, so a 30-minute call isn't thrown away over a bad 4 seconds.
- **Concurrency** — chunks are transcribed in parallel via bounded `Promise.all` (order preserved by index), capped by a `concurrency` option. I/O-bound STT calls parallelize naturally on Node's event loop; lower the cap if you hit a rate-limited API.
- **Stage timing** — `stageTimingsMs` is attached to every result, because "which stage is slow" is the first question anyone asks in production.

After transcription, segments are sorted by start time and concatenated into the full `text`. When the engine supports `transcribeFile` (e.g. a streaming cloud API), the pipeline sends the file directly and skips local preprocessing.

## Postprocessing & publish

`src/postprocess.js` has two responsibilities:

1. **Cleaning raw STT output** before it reaches consumers:
   - Collapses whitespace and fixes casing at segment boundaries.
   - Light **PII redaction** (emails, phone numbers) — transcripts of real calls routinely contain PII; scrubbing it before it lands in logs, search indexes, or analytics is cheap insurance.
   - **Flags low-confidence** segments (`confidence < 0.5`) into warnings so downstream systems can route transcripts for review rather than silently trusting garbage text.
2. **Publishing** — modeled as an in-memory event sink (`DownstreamPublisher.publish(topic, result)`), structured exactly like a Kafka/SQS/PubSub producer call so swapping in a real queue is a small, localized change.

## Testing

`tests/pipeline.test.js` runs with Node's built-in test runner (`node --test`, no extra deps) and covers:

- Deterministic mock audio generation; contiguity of chunk coverage.
- Resampling/normalization behavior.
- PII redaction.
- A full pipeline run that produces a transcript and publishes an event.
- Recovery from a flaky engine (placeholder segment + warning instead of a thrown error).

## Layout

```text
src/
  audioIo.js    ingest — load audio (or generate deterministic mock audio)
  preprocess.js resample/normalize + silence-aware chunking
  sttEngine.js  STT engines (mock, whisper, ElevenLabs) — the swappable core
  pipeline.js   orchestration: timings, retries, concurrency
  postprocess.js cleaning (PII, casing) + low-confidence flags + publisher
  models.js     shared data shapes (TranscriptSegment / TranscriptResult)
demo.js         end-to-end demo using Mock or ElevenLabs engine
tests/          Node test runner suite
```