// Shifts the pitch of Lumi's voice without changing its speed, as it
// streams: each sentence's PCM goes through a stateful shifter, chunk by
// chunk, so the first word isn't delayed by more than one analysis window
// (~50 ms). The method: time-stretch by the pitch ratio with WSOLA (overlap-
// add of windowed frames, each taken where it best continues the previous
// one, so no phasiness), then resample by the same ratio, which brings the
// length back and moves the pitch. Formants move with it, a little: up a few
// semitones the voice also sounds younger, which is the "vtuber" effect.
// Pure (no Electron): applied in main on the AudioOut tee, so the speakers,
// the phone and Discord all hear the same voice.
import type { AudioChunk, AudioBegin } from "../../shared/types";

/** 30 ms frames at 24 kHz, half overlapping; frames may slide up to 7.5 ms to line up with the previous one. */
const FRAME = 720;
const HOP = FRAME / 2;
const TOLERANCE = 180;
/** The similarity search looks at every 4th sample: four times cheaper, as good for lining up speech. */
const SEARCH_STEP = 4;

export function semitonesToRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

const HANN = (() => {
  const w = new Float32Array(FRAME);
  // Periodic Hann: at 50% overlap the windows add up to exactly 1
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  return w;
})();

/** One sentence's pitch shifter: push() samples in, get the shifted ones out; flush() at the end. */
export class PitchShifter {
  private input: Float32Array = new Float32Array(0);
  /** Where the next frame would be taken, nominally (input index, fractional). */
  private nominal = 0;
  /** Start of the frame taken last (-1: none yet). */
  private previous = -1;
  private readonly acc = new Float32Array(FRAME);
  /** The stretched signal waiting to be resampled, and the resampler's read position in it. */
  private stretched: Float32Array = new Float32Array(0);
  private readPos = 0;
  private readonly analysisHop: number;

  constructor(readonly ratio: number) {
    // Stretching by `ratio`: the output advances HOP per frame, the input HOP / ratio
    this.analysisHop = HOP / ratio;
  }

  push(samples: Float32Array): Float32Array {
    this.input = concat(this.input, samples);
    this.stretch(false);
    return this.resample(false);
  }

  /** The sentence ended: what is still inside the shifter. */
  flush(): Float32Array {
    // Enough silence to push the last frames through
    this.input = concat(this.input, new Float32Array(FRAME + TOLERANCE + HOP));
    this.stretch(true);
    return this.resample(true);
  }

  private stretch(final: boolean): void {
    const out: Float32Array[] = [];
    for (;;) {
      const nominal = Math.round(this.nominal);
      const natural = this.previous + HOP;
      // Wait for the samples the search and the frame need
      if (nominal + TOLERANCE + FRAME > this.input.length) break;
      if (this.previous >= 0 && natural + FRAME > this.input.length) break;
      let start = Math.max(0, nominal);
      if (this.previous >= 0) start = this.bestStart(nominal, natural);
      for (let i = 0; i < FRAME; i++) this.acc[i] += this.input[start + i] * HANN[i];
      out.push(this.acc.slice(0, HOP));
      this.acc.copyWithin(0, HOP);
      this.acc.fill(0, FRAME - HOP);
      this.previous = start;
      this.nominal += this.analysisHop;
      // Drop the input no frame can reach any more
      const keep = Math.max(0, Math.min(Math.round(this.nominal) - TOLERANCE, this.previous + HOP) - 1);
      if (keep > FRAME * 4) {
        this.input = this.input.slice(keep);
        this.nominal -= keep;
        this.previous -= keep;
      }
    }
    if (final) out.push(this.acc.slice(0, FRAME - HOP));
    for (const part of out) this.stretched = concat(this.stretched, part);
  }

  /** The frame start near `nominal` whose samples best continue the previous frame (the natural continuation at `natural`). */
  private bestStart(nominal: number, natural: number): number {
    let best = Math.max(0, nominal);
    let score = -Infinity;
    const lo = Math.max(0, nominal - TOLERANCE);
    for (let s = lo; s <= nominal + TOLERANCE; s++) {
      let dot = 0;
      let energy = 1e-9;
      for (let i = 0; i < FRAME; i += SEARCH_STEP) {
        const x = this.input[s + i];
        dot += x * this.input[natural + i];
        energy += x * x;
      }
      const c = dot / Math.sqrt(energy);
      if (c > score) {
        score = c;
        best = s;
      }
    }
    return best;
  }

  /** Reads the stretched signal `ratio` samples per output sample (linear interpolation): the original length, the pitch moved. */
  private resample(final: boolean): Float32Array {
    const available = this.stretched.length - 1;
    const count = Math.max(0, Math.floor((available - this.readPos) / this.ratio) + (final ? 1 : 0));
    const out = new Float32Array(count);
    let n = 0;
    while (n < count) {
      const i = Math.floor(this.readPos);
      if (i >= this.stretched.length) break;
      const f = this.readPos - i;
      const a = this.stretched[i];
      const b = i + 1 < this.stretched.length ? this.stretched[i + 1] : a;
      out[n++] = a + (b - a) * f;
      this.readPos += this.ratio;
    }
    const used = Math.floor(this.readPos);
    if (used > 0) {
      this.stretched = this.stretched.slice(Math.min(used, this.stretched.length));
      this.readPos -= Math.min(used, this.readPos);
    }
    return n === count ? out : out.slice(0, n);
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (!a.length) return b.slice();
  if (!b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(pcm.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

interface Out {
  audioBegin(msg: AudioBegin): void;
  audioChunk(msg: AudioChunk): void;
  audioEnd(id: number): void;
  audioStop(fadeMs: number): void;
}

/**
 * The pitch layer on Lumi's audio: every utterance (sentences and cached
 * clips) gets its own shifter at the pitch set when it began; 0 semitones
 * passes the audio through untouched.
 */
export class PitchStage implements Out {
  private readonly shifters = new Map<number, { shifter: PitchShifter; rate: number }>();

  constructor(
    private readonly next: Out,
    private readonly semitones: () => number,
  ) {}

  audioBegin(msg: AudioBegin): void {
    const st = this.semitones();
    if (Math.abs(st) >= 0.05) this.shifters.set(msg.id, { shifter: new PitchShifter(semitonesToRatio(st)), rate: 0 });
    this.next.audioBegin(msg);
  }

  audioChunk(msg: AudioChunk): void {
    const s = this.shifters.get(msg.id);
    if (!s) return this.next.audioChunk(msg);
    s.rate = msg.sampleRate;
    const out = s.shifter.push(pcm16ToFloat(new Uint8Array(msg.pcm)));
    if (out.length) this.next.audioChunk({ id: msg.id, pcm: toArrayBuffer(floatToPcm16(out)), sampleRate: msg.sampleRate });
  }

  audioEnd(id: number): void {
    const s = this.shifters.get(id);
    if (s) {
      this.shifters.delete(id);
      const rest = s.shifter.flush();
      if (rest.length && s.rate) this.next.audioChunk({ id, pcm: toArrayBuffer(floatToPcm16(rest)), sampleRate: s.rate });
    }
    this.next.audioEnd(id);
  }

  audioStop(fadeMs: number): void {
    this.shifters.clear();
    this.next.audioStop(fadeMs);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
