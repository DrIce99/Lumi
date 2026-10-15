// Leaving for the phone and coming back: the eyes are sucked into a point
// on the edge like into a black hole (spaghettification), and on the other
// side they come out of a point and recompose (the reverse). Each eye is a
// tube along a curved centerline: a list of circles, thinner toward the
// point, the near end running ahead of the far one like a tidal pull.
// Pure, tested: face.ts draws the circles on its eye layer.
//
// Out (1.1 s): alarm 150 ms (wide eyes leaning away), stretch 600 ms,
// suck-in 200 ms with a glint, 150 ms of nothing.
// In (1.2 s): glint 150 ms, strands emerge 450 ms, recompose 450 ms with an
// elastic overshoot, settle 150 ms (a blink).

export interface Point {
  x: number;
  y: number;
}

export interface EyeBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface TubePoint {
  x: number;
  y: number;
  r: number;
}

export type TransitKind = "out" | "in";

export interface TransitPlay {
  kind: TransitKind;
  start: number;
  /** The point on the edge (window DIP). */
  target: Point;
}

export interface TransitFrame {
  /** One tube per eye; null: draw the normal eyes (before the stretch, after recomposing). */
  tubes: TubePoint[][] | null;
  /** Nothing to draw (between leaving and arriving). */
  hidden: boolean;
  /** 0..1: the little light at the point. */
  glint: number;
  /** Offset of the normal eyes (the alarm's lean, away from the point). */
  lean: Point;
  /** Height multiplier of the normal eyes (wide open in the alarm). */
  wide: number;
  /** The play is over (out: Lumi is gone; in: Lumi is back). */
  done: boolean;
}

export const ALARM_MS = 150;
export const STRETCH_MS = 600;
export const SUCK_MS = 200;
export const EMPTY_MS = 150;
export const OUT_MS = ALARM_MS + STRETCH_MS + SUCK_MS + EMPTY_MS;
export const GLINT_MS = 150;
export const EMERGE_MS = 450;
export const RECOMPOSE_MS = 450;
export const SETTLE_MS = 150;
export const IN_MS = GLINT_MS + EMERGE_MS + RECOMPOSE_MS + SETTLE_MS;
const SAMPLES = 22;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** A capsule as a tube: its axis (the longer side) with half the shorter side as radius. */
export function capsuleTube(eye: EyeBox): { a: Point; b: Point; r: number } {
  const r = Math.min(eye.width, eye.height) / 2;
  const half = Math.max(eye.width, eye.height) / 2 - r;
  return eye.height >= eye.width
    ? { a: { x: eye.cx, y: eye.cy - half }, b: { x: eye.cx, y: eye.cy + half }, r }
    : { a: { x: eye.cx - half, y: eye.cy }, b: { x: eye.cx + half, y: eye.cy }, r };
}

/**
 * The tube of one eye at stretch `u` (0: the capsule, 1: a thin strand
 * reaching the point) and suck `v` (0..1: the far end follows into the
 * point). `side` bends the strands of the two eyes opposite ways (a slight
 * spiral).
 */
export function stretchedTube(eye: EyeBox, target: Point, u: number, v: number, side: -1 | 1): TubePoint[] {
  const { a, b, r } = capsuleTube(eye);
  const d = (p: Point) => Math.hypot(p.x - target.x, p.y - target.y);
  const near0 = d(a) <= d(b) ? a : b;
  const far0 = near0 === a ? b : a;
  // The near end runs ahead (tidal pull), the far one lags; the suck pulls the far end in
  const head = lerp(near0, target, clamp01(Math.pow(u, 1.4) * 0.92 + v * 0.08));
  const tailStretch = lerp(far0, target, Math.pow(u, 2.4) * 0.55);
  const tail = lerp(tailStretch, target, Math.pow(v, 1.4));
  const mid = lerp(tail, head, 0.5);
  const length = Math.hypot(head.x - tail.x, head.y - tail.y) || 1;
  const nx = -(head.y - tail.y) / length;
  const ny = (head.x - tail.x) / length;
  const bend = Math.sin(Math.PI * u) * length * 0.14 * side * (1 - v);
  const control = { x: mid.x + nx * bend, y: mid.y + ny * bend };
  const thin = (1 - 0.75 * u) * (1 - v);
  const out: TubePoint[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const s = i / SAMPLES;
    const x = (1 - s) * (1 - s) * tail.x + 2 * (1 - s) * s * control.x + s * s * head.x;
    const y = (1 - s) * (1 - s) * tail.y + 2 * (1 - s) * s * control.y + s * s * head.y;
    // Thinner toward the point
    out.push({ x, y, r: Math.max(0, r * thin * (1 - 0.55 * s * u)) });
  }
  return out;
}

