// Moving around the screen: named places, flight paths, the rules for
// moves on Lumi's own initiative, and the mover (tool, stay, stop, dodge).
import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { Mover, type MoverFace, type MoverHost } from "../src/main/motion/mover";
import { baseDuration, flightMs, pathPoint, velocityAt } from "../src/main/motion/path";
import { beside, gridPlace, intersects, MARGIN, outOfTheWay, placeAnchor, rectOf, type PlaceContext, type Point } from "../src/main/motion/places";
import { checkMove, INITIATIVE_EVERY_MS, PRANK_COVER_S, type MoveCheck } from "../src/main/motion/rules";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";

muteConsole();

const size = { width: 160, height: 120 };
const left = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

function ctx(over: Partial<PlaceContext> = {}): PlaceContext {
  return { size, anchor: { x: 1700, y: 880 }, areas: [left, right], home: { x: 1700, y: 880 }, mouse: { x: 500, y: 500 }, avoid: [], ...over };
}

// ---------------- places ----------------

test("the nine places sit MARGIN inside the work area of the current display", () => {
  assert.deepEqual(gridPlace("top_left", size, left), { x: MARGIN, y: MARGIN });
  assert.deepEqual(gridPlace("bottom_right", size, left), { x: 1920 - 160 - MARGIN, y: 1040 - 120 - MARGIN });
  assert.deepEqual(gridPlace("center", size, left), { x: 880, y: 460 });
  assert.deepEqual(placeAnchor("top_right", ctx({ anchor: { x: 2500, y: 600 } })), { x: 1920 + 2560 - 160 - MARGIN, y: MARGIN }, "on the display the face is on");
});

test("other screen keeps the relative place; home, near the mouse, next to text", () => {
  const other = placeAnchor("other_screen", ctx())!;
  assert.ok(other.x > 1920 + 2000 && other.y > 1100, "bottom right there too");
  assert.equal(placeAnchor("other_screen", ctx({ areas: [left] })), null);
  assert.deepEqual(placeAnchor("home", ctx({ anchor: { x: 100, y: 100 } })), { x: 1700, y: 880 });
  assert.equal(placeAnchor("home", ctx({ home: null })), null);
  const nearMouse = placeAnchor("near_mouse", ctx())!;
  assert.ok(!intersects(rectOf(nearMouse, size), { x: 492, y: 492, width: 16, height: 16 }), "never on the pointer");
  const text = { x: 600, y: 300, width: 200, height: 20 };
  const next = placeAnchor("near_text", ctx({ target: text }))!;
  assert.ok(!intersects(rectOf(next, size), text), "beside the text, not on it");
  assert.ok(next.x >= 800, "on its right when there is room");
  assert.ok(!intersects(rectOf(beside({ x: 1800, y: 300, width: 100, height: 20 }, size, left), size), { x: 1800, y: 300, width: 100, height: 20 }), "on its left near the edge");
  assert.equal(placeAnchor("near_text", ctx()), null, "no text, no place");
});

test("out of the way: the nearest free place, not where it is, never on what must stay visible", () => {
  const here = { x: 880, y: 460 };
  const caret = { x: 900, y: 500, width: 2, height: 18 };
  const spot = outOfTheWay(ctx({ anchor: here, avoid: [caret] }));
  assert.ok(Math.hypot(spot.x - here.x, spot.y - here.y) > 160, "it moved");
  assert.ok(!intersects(rectOf(spot, size), caret));
});

// ---------------- paths ----------------

test("flights: 250 ms + distance / 2.5, at most 1.2 s, styles faster or slower", () => {
  assert.equal(baseDuration(0), 250);
  assert.equal(baseDuration(1000), 650);
  assert.equal(baseDuration(5000), 1200);
  const a = { x: 0, y: 500 };
  const b = { x: 1000, y: 500 };
  assert.ok(flightMs(a, b, "dash") < flightMs(a, b) && flightMs(a, b) < flightMs(a, b, "sneak"));
  assert.deepEqual(pathPoint(a, b, 0), a);
  assert.deepEqual(pathPoint(a, b, 1), b);
  assert.ok(pathPoint(a, b, 0.5).y < 500, "a small arc upward on a long trip");
  assert.ok(pathPoint(a, b, 0.5, "dash").x > 500, "a dash brakes: past the middle at half time");
  let lowest = 500;
  for (let t = 0; t <= 1; t += 0.05) lowest = Math.min(lowest, pathPoint(a, b, t, "hop").y);
  assert.ok(lowest < 480, "hops jump");
  const v = velocityAt(a, b, 0.5);
  assert.ok(v.vx > 0.5 && Math.abs(v.vy) < 0.5, "flying right, fast in the middle");
  assert.deepEqual(velocityAt(a, a, 0.5), { vx: 0, vy: 0 });
});

