/**
 * End-to-end demo using mock audio + mock STT engine (no external deps,
 * no network, no real audio files needed).
 *
 * Run: npm run demo   (or: node demo.js [audioFilePath])
 *
 * The audio file path is optional; when omitted it falls back to a mock file.
 */
import { MockSTTEngine, TranscriptionPipeline, buildPublisher,ElevenLabsEngine } from './src/index.js';

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('ELEVENLABS_API_KEY is not set. Copy .env.example to .env and provide your key, or export it.');
    process.exit(1);
  }
  const engine = new ElevenLabsEngine({ apiKey: process.env.ELEVENLABS_API_KEY, diarize: true });
  const publisher = buildPublisher();
  const pipeline = new TranscriptionPipeline({ engine, publisher });

  // Accept the audio file path as the first CLI arg; default to the mock
  // "support_call_042.wav" which doesn't exist on disk -> audioIo generates a
  // deterministic mock waveform for it, so this runs anywhere with zero setup.
  const audioPath = process.argv[2] ?? '';
  const result = await pipeline.run(audioPath, 'demo-001');

  console.log('\n=== TRANSCRIPT RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== DOWNSTREAM EVENTS PUBLISHED ===');
  for (const event of publisher.published) {
    console.log(
      `topic=${event.topic} request_id=${event.payload.requestId} ` +
      `segments=${event.payload.segments.length} warnings=${JSON.stringify(event.payload.warnings)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
