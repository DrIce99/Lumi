// Idle routines: when they start and stop (the director), where a walk and
// the desk take the window, routine.json as the app reads it, and how the
// camera frames them.
import assert from "node:assert/strict";
import test from "node:test";
import { parseRoutine } from "../src/main/avatar";
import { AFTER_BACK_MS, deskSpot, GAP_MS, IdleDirector, LOOP_MS, walkTarget, type IdleChoice, type IdleConditions } from "../src/main/idle";
import { bodyFraming, CLOSEUP, closeupBlend, deskFraming, routineFace } from "../src/renderer/avatar/framing";

const MIN = 60_000;
const choice = (name: string, extra: Partial<IdleChoice> = {}): IdleChoice => ({ name, wanders: false, sleeps: false, seconds: { enter: 4, loop: 8, exit: 3 }, ...extra });
const ok: IdleConditions = { enabled: true, free: true, away: false, mayWander: true, afterMs: 2 * MIN };
/** A fixed sequence of "random" numbers. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test("a routine starts only after the quiet time, when Lumi is free and the setting is on", () => {
  const d = new IdleDirector(0, seq(0));
  const all = [choice("read"), choice("ledge")];
  assert.equal(d.tick(MIN, all, ok), null);
  assert.equal(d.tick(3 * MIN, all, { ...ok, free: false }), null);
  assert.equal(d.tick(3 * MIN, all, { ...ok, enabled: false }), null);
  assert.equal(d.tick(3 * MIN, [], ok), null);
  const plan = d.tick(3 * MIN, all, ok);
  assert.equal(plan?.kind, "start");
  assert.equal(plan?.kind === "start" && plan.loopMs, LOOP_MS.min);
  assert.equal(d.current(), "read");
  // Only one at a time
  assert.equal(d.tick(3 * MIN + 500, all, ok), null);
});

test("an interaction ends the routine; startled only when woken from the loop of a sleeping one", () => {
  const d = new IdleDirector(0, seq(0));
  const sleep = [choice("sleep", { sleeps: true })];
  d.tick(3 * MIN, sleep, ok);
  // Still lying down (the enter): no start
  assert.deepEqual(d.interaction(3 * MIN + 1000), { kind: "stop", name: "sleep", startled: false });
  assert.equal(d.current(), null);
  // The quiet time starts again from the interaction, and then the pause between routines
  assert.equal(d.tick(3 * MIN + 2000, sleep, ok), null);
  const again = 3 * MIN + 1000 + Math.max(3000 + GAP_MS.min, 2 * MIN) + 1;
  assert.equal(d.tick(again, sleep, ok)?.kind, "start");
  assert.deepEqual(d.interaction(again + 5000), { kind: "stop", name: "sleep", startled: true });
  // Nothing playing: an interaction only resets the quiet time
  assert.equal(d.interaction(again + 6000), null);
});

test("the loop ends by itself, then a pause; the last routines are not repeated when there is a choice", () => {
  const d = new IdleDirector(0, seq(0));
  const all = [choice("read"), choice("ledge"), choice("peek")];
  let now = 3 * MIN;
  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    const plan = d.tick(now, all, ok);
    assert.equal(plan?.kind, "start");
    if (plan?.kind === "start") names.push(plan.name);
    now += 4000 + LOOP_MS.min;
    assert.deepEqual(d.tick(now, all, ok), { kind: "stop", name: names[i], startled: false });
    now += 3000 + GAP_MS.min + 1;
  }
  assert.deepEqual(names, ["read", "ledge", "peek", "read"]);
});

test("routines that move the window need movement on Lumi's own initiative", () => {
  const d = new IdleDirector(0, seq(0));
  const all = [choice("walk", { wanders: true }), choice("desk", { wanders: true })];
  assert.equal(d.tick(3 * MIN, all, { ...ok, mayWander: false }), null);
  assert.equal(d.tick(3 * MIN, [...all, choice("read")], { ...ok, mayWander: false })?.kind, "start");
  assert.equal(d.current(), "read");
});

test("while the user is away she falls asleep at once and sleeps until a little after they are back", () => {
  const d = new IdleDirector(0, seq(0));
  const all = [choice("read"), choice("sleep", { sleeps: true }), choice("walk", { wanders: true, sleeps: true })];
  const plan = d.tick(1000, all, { ...ok, away: true });
  assert.deepEqual(plan, { kind: "start", name: "sleep", loopMs: Infinity });
  assert.equal(d.tick(5 * 60 * MIN, all, { ...ok, away: true }), null);
  // Back: she sleeps on a little, then gets up by herself (calmly)
  assert.equal(d.tick(5 * 60 * MIN + 1000, all, ok), null);
  assert.deepEqual(d.tick(5 * 60 * MIN + 1000 + AFTER_BACK_MS, all, ok), { kind: "stop", name: "sleep", startled: false });
  // Nothing that sleeps: nothing while away
  assert.equal(new IdleDirector(0, seq(0)).tick(1000, [choice("read")], { ...ok, away: true }), null);
});

test("turning the setting off or deleting the routine stops it", () => {
  const d = new IdleDirector(0, seq(0));
  d.tick(3 * MIN, [choice("read")], ok);
  assert.equal(d.tick(3 * MIN + 500, [choice("read")], { ...ok, enabled: false })?.kind, "stop");
  d.tick(3 * MIN + 10 * MIN, [choice("read")], ok);
  assert.equal(d.tick(3 * MIN + 10 * MIN + 500, [choice("ledge")], ok)?.kind, "stop");
});

test("a walk paces about her place and never leaves the screen", () => {
  const area = { x: 0, width: 1920 };
  // At home: to the side with more room, at least 120 px
  const a = walkTarget({ x: 400, y: 800 }, { x: 400, y: 800 }, 180, area, () => 0)!;
  assert.equal(a.dir, 1);
  assert.equal(a.target.x, 520);
  assert.equal(a.target.y, 800);
  // Away from home: back toward it
  const b = walkTarget({ x: 650, y: 800 }, { x: 400, y: 800 }, 180, area, () => 0.5)!;
  assert.deepEqual(b, { target: { x: 400, y: 800 }, dir: -1 });
  // Near the right edge: to the left, within the screen
  const c = walkTarget({ x: 1720, y: 800 }, { x: 1720, y: 800 }, 180, area, () => 1)!;
  assert.equal(c.dir, -1);
  assert.ok(c.target.x >= 1720 - 280 && c.target.x + 180 <= 1920);
  // No room
  assert.equal(walkTarget({ x: 0, y: 0 }, null, 180, { x: 0, width: 250 }), null);
});

test("the desk puts the face's bottom on the screen's bottom edge", () => {
  assert.deepEqual(deskSpot({ x: 300, y: 500 }, 220, { y: 0, height: 1040 }), { x: 300, y: 820 });
});

test("routine.json: defaults, limits, and only known values", () => {
  const url = (part: string) => `app://lumi/user/animations/idle/x/${part}.vrma`;
  const r = parseRoutine("Sleep Well", { camera: "body", face: { eyes: "closed", mouth: 2 }, wake: "spaventata", seconds: { enter: 5, loop: 7.87, exit: 2.5 } }, url)!;
  assert.equal(r.name, "sleep_well");
  assert.equal(r.camera, "body");
  assert.deepEqual(r.face, { eyes: "closed", mouth: 1 });
  assert.equal(r.loop, url("loop"));
  assert.equal(r.walkSpeed, null);
  assert.equal(r.prop, null);
  assert.deepEqual(r.seconds, { enter: 5, loop: 7.87, exit: 2.5 });
  const w = parseRoutine("walk", { walk: true, walkSpeed: 0.86, camera: "zoom", prop: "sword", wake: "boh" }, url)!;
  assert.equal(w.walkSpeed, 0.86);
  assert.equal(w.camera, "bust");
  assert.equal(w.prop, null);
  assert.equal(w.wake, null);
  const bare = parseRoutine("read", "not json", url)!;
  assert.deepEqual(bare.face, { eyes: "open", mouth: 0 });
  assert.equal(parseRoutine("...", {}, url), null);
});

test("the body framing fits the body in the free region, standing on its bottom, never bigger than the bust", () => {
  const face = { x: 117, y: 187, width: 180, height: 220 };
  const region = { left: 10, right: 404, top: 10, bottom: 407 };
  const fov = 18;
  // Lying along X, 1.8 m: the width decides
  const lying = { minX: -0.9, maxX: 0.9, minY: 0, maxY: 0.45 };
  const p = bodyFraming(lying, region, face, 290, fov);
  const s = face.height / (2 * p.d * Math.tan((fov * Math.PI) / 360));
  assert.ok(Math.abs(s - 394 / 1.8) < 1e-6);
  // Its bottom on the region's bottom, its center in the region's center
  const px = (X: number) => face.x + face.width / 2 + (X - p.x) * s;
  const py = (Y: number) => face.y + face.height / 2 - (Y - p.y) * s;
  assert.ok(Math.abs(py(0) - 407) < 1e-6);
  assert.ok(Math.abs(px(0) - 207) < 1e-6);
  // A small body is not blown up past the bust shot
  const q = bodyFraming({ minX: -0.2, maxX: 0.2, minY: 0, maxY: 0.4 }, region, face, 290, fov);
  assert.ok(Math.abs(face.height / (2 * q.d * Math.tan((fov * Math.PI) / 360)) - 290) < 1e-6);
});

test("the desk framing puts the forearms on the window's bottom edge at the bust's scale", () => {
  const face = { x: 117, y: 187, width: 180, height: 220 };
  const p = deskFraming(0.7, 0.05, 404, face, 290, 18);
  const s = face.height / (2 * p.d * Math.tan((18 * Math.PI) / 360));
  assert.ok(Math.abs(s - 290) < 1e-6);
  assert.ok(Math.abs(face.y + face.height / 2 - (0.7 - p.y) * s - 404) < 1e-6);
  assert.equal(p.x, 0.05);
});

test("the close-up goes from the usual shot to just in front of the eye, along the face's direction, widening", () => {
  const p = { x: 0, y: 1.3, d: 3, fov: 18 };
  assert.deepEqual(closeupBlend(p, [0.03, 1.45, 0.08], 0), { position: [0, 1.3, 3], look: [0, 1.3, 0], fov: 18 });
  // Looking straight ahead: in front of the eye, coming a little from below (under the fringe)
  const full = closeupBlend(p, [0.03, 1.45, 0.08], 1, [0, 0, 1]);
  const n = Math.hypot(CLOSEUP.rise, 1);
  assert.deepEqual(
    full.position.map((v) => Math.round(v * 1e6) / 1e6),
    [0.03, 1.45 - (CLOSEUP.rise / n) * CLOSEUP.distance, 0.08 + CLOSEUP.distance / n].map((v) => Math.round(v * 1e6) / 1e6),
  );
  assert.deepEqual(full.look, [0.03, 1.45, 0.08]);
  assert.equal(full.fov, CLOSEUP.fov);
  // Halfway in time is halfway eased (smoothstep), not linear
  assert.equal(closeupBlend(p, [0, 0, 0], 0.5).fov, 18 + (CLOSEUP.fov - 18) * 0.5);
  assert.equal(closeupBlend(p, null, 1).fov, 18);
});

test("the routine's own face settles in the loop and is gone when she wakes with a start", () => {
  assert.equal(routineFace("enter", 3000, false), 0);
  assert.equal(routineFace("loop", 400, false), 0.5);
  assert.equal(routineFace("loop", 5000, false), 1);
  assert.equal(routineFace("exit", 250, false), 0.5);
  assert.equal(routineFace("exit", 0, true), 0);
  assert.equal(routineFace("done", 0, false), 0);
});

test("due() is the cheap check: quiet long enough, past the pause, nothing playing", () => {
  const d = new IdleDirector(0, seq(0));
  assert.equal(d.due(MIN, 2 * MIN, false), false);
  assert.equal(d.due(MIN, 2 * MIN, true), true);
  assert.equal(d.due(3 * MIN, 2 * MIN, false), true);
  d.tick(3 * MIN, [choice("read")], ok);
  assert.equal(d.due(4 * MIN, 2 * MIN, false), false);
  d.interaction(4 * MIN);
  assert.equal(d.due(4 * MIN + 60_000, 2 * MIN, true), false); // in the pause, even with the user away
  assert.equal(d.due(4 * MIN + 3000 + GAP_MS.min + 1 + 2 * MIN, 2 * MIN, false), true);
});