// ---------------- rules ----------------

function check(over: Partial<MoveCheck> = {}): MoveCheck {
  return {
    where: "top_right",
    style: "fly",
    stay: 0,
    requested: false,
    answering: false,
    settings: { enabled: true, initiative: true, pranks: true },
    sociability: "normale",
    now: 1_000_000,
    lastInitiative: Number.NEGATIVE_INFINITY,
    stillUntil: 0,
    held: null,
    busy: null,
    coversWork: false,
    typing: false,
    ...over,
  };
}

test("rules: what the user asks goes; initiative has limits", () => {
  assert.deepEqual(checkMove(check({ requested: true, busy: "the user is in a call", lastInitiative: 999_999 })), { ok: true, stay: 0, counts: false });
  assert.equal(checkMove(check({ requested: true, held: "the user is holding you" })).ok, false);
  assert.equal(checkMove(check({ requested: true, settings: { enabled: false, initiative: true, pranks: true } })).ok, false);
  assert.deepEqual(checkMove(check()), { ok: true, stay: 0, counts: true });
  assert.equal(checkMove(check({ settings: { enabled: true, initiative: false, pranks: true } })).ok, false);
  assert.equal(checkMove(check({ busy: "the user doesn't want to be disturbed" })).ok, false);
  assert.equal(checkMove(check({ stillUntil: 2_000_000 })).ok, false, "after \"basta\"");
  assert.equal(checkMove(check({ lastInitiative: 1_000_000 - INITIATIVE_EVERY_MS + 1 })).ok, false, "one every 2 minutes");
  assert.deepEqual(checkMove(check({ where: "near_text", answering: true, lastInitiative: 999_000 })), { ok: true, stay: 0, counts: false }, "pointing during an answer is free");
  assert.equal(checkMove(check({ style: "sulk", settings: { enabled: true, initiative: true, pranks: false } })).ok, false);
  assert.equal(checkMove(check({ style: "hop", sociability: "silenzioso" })).ok, false);
  assert.equal(checkMove(check({ coversWork: true, typing: true })).ok, false, "never over what the user types");
  assert.deepEqual(checkMove(check({ coversWork: true, stay: 120 })), { ok: true, stay: PRANK_COVER_S, counts: true }, "covering the work spot: 10 s at most");
});

// ---------------- the mover ----------------

function fakeFace(start: Point): MoverFace & { flights: { to: Point; style: string }[]; dragging: boolean } {
  let anchor = { ...start };
  const face = {
    flights: [] as { to: Point; style: string }[],
    dragging: false,
    flyTo: (to: Point, style: string, done?: (arrived: boolean) => void) => {
      face.flights.push({ to, style });
      anchor = { ...to };
      done?.(true);
    },
    isMoving: () => false,
    isDragging: () => face.dragging,
    getAnchor: () => anchor,
    faceSize: () => size,
  };
  return face;
}

function mover(over: Partial<MoverHost> = {}, settings: Settings = DEFAULT_SETTINGS) {
  let now = 10_000_000;
  const face = fakeFace({ x: 1700, y: 880 });
  const looks: Point[] = [];
  const host: MoverHost = {
    settings: () => settings,
    face,
    areas: () => [left, right],
    cursor: () => ({ x: 300, y: 300 }),
    home: () => ({ x: 1700, y: 880 }),
    locate: (text) => (text === "Salva" ? { x: 400, y: 600, width: 60, height: 24 } : null),
    caret: () => null,
    typingWindow: () => null,
    busy: () => null,
    answering: () => false,
    lookAt: (p) => looks.push(p),
    now: () => now,
    ...over,
  };
  return { m: new Mover(host), face, looks, tick: (ms: number) => (now += ms) };
}

