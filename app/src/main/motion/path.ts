// How Lumi flies from one place to another: duration, easing, a small arc
// on long trips, and the character of each style. Pure, tested.
import type { Point } from "./places";

export const STYLES = ["fly", "dash", "sneak", "hop", "sulk"] as const;
export type MoveStyle = (typeof STYLES)[number];

/** 250 ms + distance / 2.5 px per ms, at most 1.2 s (before the style's factor). */
export function baseDuration(distance: number): number {
  return Math.min(1200, 250 + distance / 2.5);
}

const SPEED: Record<MoveStyle, number> = { fly: 1, dash: 0.55, sneak: 2.6, hop: 1.4, sulk: 1.9 };

export function flightMs(from: Point, to: Point, style: MoveStyle = "fly"): number {
  return Math.round(baseDuration(Math.hypot(to.x - from.x, to.y - from.y)) * SPEED[style]);
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** The anchor at progress `t` (0..1) of a flight. */
export function pathPoint(from: Point, to: Point, t: number, style: MoveStyle = "fly"): Point {
  const u = Math.min(1, Math.max(0, t));
  // A dash starts at once and brakes; the others ease in and out
  const e = style === "dash" ? 1 - (1 - u) ** 3 : style === "sneak" ? u : easeInOut(u);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  let x = from.x + dx * e;
  let y = from.y + dy * e;
  if (distance > 1) {
    // A gentle arc, upward-ish, on long trips (the normal to the path, toward the top)
    const arc = (style === "fly" ? Math.min(60, distance * 0.12) : style === "sulk" ? Math.min(20, distance * 0.04) : 0) * Math.sin(Math.PI * u);
    let nx = -dy / distance;
    let ny = dx / distance;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    x += nx * arc;
    y += ny * arc;
  }
  // Hops: three little jumps
  if (style === "hop") y -= Math.abs(Math.sin(Math.PI * 3 * u)) * Math.min(28, 8 + distance * 0.03);
  return { x: Math.round(x), y: Math.round(y) };
}

/** Speed 0..1 and direction at `t`, for the eyes' stretch while flying. */
export function velocityAt(from: Point, to: Point, t: number, style: MoveStyle = "fly"): { vx: number; vy: number } {
  const a = pathPoint(from, to, Math.max(0, t - 0.02), style);
  const b = pathPoint(from, to, Math.min(1, t + 0.02), style);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return { vx: 0, vy: 0 };
  // Normalized: a fast stretch of the path (40+ px in 4% of the time) is full speed
  const speed = Math.min(1, length / 40);
  return { vx: (dx / length) * speed, vy: (dy / length) * speed };
}
