// Being dazzled: the eye nearer to the light squeezes shut, the other one
// half closes, the gaze slips away from the light; a trembling hold, a slow
// reopening, then one or two quick blinks to settle (~1.6 s in all). It is
// a layer over the expression; while Lumi talks it plays at 60%.
import { easeOutCubic, easeOutQuad } from "./tween";

export const SQUINT_MS = 70;
export const HOLD_MIN_MS = 350;
export const HOLD_MAX_MS = 600;
export const REOPEN_MS = 500;
/** The settling blinks happen within this time after reopening. */
export const SETTLE_MS = 600;
/** Height of the near and far eye at the deepest point (fraction of normal). */
export const NEAR_MIN = 0.08;
export const FAR_MIN = 0.5;
/** The gaze moves this far away from the light (px at scale 1). */
export const SHIFT_PX = 3;
/** Strength while speaking. */
export const SPEAKING_STRENGTH = 0.6;
/** Light closer than this to the face's vertical axis (DIP) is "straight ahead": the gaze decides the side. */
export const AHEAD_DIP = 40;

export interface GlarePlay {
  start: number;
  holdMs: number;
  /** The eye nearer to the light: -1 left, 1 right. */
  side: -1 | 1;
  /** 1 full, SPEAKING_STRENGTH while talking. */
  strength: number;
  seed: number;
  /** Times of the settling blinks still to come. */
  blinks: number[];
}

export interface GlareFrame {
  /** Height multipliers of the eye near the light and of the other one. */
  near: number;
  far: number;
  /** 0..1 of SHIFT_PX away from the light. */
  shift: number;
}

/** Which eye is nearer to the light: by the light's side, or the gaze's when the light is straight ahead. */
export function nearSide(lightDx: number, gazeX: number): -1 | 1 {
  if (Math.abs(lightDx) >= AHEAD_DIP) return lightDx > 0 ? 1 : -1;
  return gazeX < 0 ? -1 : 1;
}

export function startGlare(now: number, lightDx: number, gazeX: number, speaking: boolean, random: () => number): GlarePlay {
  const holdMs = HOLD_MIN_MS + random() * (HOLD_MAX_MS - HOLD_MIN_MS);
  const reopened = now + SQUINT_MS + holdMs + REOPEN_MS;
  const blinks = [reopened + 60 + random() * 120];
  if (random() < 0.5) blinks.push(blinks[0] + 230 + random() * 150);
  return { start: now, holdMs, side: nearSide(lightDx, gazeX), strength: speaking ? SPEAKING_STRENGTH : 1, seed: random() * 1000, blinks };
}

/** When the squint is over (the eyes are open again). */
export function glareEnd(play: GlarePlay): number {
  return play.start + SQUINT_MS + play.holdMs + REOPEN_MS;
}

/** The squint at `now`; null once the eyes are open again. */
export function glareFrame(play: GlarePlay, now: number): GlareFrame | null {
  const t = now - play.start;
  let near: number;
  let far: number;
  let shift: number;
  if (t < 0 || now >= glareEnd(play)) return null;
  if (t < SQUINT_MS) {
    const u = easeOutQuad(t / SQUINT_MS);
    near = 1 + (NEAR_MIN - 1) * u;
    far = 1 + (FAR_MIN - 1) * u;
    shift = u;
  } else if (t < SQUINT_MS + play.holdMs) {
    // A slight tremble while squeezing: ±1% near, ±2% far
    near = NEAR_MIN + 0.01 * Math.sin(t * 0.075 + play.seed);
    far = FAR_MIN + 0.02 * Math.sin(t * 0.061 + play.seed * 1.7);
    shift = 1;
  } else {
    const u = easeOutCubic((t - SQUINT_MS - play.holdMs) / REOPEN_MS);
    near = NEAR_MIN + (1 - NEAR_MIN) * u;
    far = FAR_MIN + (1 - FAR_MIN) * u;
    shift = 1 - u;
  }
  const k = play.strength;
  return { near: 1 - (1 - near) * k, far: 1 - (1 - far) * k, shift: shift * k };
}
