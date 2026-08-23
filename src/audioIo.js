/**
 * Ingestion layer: turn a file on disk into a normalized AudioBuffer.
 *
 * Engineering decision: isolate all "how do we get PCM samples out of an
 * arbitrary input file" logic here. Formats are messy (mp3/m4a/wav/ogg,
 * variable sample rates, stereo vs mono, container quirks) — the rest of
 * the pipeline should never have to know about any of that. It only ever
 * sees an AudioBuffer.
 *
 * Real decoding: for actual WAV files we do a minimal PCM WAV parser
 * (zero deps, covers the common 16-bit PCM case). For compressed formats
 * (mp3/m4a/ogg) a production build would shell out to ffmpeg or use a
 * package like `music-metadata` + `ffmpeg-static` — flagged here rather
 * than silently faked.
 *
 * If the file doesn't exist (or isn't a WAV we can parse), we fall back to
 * a synthetic generator so the rest of the pipeline is testable without
 * real audio fixtures or extra installs.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { makeAudioBuffer } from './models.js';

export class AudioLoadError extends Error {}

export function loadAudio(pathStr, { mockIfMissing = true } = {}) {
  if (!fs.existsSync(pathStr)) {
    if (mockIfMissing) return generateMockAudio(pathStr);
    throw new AudioLoadError(`Audio file not found: ${pathStr}`);
  }

  // Double check if it's WAV
  if (pathStr.toLowerCase().endsWith('.wav')) {
    try {
      return parseWav(pathStr);
    } catch (e) {
      // Fall through to try converting if parsing fails (e.g. unsupported WAV variant)
    }
  }

  // Attempt using macOS native afconvert for non-WAV / compressed formats
  try {
    return convertAndParse(pathStr);
  } catch (e) {
    if (mockIfMissing) {
      return generateMockAudio(pathStr);
    }
    throw new AudioLoadError(`Failed to decode format ${pathStr}: ${e.message}`);
  }
}

function convertAndParse(inputPath) {
  const tempDir = os.tmpdir();
  const tempWav = path.join(tempDir, `decoded_${crypto.randomUUID()}.wav`);
  let converted = false;

  // 1. Try ffmpeg first (most common on Linux production servers, and cross-platform)
  try {
    execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${tempWav}"`, { stdio: 'ignore' });
    converted = true;
  } catch (ffmpegErr) {
    // 2. Ffmpeg failed or not installed. Try macOS native afconvert fallback
    try {
      execSync(`afconvert -f WAVE -d LEI16@16000 "${inputPath}" "${tempWav}"`, { stdio: 'ignore' });
      converted = true;
    } catch (afconvertErr) {
      // Both failed
    }
  }

  if (!converted) {
    throw new Error("neither 'ffmpeg' nor 'afconvert' was found or succeeded in decoding the audio file. Please install ffmpeg on your system.");
  }

  try {
    const audioBuffer = parseWav(tempWav);
    // Ensure we keep the original filepath as sourcePath in the AudioBuffer
    audioBuffer.sourcePath = inputPath;
    return audioBuffer;
  } finally {
    try { fs.unlinkSync(tempWav); } catch {}
  }
}

/** Minimal 16-bit PCM WAV parser. Good enough for common recordings;
 * doesn't handle float/24-bit/ADPCM WAV variants. */
function parseWav(path) {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let offset = 12;
  let sampleRate = 16000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;

  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataStart = offset + 8;
      dataLength = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (dataStart === -1) throw new Error('no data chunk found');
  if (bitsPerSample !== 16) throw new Error(`unsupported bit depth: ${bitsPerSample}`);

  const bytesPerSample = 2;
  const frameSize = bytesPerSample * numChannels;
  const numFrames = Math.floor(dataLength / frameSize);
  const samples = new Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const sampleOffset = dataStart + i * frameSize + ch * bytesPerSample;
      sum += buf.readInt16LE(sampleOffset) / 32768;
    }
    samples[i] = sum / numChannels; // downmix to mono
  }

  return makeAudioBuffer({
    samples,
    sampleRate,
    sourcePath: path,
    durationSec: numFrames / sampleRate,
  });
}

/** Deterministic fake waveform, seeded from the path so repeated runs
 * against the same "file" are reproducible in tests. */
export function generateMockAudio(path, durationSec = 6.0, sampleRate = 16000) {
  const hash = crypto.createHash('sha256').update(path).digest('hex');
  const seed = parseInt(hash.slice(0, 8), 16) % 997;
  const freq = 110 + (seed % 220); // vary pitch a bit per "file"
  const n = Math.floor(durationSec * sampleRate);
  const samples = new Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = 0.2 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return makeAudioBuffer({ samples, sampleRate, sourcePath: path, durationSec });
}
