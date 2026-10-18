// The voice's pitch shifter: the pitch moves by the asked semitones, the
// length and loudness stay, streaming in chunks gives the same sound as one
// block, and the stage on the AudioOut tee passes 0 semitones through.
import assert from "node:assert/strict";
import test from "node:test";
import { floatToPcm16, pcm16ToFloat, PitchShifter, PitchStage, semitonesToRatio } from "../src/main/voice/pitch";
import type { AudioBegin, AudioChunk } from "../src/shared/types";

const RATE = 24_000;

function tone(hz: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function shift(input: Float32Array, semitones: number, chunk = input.length): Float32Array {
  const s = new PitchShifter(semitonesToRatio(semitones));
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += chunk) parts.push(s.push(input.slice(i, i + chunk)));
  parts.push(s.flush());
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Frequency from upward zero crossings in the middle of the signal. */
function frequency(x: Float32Array): number {
  const a = Math.floor(x.length * 0.25);
  const b = Math.floor(x.length * 0.75);
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  return ((n - 1) * RATE) / (last - first);
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test("the pitch moves by the semitones asked, the length stays", () => {
  const input = tone(220, 1.5);
  for (const st of [4, 7, -3]) {
    const out = shift(input, st);
    const want = 220 * semitonesToRatio(st);
    assert.ok(Math.abs(frequency(out) - want) / want < 0.03, `${st} st: ${frequency(out).toFixed(1)} Hz, want ${want.toFixed(1)}`);
    assert.ok(Math.abs(out.length - input.length) < RATE * 0.06, `${st} st: ${out.length} samples for ${input.length}`);
  }
});

test("loudness stays, and chunks of any size give the same sound", () => {
  const input = tone(180, 1.2);
  const whole = shift(input, 5);
  const middle = (x: Float32Array) => x.slice(Math.floor(x.length * 0.2), Math.floor(x.length * 0.8));
  assert.ok(Math.abs(rms(middle(whole)) - rms(middle(input))) / rms(middle(input)) < 0.12, `rms ${rms(middle(whole))} vs ${rms(middle(input))}`);
  for (const size of [480, 1000, 7]) {
    const chunked = shift(input, 5, size);
    assert.equal(chunked.length, whole.length, `chunks of ${size}`);
    let diff = 0;
    for (let i = 0; i < whole.length; i++) diff = Math.max(diff, Math.abs(whole[i] - chunked[i]));
    assert.ok(diff < 1e-6, `chunks of ${size} differ by ${diff}`);
  }
});

test("PCM16 round trip", () => {
  const x = new Float32Array([0, 0.5, -0.5, 0.999, -1]);
  const back = pcm16ToFloat(floatToPcm16(x));
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(back[i] - x[i]) < 1e-4);
});

test("the stage shifts each utterance with the pitch it began with; 0 semitones passes through", () => {
  const log: string[] = [];
  const chunks: AudioChunk[] = [];
  const next = {
    audioBegin: (m: AudioBegin) => log.push(`begin ${m.id}`),
    audioChunk: (m: AudioChunk) => chunks.push(m),
    audioEnd: (id: number) => log.push(`end ${id}`),
    audioStop: () => log.push("stop"),
  };
  let semitones = 0;
  const stage = new PitchStage(next, () => semitones);
  const pcm = floatToPcm16(tone(200, 0.3));
  const begin = (id: number): AudioBegin => ({ id, kind: "speech", text: "x", emotion: "neutra", intensity: 0.6, volume: 1 });
  stage.audioBegin(begin(1));
  const buffer = pcm.buffer.slice(0) as ArrayBuffer;
  stage.audioChunk({ id: 1, pcm: buffer, sampleRate: RATE });
  stage.audioEnd(1);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm, buffer, "untouched");

  semitones = 4;
  chunks.length = 0;
  stage.audioBegin(begin(2));
  stage.audioChunk({ id: 2, pcm: pcm.buffer.slice(0) as ArrayBuffer, sampleRate: RATE });
  stage.audioEnd(2);
  const total = chunks.reduce((n, c) => n + c.pcm.byteLength, 0);
  assert.ok(Math.abs(total - pcm.byteLength) < RATE * 0.06 * 2, "about the same length");
  assert.ok(chunks.every((c) => c.id === 2 && c.sampleRate === RATE));
  assert.deepEqual(log, ["begin 1", "end 1", "begin 2", "end 2"]);
});
