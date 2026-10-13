// Lumi's voice for Discord: PCM 16-bit mono at the TTS rate (24 kHz) in,
// PCM 16-bit stereo at 48 kHz out (what @discordjs/voice encodes to Opus).
// Linear interpolation, with the last sample carried between chunks so a
// sentence streamed in pieces has no clicks at the joins. Pure, tested.

export const DISCORD_RATE = 48000;

export class Upsampler {
  /** Position of the next output sample, in input samples (relative to the carried sample). */
  private position = 0;
  private last: number | null = null;

  constructor(
    private readonly inputRate: number,
    private readonly volume = 1,
  ) {}

  /** Converts the next piece of input; returns interleaved stereo s16le. */
  push(input: Int16Array): Buffer {
    if (!input.length) return Buffer.alloc(0);
    // Work on [carried sample, ...input] so interpolation spans the join
    const source = this.last === null ? input : Int16Array.from([this.last, ...input]);
    const step = this.inputRate / DISCORD_RATE;
    const count = Math.max(0, Math.floor((source.length - 1 - this.position) / step) + 1);
    const out = Buffer.alloc(count * 4);
    let p = this.position;
    for (let i = 0; i < count; i++, p += step) {
      const k = Math.floor(p);
      const frac = p - k;
      const a = source[k];
      const b = source[Math.min(k + 1, source.length - 1)];
      const v = Math.max(-32768, Math.min(32767, Math.round((a + (b - a) * frac) * this.volume)));
      out.writeInt16LE(v, i * 4);
      out.writeInt16LE(v, i * 4 + 2);
    }
    // Next time the carried sample is index 0
    this.position = p - (source.length - 1);
    this.last = source[source.length - 1];
    return out;
  }
}

/** PCM 16-bit little endian bytes as samples (copied when not aligned). */
export function samples(pcm: Uint8Array): Int16Array {
  if (pcm.byteOffset % 2 === 0) return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  return new Int16Array(pcm.slice().buffer, 0, Math.floor(pcm.byteLength / 2));
}
