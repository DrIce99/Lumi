// LUMI_DEBUG_HEAR=<file.wav>: feeds a WAV file to the turn manager as if
// it were spoken while holding push-to-talk (tests hearing without a
// microphone). Accepts PCM 16-bit WAV at any rate, mono or stereo.
import { readFileSync } from "node:fs";

export interface Pcm {
  samples: Int16Array;
  rate: number;
}

/** Reads a PCM 16-bit WAV file (first channel). */
export function readWav(path: string): Pcm {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let channels = 1;
  let rate = 16_000;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error("only 16-bit WAV files");
      const frames = Math.floor(size / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(offset + 8 + i * 2 * channels);
      return { samples, rate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no audio data in the WAV file");
}

/** Linear resampling to 16 kHz, as PCM 16-bit little endian frames of 512 samples (32 ms, like the VAD). */
export function toFrames16k(pcm: Pcm): Uint8Array[] {
  const ratio = pcm.rate / 16_000;
  const length = Math.floor(pcm.samples.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = pcm.samples[j] ?? 0;
    const b = pcm.samples[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  const frames: Uint8Array[] = [];
  for (let i = 0; i < out.length; i += 512) {
    const chunk = out.slice(i, i + 512);
    frames.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return frames;
}
