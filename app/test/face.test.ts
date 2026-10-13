// The face's pure animation modules: tweens, blinking, gaze and expressions.
import assert from "node:assert/strict";
import test from "node:test";
import { EXPRESSIONS } from "../src/shared/emotions";
import { blinkCurve, blinkInterval, Blinker, CLOSE_MS, HOLD_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS, OPEN_MS } from "../src/renderer/face/blink";
import { EXPRESSION_DEFS, NEUTRAL_SHAPE, shapeFor, transitionMs } from "../src/renderer/face/expressions";
import { effectiveExpression } from "../src/renderer/face/face";
import { fixationMs, GazeController, gazeOffset, MAX_OFFSET_X, MAX_OFFSET_Y, saccadeMs, vergenceFor } from "../src/renderer/face/gaze";
import { easeInOutCubic, easeOutBack, Tween } from "../src/renderer/face/tween";
import { seeded, sequence } from "./helpers";

test("tweens ease from the current value to the target", () => {
  const t = new Tween(0);
  t.set(10, 100, 1000);
  assert.equal(t.value(1000), 0);
  assert.equal(t.value(1050), 5);
  assert.equal(t.value(1100), 10);
  assert.ok(t.active(1099));
  assert.ok(!t.active(1100));
  // Retargeting mid-way starts from where it is now
  t.set(0, 100, 1050);
  assert.equal(t.value(1050), 5);
  assert.equal(t.value(2000), 0);
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-9);
});

test("blink intervals are log-normal around 4 s, within 1.5-9 s", () => {
  const random = seeded(42);
  const samples = Array.from({ length: 4000 }, () => blinkInterval(random));
  assert.ok(samples.every((s) => s >= MIN_INTERVAL_MS && s <= MAX_INTERVAL_MS));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > 3500 && mean < 4500, `mean ${mean}`);
  // A higher rate means shorter waits
  assert.ok(blinkInterval(sequence(0.5, 0.5), 2) < blinkInterval(sequence(0.5, 0.5), 1));
});

test("a blink closes in 60 ms, holds 20 ms and reopens in 90 ms, down to 10% height", () => {
  assert.equal(blinkCurve(-1), 0);
  assert.equal(blinkCurve(0), 0);
  assert.equal(blinkCurve(CLOSE_MS), 1);
  assert.equal(blinkCurve(CLOSE_MS + HOLD_MS / 2), 1);
  assert.ok(blinkCurve(CLOSE_MS + HOLD_MS + OPEN_MS / 2) > 0);
  assert.equal(blinkCurve(CLOSE_MS + HOLD_MS + OPEN_MS), 0);
  // Drowsy blinks last longer
  assert.equal(blinkCurve(CLOSE_MS * 2, 2), 1);
});

test("blinker: spontaneous blinks, double blinks, triggers and pauses", () => {
  // random: interval sample, then "no double blink"
  const b = new Blinker(0, seeded(7));
  const first = b.nextEventAt();
  assert.ok(first >= MIN_INTERVAL_MS && first <= MAX_INTERVAL_MS);
  b.update(first - 1);
  assert.equal(b.closure(first - 1), 0);
  b.update(first);
  assert.ok(b.blinking(first + 10));
  assert.equal(b.closure(first + CLOSE_MS), 1);

  // A forced double blink: the next one follows within ~150 ms, and never a third
  const d = new Blinker(0, sequence(0.5, 0.5, 0.01, 0.5, 0.5, 0.01, 0.5, 0.5));
  assert.ok(d.trigger(100));
  const second = d.nextEventAt();
  assert.ok(second - 100 < CLOSE_MS + HOLD_MS + OPEN_MS + 160, `second at ${second}`);
  d.update(second);
  assert.ok(d.blinking(second + 5));
  assert.ok(d.nextEventAt() - second > MIN_INTERVAL_MS - 1, "no third blink");

  // Paused blinks (surprise) don't trigger
  const p = new Blinker(0, seeded(3));
  p.pause(5000);
  assert.equal(p.trigger(1000), false);
  assert.ok(p.nextEventAt() >= 5000);
  assert.equal(p.trigger(5001), true);
});

