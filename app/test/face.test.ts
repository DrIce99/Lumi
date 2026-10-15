// The face's pure animation modules: tweens, blinking, gaze and expressions.
import assert from "node:assert/strict";
import test from "node:test";
import { EXPRESSIONS } from "../src/shared/emotions";
import { blinkCurve, blinkInterval, Blinker, CLOSE_MS, HOLD_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS, OPEN_MS } from "../src/renderer/face/blink";
import { EXPRESSION_DEFS, NEUTRAL_SHAPE, shapeFor, transitionMs } from "../src/renderer/face/expressions";
import { effectiveExpression } from "../src/renderer/face/face";
import { fixationMs, GazeController, gazeOffset, MAX_OFFSET_X, MAX_OFFSET_Y, saccadeMs, vergenceFor } from "../src/renderer/face/gaze";
import { chevronPoints, glasses, GLASSES_PUSH_MS, glassesPush, motionAt, ringGeometry, shockLines, squintLines, STILL } from "../src/renderer/face/glyphs";
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
  assert.ok(Math.abs(full.height - 1.28) < 1e-9 && Math.abs(full.width - 1.14) < 1e-9);
  assert.ok(mild.height > 1 && mild.height < full.height);
  assert.ok(shapeFor("tristezza", 1).tilt > 0, "sad eyes lean outward");
  assert.ok(shapeFor("rabbia", 1).tilt < 0, "angry eyes lean inward");
  assert.ok(Math.abs(shapeFor("sonno", 1).lidTop - 0.52) < 1e-9, "sleepy: lids half down");
  assert.ok(shapeFor("rabbia", 1).lidAngle > 0 && shapeFor("rabbia", 1).lidTop > 0, "angry lids drop toward the nose");
  assert.ok(shapeFor("tristezza", 1).lidAngle < 0 && shapeFor("tristezza", 1).lidTop > 0, "sad lids drop outward");
  assert.ok(shapeFor("gioia", 1).cheek > 0 && shapeFor("gioia", 1).lidTop === 0, "happy: cut from below");
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

test("new expressions: glyphs and lines keep their full shape, the props and motions they bring", () => {
  for (const e of ["sospetto", "paura", "spavento", "smorfia", "apatia"] as const) {
    assert.deepEqual(shapeFor(e, 0.1), EXPRESSION_DEFS[e].shape, `${e} is never "a bit" of itself`);
  }
  assert.ok(shapeFor("saccente", 0.1).lidTop < EXPRESSION_DEFS.saccente.shape.lidTop, "a capsule expression still scales");
  assert.equal(EXPRESSION_DEFS.paura.glyph, "ring");
  assert.ok((EXPRESSION_DEFS.paura.pupil ?? 0) > 0 && !EXPRESSION_DEFS.spavento.pupil, "fear has tiny pupils, shock none");
  assert.deepEqual(EXPRESSION_DEFS.saccente.accessories, ["glasses"]);
  assert.equal(EXPRESSION_DEFS.saccente.onset, "glassesPush");
  assert.equal(EXPRESSION_DEFS.spavento.onset, "freeze");
  assert.ok(EXPRESSION_DEFS.apatia.still && EXPRESSION_DEFS.apatia.noBlink);
  // A line is wider than tall: "_ _"
  assert.ok(EXPRESSION_DEFS.apatia.shape.width * 14 > EXPRESSION_DEFS.apatia.shape.height * 44 * 3);
});

test("glyphs: > < chevrons point to the nose, rings hold a small pupil", () => {
  const [a, b, c] = chevronPoints(16, 20, -1);
  assert.deepEqual([a.x, b.x, c.x], [-8, 8, -8], "left eye: >");
  assert.deepEqual(chevronPoints(16, 20, 1)[1], { x: -8, y: 0 }, "right eye: <");
  const ring = ringGeometry(28, 28, 0.18, 1);
  assert.equal(ring.rx, 12.4);
  assert.ok(ring.pupil > 1 && ring.pupil < 3);
  assert.equal(ringGeometry(28, 28, 0, 1).pupil, 0);
});

test("glasses sit on the face; the finger rises, pushes them up and leaves", () => {
  const g = glasses({ x: 100, y: 100 }, { x: 136, y: 100 }, 1, 0);
  assert.ok(g.lenses[0].x < 100 - 7 && g.lenses[0].x + g.lenses[0].width > 100 + 7, "the lens wraps the eye");
  assert.equal(glasses({ x: 100, y: 100 }, { x: 136, y: 100 }, 1, 4).lenses[0].y, g.lenses[0].y - 4, "lift raises them");
  assert.equal(glassesPush(-1, 1).finger, null);
  const start = glassesPush(0, 1);
  const contact = glassesPush(500, 1);
  const held = glassesPush(700, 1);
  assert.ok(start.finger && contact.finger && start.finger.y > contact.finger.y, "the finger comes up");
  assert.equal(start.lift, 0);
  assert.equal(held.lift, 4, "pushed up");
  const after = glassesPush(GLASSES_PUSH_MS + 10, 1);
  assert.equal(after.finger, null, "the finger is gone");
  assert.equal(after.lift, 2, "the glasses stay a little higher");
});

test("doubt and shock lines; tremble, pulse and reading motions", () => {
  const [above, below] = squintLines({ cx: 50, cy: 50, width: 16, height: 10 }, 1);
  // The lines touch the slit (their stroke overlaps its edges): one piece, no gap
  assert.ok(above[0].y > 45 - 2.6 / 2 && above[0].y < 45 + 2.6 / 2, "top line on the slit's top edge");
  assert.ok(below[0].y > 55 - 2.6 / 2 && below[0].y < 55 + 2.6 / 2, "bottom line on the slit's bottom edge");
  assert.ok(above[0].x < 42 && above[1].x > 58, "a little longer than the slit");
  const shock = shockLines({ cx: 50, cy: 50, width: 28, height: 28 }, 1);
  assert.equal(shock.length, 3);
  assert.ok(shock.every(([a, b]) => a.x > 64 && a.y < b.y && b.y <= 34), "top right of the right eye, slanted");
  assert.deepEqual(motionAt(null, 123, 0), STILL);
  for (let t = 0; t < 2000; t += 37) {
    const m = motionAt("tremble", t, 1);
    assert.ok(Math.abs(m.dx) <= 0.85 && Math.abs(m.dy) <= 0.7, "a light tremble");
    const p = motionAt("pulse", t, 1);
    assert.ok(p.sy >= 0.8 && p.sy <= 1 && p.sx >= 0.9);
    const r = motionAt("reading", t, 0);
    assert.ok(r.gazeX >= -0.6 && r.gazeX <= 0.6);
  }
  assert.ok(motionAt("reading", 1500, 0).gazeX > motionAt("reading", 200, 0).gazeX, "reading goes left to right");
  assert.equal(motionAt("tremble", 50, 1, 0), STILL, "no strength, no motion");
});

test("expressions without blinks resume them after; still eyes don't move on their own", () => {
  const blinker = new Blinker(0, () => 0.5);
  blinker.pause(3_600_000);
  assert.ok(blinker.nextEventAt() >= 3_600_000);
  blinker.resume(1000);
  assert.ok(blinker.nextEventAt() < 2000);
  const gaze = new GazeController(0, () => 0.5);
  gaze.setStyle({ bias: { x: 0, y: 0.2 }, avert: false, saccadeRate: 1, still: true }, 0);
  for (let t = 0; t < 30_000; t += 250) gaze.update(t);
  assert.equal(gaze.active(30_000), false);
  assert.equal(gaze.nextEventAt(), Number.POSITIVE_INFINITY);
});
