// Lumi's voice for Discord: 24 kHz mono to 48 kHz stereo, streamed without clicks.
import assert from "node:assert/strict";
import test from "node:test";
import { samples, Upsampler } from "../src/discord/pcm";
import { sanitizeSettings } from "../src/main/settings";

function read(buf: Buffer): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < buf.length; i += 4) out.push([buf.readInt16LE(i), buf.readInt16LE(i + 2)]);
  return out;
}

test("24 kHz mono becomes 48 kHz stereo: twice the frames, both channels equal, midpoints interpolated", () => {
  const frames = read(new Upsampler(24000).push(Int16Array.from([0, 1000, 2000, 3000])));
  assert.deepEqual(
    frames.map(([l]) => l),
    [0, 500, 1000, 1500, 2000, 2500, 3000],
  );
  assert.ok(frames.every(([l, r]) => l === r));
});

test("a sentence streamed in pieces equals the same sentence in one piece", () => {
  const input = Int16Array.from({ length: 2400 }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
  const whole = new Upsampler(24000).push(input);
  const pieces = new Upsampler(24000);
  const parts: Buffer[] = [];
  for (const [a, b] of [
    [0, 1],
    [1, 333],
    [333, 1000],
    [1000, 2400],
  ])
    parts.push(pieces.push(input.subarray(a, b)));
  assert.deepEqual(Buffer.concat(parts), whole);
});

test("other rates and the volume", () => {
  // 16 kHz: three output frames per input sample, except after the last one (it waits for the next piece)
  assert.equal(new Upsampler(16000).push(new Int16Array(1600)).length / 4, 1599 * 3 + 1);
  const loud = read(new Upsampler(48000, 0.5).push(Int16Array.from([20000, -30000])));
  assert.deepEqual(loud, [
    [10000, 10000],
    [-15000, -15000],
  ]);
  const odd = new Uint8Array([0, 1, 0, 2, 0]).subarray(1);
  assert.deepEqual([...samples(odd)], [1, 2], "unaligned bytes are copied");
});

test("Discord settings: off by default; the user is an id or a username", () => {
  assert.deepEqual(sanitizeSettings({}).discord, { enabled: false, userId: "" });
  assert.equal(sanitizeSettings({ discord: { enabled: true, userId: " 123456789012345678 " } }).discord.userId, "123456789012345678");
  // A username works too (the bot matches it in the voice states); mentions and @ are cleaned up
  assert.equal(sanitizeSettings({ discord: { userId: "@DrIce" } }).discord.userId, "drice");
  assert.equal(sanitizeSettings({ discord: { userId: "<@123456789012345678>" } }).discord.userId, "123456789012345678");
  assert.equal(sanitizeSettings({ discord: { userId: "non è un nome" } }).discord.userId, "");
});