function leanAway(eyes: EyeBox[], target: Point, amount: number): Point {
  const c = eyes.reduce((acc, e) => ({ x: acc.x + e.cx / eyes.length, y: acc.y + e.cy / eyes.length }), { x: 0, y: 0 });
  const dx = c.x - target.x;
  const dy = c.y - target.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (dx / len) * amount, y: (dy / len) * amount };
}

const NORMAL: Omit<TransitFrame, "done"> = { tubes: null, hidden: false, glint: 0, lean: { x: 0, y: 0 }, wide: 1 };

/** The transit at `now` for these eyes (window DIP). */
export function transitFrame(play: TransitPlay, now: number, eyes: EyeBox[]): TransitFrame {
  const t = now - play.start;
  const sides: (-1 | 1)[] = eyes.map((_, i) => (i === 0 ? -1 : 1));
  const tubes = (u: number, v: number) => eyes.map((e, i) => stretchedTube(e, play.target, u, v, sides[i]));
  const lean = (k: number) => leanAway(eyes, play.target, 3 * k);
  if (play.kind === "out") {
    if (t < 0) return { ...NORMAL, done: false };
    if (t < ALARM_MS) {
      const k = Math.sin((Math.PI / 2) * (t / ALARM_MS));
      return { ...NORMAL, lean: lean(k), wide: 1 + 0.15 * k, done: false };
    }
    if (t < ALARM_MS + STRETCH_MS) return { ...NORMAL, tubes: tubes((t - ALARM_MS) / STRETCH_MS, 0), done: false };
    if (t < ALARM_MS + STRETCH_MS + SUCK_MS) {
      const v = (t - ALARM_MS - STRETCH_MS) / SUCK_MS;
      return { ...NORMAL, tubes: tubes(1, v), glint: v, done: false };
    }
    if (t < OUT_MS) return { ...NORMAL, hidden: true, glint: 1 - (t - ALARM_MS - STRETCH_MS - SUCK_MS) / EMPTY_MS, done: false };
    return { ...NORMAL, hidden: true, done: true };
  }
  // In: the same path backwards, from the point to the eyes
  if (t < 0) return { ...NORMAL, hidden: true, done: false };
  if (t < GLINT_MS) return { ...NORMAL, hidden: true, glint: t / GLINT_MS, done: false };
  if (t < GLINT_MS + EMERGE_MS) {
    // Strands come out of the point: the reverse of the suck, then of the late stretch
    const p = (t - GLINT_MS) / EMERGE_MS;
    const v = Math.max(0, 1 - p * 2);
    const u = v > 0 ? 1 : 1 - (p - 0.5) * 0.9;
    return { ...NORMAL, tubes: tubes(u, v), glint: Math.max(0, 1 - p * 1.5), done: false };
  }
  if (t < GLINT_MS + EMERGE_MS + RECOMPOSE_MS) {
    const q = (t - GLINT_MS - EMERGE_MS) / RECOMPOSE_MS;
    const u = 0.55 * Math.pow(1 - q, 2);
    // An elastic overshoot: a little too round, then right
    const bounce = 1 + 0.18 * Math.sin(Math.PI * q) * (1 - q);
    return { ...NORMAL, tubes: tubes(u, 0).map((tube) => tube.map((p) => ({ ...p, r: p.r * bounce }))), done: false };
  }
  return { ...NORMAL, done: t >= IN_MS };
}