test("mover: asked moves fly with the eyes on the way; text, refusals and the mood line", async () => {
  const { m, face, looks } = mover();
  assert.match(await m.move({ where: "top_left" }, true), /Flying to the top left corner/);
  assert.deepEqual(face.flights[0].to, { x: MARGIN, y: MARGIN });
  assert.equal(looks.length, 1, "the eyes look where it goes");
  assert.match(m.status(), /top left corner, not your usual place/);
  assert.match(await m.move({ where: "near_text", text: "Annulla" }, true), /not among the text/);
  assert.equal(face.flights.length, 1);
  assert.match(await m.move({ where: "near_text", text: "Salva" }, true), /next to that text/);
  await m.move({ where: "home" }, true);
  assert.equal(m.status(), "", "home and calm");
});

test("mover: stay brings it back, sulk is a mood until home, stop keeps it still for an hour", async () => {
  const { m, face, tick } = mover();
  await m.move({ where: "bottom_left", stay: 1 }, true);
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(face.flights.at(-1)?.to, { x: 1700, y: 880 }, "back home after the stay");
  tick(5 * 60_000);
  assert.match(await m.move({ where: "top_left", style: "sulk" }, false), /Flying/);
  assert.match(m.status(), /sulk/);
  await m.move({ where: "home" }, true);
  assert.doesNotMatch(m.status(), /sulk/);
  await m.move({ where: "stop" }, true);
  assert.match(m.status(), /not to move on your own until/);
  tick(10 * 60_000);
  assert.match(await m.move({ where: "top" }, false), /stay still/);
  assert.match(await m.move({ where: "top" }, true), /Flying/, "the user can still ask");
});

test("mover: the text cursor under the face for 2 s sends it out of the way, once in a while", () => {
  let caret: { x: number; y: number; width: number; height: number } | null = { x: 1750, y: 900, width: 2, height: 18 };
  const { m, face, tick } = mover({ caret: () => caret });
  m.dodgeTick();
  tick(1000);
  m.dodgeTick();
  assert.equal(face.flights.length, 0, "not at once");
  tick(1200);
  m.dodgeTick();
  assert.equal(face.flights.length, 1);
  assert.ok(!intersects(rectOf(face.flights[0].to, size), caret));
  caret = null;
  m.dodgeTick();
  assert.equal(face.flights.length, 1);
});

test("the move_to tool: places, styles, stay, stop", () => {
  assert.deepEqual(parseToolCall("move_to", { where: "Top_Right", style: "hop", stay: 12.4 }), { name: "move_to", where: "top_right", style: "hop", stay: 12 });
  assert.deepEqual(parseToolCall("move_to", { where: "stop" }), { name: "move_to", where: "stop" });
  assert.deepEqual(parseToolCall("move_to", { where: "near_text", text: "Salva" }), { name: "move_to", where: "near_text", text: "Salva" });
  assert.equal(parseToolCall("move_to", { where: "near_text" }), null, "near_text needs the text");
  assert.equal(parseToolCall("move_to", { where: "roof" }), null);
  assert.deepEqual(parseToolCall("move_to", { where: "left", style: "moonwalk" }), { name: "move_to", where: "left" });
});

test("near text: a screen that never changed is read when the text isn't known; a refusal says it did NOT move", async () => {
  let reads = 0;
  const { m, face } = mover({
    locate: async (text) => {
      reads++;
      // Not among what was read lately: the screen is read now
      return text === "Source Control" ? { x: 40, y: 700, width: 90, height: 18 } : null;
    },
  });
  assert.match(await m.move({ where: "near_text", text: "Source Control" }, true), /^Flying to next to that text/);
  assert.equal(face.flights.length, 1);
  assert.equal(reads, 1);
  const refused = await m.move({ where: "near_text", text: "icona del commit" }, true);
  assert.match(refused, /^You did NOT move: .*look_at_screen first/);
  assert.match(refused, /correct yourself now/);
  assert.equal(face.flights.length, 1, "no flight");
});
