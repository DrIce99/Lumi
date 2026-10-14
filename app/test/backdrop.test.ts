// The backdrop behind the face: luminance bands, hysteresis, stale fallback, frame geometry.
import assert from "node:assert/strict";
import test from "node:test";
import {
  Backdrop,
  contrastFor,
  DARK_CONTRAST,
  LIGHT_CONTRAST,
  meanLuminance,
  MID_CONTRAST,
  rectInFrame,
  SAMPLE_MS,
  STALE_MS,
} from "../src/main/perception/backdrop";
import type { Frame } from "../src/main/perception/diff";

test("darker backdrops get a lighter outline, light ones a stronger one", () => {
  assert.deepEqual(contrastFor(0.1), DARK_CONTRAST);
  assert.deepEqual(contrastFor(0.5), MID_CONTRAST);
  assert.deepEqual(contrastFor(0.9), LIGHT_CONTRAST);
  assert.ok(DARK_CONTRAST.shadow < MID_CONTRAST.shadow && MID_CONTRAST.shadow < LIGHT_CONTRAST.shadow);
  assert.ok(DARK_CONTRAST.border < MID_CONTRAST.border && MID_CONTRAST.border < LIGHT_CONTRAST.border);
});

test("the face box is mapped into the frame of its display and clipped", () => {
  // A 2560x1440 DIP display at x=1920, captured at 640x360: 4 DIP per frame pixel
  const display = { x: 1920, y: 0, width: 2560, height: 1440 };
  const frame = { width: 640, height: 360 };
  assert.deepEqual(rectInFrame({ x: 1920 + 400, y: 200, width: 160, height: 120 }, display, frame), { x: 100, y: 50, width: 40, height: 30 });
  // Half off the left edge
  assert.deepEqual(rectInFrame({ x: 1920 - 80, y: 0, width: 160, height: 120 }, display, frame), { x: 0, y: 0, width: 20, height: 30 });
  // On another display
  assert.equal(rectInFrame({ x: 0, y: 0, width: 160, height: 120 }, display, frame), null);
});

test("mean luminance is read only inside the region", () => {
  const frame: Frame = { width: 8, height: 4, luma: new Uint8Array(32) };
  for (let y = 0; y < 4; y++) for (let x = 4; x < 8; x++) frame.luma[y * 8 + x] = 255;
  assert.equal(meanLuminance(frame, { x: 4, y: 0, width: 4, height: 4 }), 1);
  assert.equal(meanLuminance(frame, { x: 0, y: 0, width: 4, height: 4 }), 0);
  assert.equal(meanLuminance(frame, { x: 2, y: 1, width: 4, height: 2 }), 0.5);
});

test("a backdrop hovering on a band edge doesn't make the outline flicker", () => {
  const b = new Backdrop();
  let t = 0;
  b.sample(0.8, t);
  assert.deepEqual(b.contrast(t), LIGHT_CONTRAST);
  // Just under the edge: still light
  b.sample(0.74, (t += SAMPLE_MS));
  assert.deepEqual(b.contrast(t), LIGHT_CONTRAST);
  // Clearly under it: middle
  b.sample(0.7, (t += SAMPLE_MS));
  assert.deepEqual(b.contrast(t), MID_CONTRAST);
  // Just over the edge again: not enough to go back to light
  b.sample(0.76, (t += SAMPLE_MS));
  assert.deepEqual(b.contrast(t), MID_CONTRAST);
  b.sample(0.33, (t += SAMPLE_MS));
  assert.deepEqual(b.contrast(t), MID_CONTRAST);
  b.sample(0.2, (t += SAMPLE_MS));
  assert.deepEqual(b.contrast(t), DARK_CONTRAST);
  b.sample(0.37, (t += SAMPLE_MS));
  assert.deepEqual(b.contrast(t), DARK_CONTRAST);
});

test("samples are taken once a second and go stale without new frames", () => {
  const b = new Backdrop();
  assert.ok(b.wantsSample(0));
  assert.deepEqual(b.contrast(0), MID_CONTRAST, "nothing measured yet");
  b.sample(0.1, 0);
  assert.ok(!b.wantsSample(SAMPLE_MS - 1));
  assert.ok(b.wantsSample(SAMPLE_MS));
  assert.deepEqual(b.contrast(STALE_MS - 1), DARK_CONTRAST);
  assert.deepEqual(b.contrast(STALE_MS), MID_CONTRAST, "perception stopped: middle values");
  // After a gap the band is decided afresh, without hysteresis from the old one
  b.sample(0.36, STALE_MS * 3);
  assert.deepEqual(b.contrast(STALE_MS * 3), MID_CONTRAST);
});
