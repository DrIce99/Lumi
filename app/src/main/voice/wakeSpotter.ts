// Deciding when openWakeWord's scores mean "Lumi" was said: a single peak
// is not enough (two 80 ms frames in a row above the threshold), and while
// Lumi talks the threshold is 30% higher, so its own voice coming back
// through the speakers doesn't wake it. A ring buffer keeps the last 1.5 s
// of speech, so "Lumi, che ore sono?" said in one breath reaches the speech
// recognizer whole.

export const WAKE_FRAMES = 2;
export const SPEAKING_FACTOR = 1.3;
/** Speech kept before the wake word fires: 1.5 s of 16 kHz PCM 16-bit. */
export const PREROLL_BYTES = 1.5 * 32_000;

export class WakeSpotter {
  private streak = 0;

  /** Scores in order; true when the wake word fires (the streak starts over). */
  push(scores: number[], threshold: number, speaking: boolean): boolean {
    const limit = Math.min(0.99, threshold * (speaking ? SPEAKING_FACTOR : 1));
    for (const score of scores) {
      this.streak = score >= limit ? this.streak + 1 : 0;
      if (this.streak >= WAKE_FRAMES) {
        this.streak = 0;
        return true;
      }
    }
    return false;
  }

  reset(): void {
    this.streak = 0;
  }
}

/** The most recent PCM, at most `maxBytes` (whole chunks are dropped from the front). */
export class PcmRing {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = PREROLL_BYTES) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.bytes - this.chunks[0].byteLength >= this.maxBytes) this.bytes -= this.chunks.shift()!.byteLength;
  }

  /** Everything kept, oldest first; the ring is emptied. */
  take(): Uint8Array[] {
    const out = this.chunks;
    this.clear();
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  get size(): number {
    return this.bytes;
  }
}
