// Glare: detection on luminance frames and the squint animation.
import assert from "node:assert/strict";
import test from "node:test";
import type { Frame } from "../src/main/perception/diff";
import { COOLDOWN_MS, GlareDetector, glareStats, linearize, THUMB_H, THUMB_W, thumbnail } from "../src/main/perception/glare";
import { FAR_MIN, glareEnd, glareFrame, NEAR_MIN, nearSide, REOPEN_MS, SPEAKING_STRENGTH, SQUINT_MS, startGlare } from "../src/renderer/face/glare";

function frame(width: number, height: number, paint: (x: number, y: number) => number): Frame {
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) luma[y * width + x] = paint(x, y);
  return { width, height, luma };
}

const stats = (paint: (x: number, y: number) => number) => glareStats(thumbnail(frame(640, 360, paint)));
const DARK = stats(() => 30); // a dark editor
const WHITE = stats(() => 250); // a white page

test("luminance is linearized: mid-grey 8-bit is about 21% of the light", () => {
  assert.equal(linearize(0), 0);
  assert.ok(Math.abs(linearize(255) - 1) < 1e-6);
  assert.ok(Math.abs(linearize(128) - 0.216) < 0.002);
});

test("the thumbnail averages blocks; stats give mean, bright share and where the light is", () => {
  const thumb = thumbnail(frame(640, 360, (x) => (x >= 320 ? 255 : 0)));
  assert.equal(thumb.length, THUMB_W * THUMB_H);
  const s = glareStats(thumb);
  assert.ok(Math.abs(s.mean - 0.5) < 0.01);
  assert.ok(Math.abs(s.bright - 0.5) < 0.01);
  assert.ok(s.centroid && Math.abs(s.centroid.x - 0.75) < 0.01 && Math.abs(s.centroid.y - 0.5) < 0.01, "light on the right half");
  assert.ok(DARK.mean < 0.02 && WHITE.mean > 0.9 && WHITE.bright === 1);
  assert.equal(DARK.centroid, null);
});

test("a sudden jump from dark to bright dazzles; then 20 s of rest", () => {
  const g = new GlareDetector();
  assert.equal(g.push(DARK, 0, 1), null);
  assert.equal(g.push(DARK, 250, 1), null);
  const event = g.push(WHITE, 500, 1);
  assert.ok(event);
  assert.ok(Math.abs(event.centroid.x - 0.5) < 0.01);
  // Back to dark and bright again: too soon
  g.push(DARK, 2000, 1);
  assert.equal(g.push(WHITE, 2250, 1), null);
  g.push(DARK, COOLDOWN_MS + 600, 1);
  assert.ok(g.push(WHITE, COOLDOWN_MS + 800, 1), "after the rest it works again");
});

test("slow fades, half-bright screens, another monitor and a sleeping Lumi don't dazzle", () => {
  // A fade over 1.5 s: never dark and bright within 500 ms
  const fade = new GlareDetector();
  for (let i = 0; i <= 6; i++) {
    const level = Math.round(30 + (220 * i) / 6);
    assert.equal(fade.push(stats(() => level), i * 250, 1), null, `step ${i}`);
  }
  // Bright but only on a third of the screen
  const third = new GlareDetector();
  third.push(DARK, 0, 1);
  assert.equal(third.push(stats((x) => (x < 213 ? 255 : 30)), 250, 1), null);
  // The dark sample was on another monitor
  const moved = new GlareDetector();
  moved.push(DARK, 0, 1);
  assert.equal(moved.push(WHITE, 250, 2), null);
  // Asleep or dragged
  const blocked = new GlareDetector();
  blocked.push(DARK, 0, 1);
  assert.equal(blocked.push(WHITE, 250, 1, true), null);
});

test("the eye nearer to the light squints; straight ahead, the gaze decides", () => {
  assert.equal(nearSide(300, 0), 1);
  assert.equal(nearSide(-300, 5), -1);
  assert.equal(nearSide(10, -2), -1);
  assert.equal(nearSide(-10, 2), 1);
});

test("the squint: 70 ms down to 8% and 50%, a trembling hold, 500 ms to reopen; 60% while talking", () => {
  const random = () => 0;
  const play = startGlare(1000, 400, 0, false, random);
  assert.equal(play.side, 1);
  assert.equal(glareFrame(play, 999), null);
  const deepest = glareFrame(play, 1000 + SQUINT_MS)!;
  assert.ok(Math.abs(deepest.near - NEAR_MIN) <= 0.011 && Math.abs(deepest.far - FAR_MIN) <= 0.021);
  assert.equal(deepest.shift, 1);
  const end = glareEnd(play);
  assert.equal(end, 1000 + SQUINT_MS + 350 + REOPEN_MS);
  const reopening = glareFrame(play, end - REOPEN_MS / 2)!;
  assert.ok(reopening.near > NEAR_MIN && reopening.near < 1);
  assert.equal(glareFrame(play, end), null);
  assert.ok(play.blinks.length >= 1 && play.blinks[0] > end && play.blinks.at(-1)! < end + 600, "settling blinks within 600 ms");
  assert.ok(end + 600 - 1000 <= 1700, "about 1.6 s in all");

  const talking = startGlare(0, 400, 0, true, random);
  const soft = glareFrame(talking, SQUINT_MS)!;
  assert.ok(Math.abs(soft.near - (1 - (1 - NEAR_MIN) * SPEAKING_STRENGTH)) < 0.01, "a lighter squint while speaking");
});