test("gaze offset saturates with tanh and keeps the direction", () => {
  assert.deepEqual(gazeOffset(0, 0), { x: 0, y: 0 });
  const far = gazeOffset(100_000, 0);
  assert.ok(Math.abs(far.x - MAX_OFFSET_X) < 1e-6 && far.y === 0);
  const down = gazeOffset(0, 100_000);
  assert.ok(Math.abs(down.y - MAX_OFFSET_Y) < 1e-6);
  const near = gazeOffset(50, 50);
  assert.ok(near.x > 0 && near.x < MAX_OFFSET_X / 2);
  assert.ok(Math.abs(near.x / near.y - MAX_OFFSET_X / MAX_OFFSET_Y) < 1e-9);
  assert.equal(vergenceFor(1000), 0);
  assert.ok(vergenceFor(20) > vergenceFor(100));
  assert.equal(saccadeMs(0), 30);
  assert.equal(saccadeMs(100), 60);
  const random = seeded(1);
  for (let i = 0; i < 50; i++) {
    const f = fixationMs("text", random);
    assert.ok(f >= 250 && f <= 800);
  }
  assert.equal(fixationMs("reading", random), 120);
});

test("gaze: saccades, fixations, urgent targets and pursuit", () => {
  const g = new GazeController(0, seeded(5));
  g.setCommand({ target: { dx: 400, dy: 0 }, kind: "change", pursuit: false }, 0);
  assert.ok(g.active(10));
  const settled = g.output(100);
  assert.ok(settled.x > 5, `x ${settled.x}`);
  // During the fixation a lower-priority target waits...
  g.setCommand({ target: { dx: -400, dy: 0 }, kind: "mouse", pursuit: false }, 120);
  assert.ok(g.output(150).x > 5);
  // ...and runs once the fixation is over
  g.update(2000);
  assert.ok(g.output(2100).x < -5);
  // Urgent kinds cut the fixation short
  g.setCommand({ target: { dx: 0, dy: 400 }, kind: "caret", pursuit: false }, 2110);
  assert.ok(g.output(2200).y > 4);
  // Pursuit follows the target with a short lag
  g.setCommand({ target: { dx: 200, dy: 0 }, kind: "mouse", pursuit: true }, 3000);
  g.update(3200);
  const chased = g.output(3200);
  assert.ok(chased.x > 3);
});

test("gaze: large jumps trigger a blink, expressions bias and avert the eyes", () => {
  const g = new GazeController(0, seeded(9));
  let blinks = 0;
  g.onLargeSaccade = () => blinks++;
  g.setCommand({ target: { dx: -500, dy: 0 }, kind: "caret", pursuit: false }, 0);
  g.setCommand({ target: { dx: 500, dy: 0 }, kind: "caret", pursuit: false }, 1000);
  assert.equal(blinks, 1);
  // Thinking: up and to the right, whatever the target
  g.setStyle({ bias: { x: 0.75, y: -0.75 }, avert: false, saccadeRate: 0.35 }, 2000);
  const thinking = g.output(2200);
  assert.ok(thinking.x > 5 && thinking.y < -4);
  // Embarrassment: away from the target
  g.setStyle({ bias: null, avert: true, saccadeRate: 1 }, 3000);
  g.setCommand({ target: { dx: 300, dy: 0 }, kind: "caret", pursuit: false }, 3000);
  assert.ok(g.output(3200).x < 0);
});

test("expressions: every expression is defined and intensity scales the change", () => {
  for (const e of EXPRESSIONS) assert.ok(EXPRESSION_DEFS[e], e);
  assert.deepEqual(shapeFor("neutra", 1), NEUTRAL_SHAPE);
  const full = shapeFor("sorpresa", 1);
  const mild = shapeFor("sorpresa", 0);
  assert.ok(Math.abs(full.height - 1.2) < 1e-9 && Math.abs(full.width - 1.1) < 1e-9);
  assert.ok(mild.height > 1 && mild.height < full.height);
  assert.ok(shapeFor("tristezza", 1).tilt > 0, "sad eyes lean outward");
  assert.ok(shapeFor("rabbia", 1).tilt < 0, "angry eyes lean inward");
  assert.ok(Math.abs(shapeFor("sonno", 1).lid - 0.5) < 1e-9, "sleepy: half closed");
  const ms = transitionMs(NEUTRAL_SHAPE, full);
  assert.ok(ms >= 150 && ms <= 300);
  assert.equal(transitionMs(NEUTRAL_SHAPE, NEUTRAL_SHAPE), 150);
});

test("the conversation state wins over the emotion on the face", () => {
  const base = { expression: "gioia" as const, intensity: 1, listening: false, thinking: false, speaking: false, drowsy: false };
  assert.equal(effectiveExpression(base), "gioia");
  assert.equal(effectiveExpression({ ...base, listening: true }), "ascolto");
  assert.equal(effectiveExpression({ ...base, thinking: true, listening: true }), "pensiero");
  assert.equal(effectiveExpression({ ...base, expression: "neutra", drowsy: true }), "sonno");
});
