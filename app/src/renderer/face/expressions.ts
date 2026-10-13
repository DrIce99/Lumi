// Expressions made only with the shape of the eyes. Each expression is a
// target parameter set; the face eases toward it (150-300 ms), so there is
// no per-frame logic here.
import type { Expression } from "../../shared/emotions";
import type { FaceGesture } from "../../shared/types";

export interface EyeShape {
  /** Multiplier of the base eye width. */
  width: number;
  /** Multiplier of the base eye height. */
  height: number;
  /** Vertical shift in px at scale 1 (positive = down). */
  y: number;
  /** Degrees; positive leans the tops outward (sad), negative inward (angry). */
  tilt: number;
  /** Extra distance between the eyes, px at scale 1. */
  spread: number;
  /** Resting lid closure, 0..1 (drowsy). */
  lid: number;
  /** Height change of the right eye only (thinking: one eye smaller). */
  asym: number;
}

export interface ExpressionDef {
  shape: EyeShape;
  /** Where the eyes go regardless of the attention target, -1..1 per axis (null: follow the target). */
  gazeBias: { x: number; y: number } | null;
  /** The gaze escapes sideways from its target (embarrassment). */
  avert: boolean;
  /** Multiplies the spontaneous blink rate. */
  blinkRate: number;
  /** Multiplies how often the eyes wander and micro-move. */
  saccadeRate: number;
  /** Played once when the expression starts. */
  onset?: FaceGesture;
  /** No blinking for this long after the expression starts. */
  blinkPauseMs?: number;
}

export const NEUTRAL_SHAPE: EyeShape = { width: 1, height: 1, y: 0, tilt: 0, spread: 0, lid: 0, asym: 0 };

const def = (shape: Partial<EyeShape>, rest: Partial<Omit<ExpressionDef, "shape">> = {}): ExpressionDef => ({
  shape: { ...NEUTRAL_SHAPE, ...shape },
  gazeBias: null,
  avert: false,
  blinkRate: 1,
  saccadeRate: 1,
  ...rest,
});

export const EXPRESSION_DEFS: Record<Expression, ExpressionDef> = {
  neutra: def({}),
  gioia: def({ width: 1.16, height: 0.76, y: 3 }, { onset: "bounce", blinkRate: 1.1 }),
  tristezza: def({ width: 0.94, height: 0.8, y: 5, tilt: 11 }, { gazeBias: { x: 0, y: 0.75 }, blinkRate: 0.8, saccadeRate: 0.5 }),
  sorpresa: def({ width: 1.1, height: 1.2, y: -2 }, { blinkPauseMs: 1400, saccadeRate: 0.4 }),
  rabbia: def({ width: 0.84, height: 0.86, y: 1, tilt: -11, spread: -1.5 }, { saccadeRate: 0.7 }),
  pensiero: def({ height: 0.97, asym: -0.14 }, { gazeBias: { x: 0.75, y: -0.75 }, saccadeRate: 0.35 }),
  imbarazzo: def({ width: 0.95, height: 0.88, y: 2 }, { avert: true, onset: "tremble", blinkRate: 1.4 }),
  sonno: def({ height: 0.94, y: 2, lid: 0.5 }, { blinkRate: 0.45, saccadeRate: 0.3 }),
  ascolto: def({ height: 1.06, y: -1 }, { saccadeRate: 0.25 }),
};

/**
 * The shape for an expression at a given intensity (0..1): the deviation
 * from neutral is scaled, so a mild emotion is a hint of the full one.
 */
export function shapeFor(expression: Expression, intensity: number): EyeShape {
  const target = EXPRESSION_DEFS[expression].shape;
  if (expression === "neutra") return { ...target };
  const k = 0.35 + 0.65 * Math.min(1, Math.max(0, intensity));
  const out = { ...NEUTRAL_SHAPE };
  for (const key of Object.keys(out) as (keyof EyeShape)[]) {
    out[key] = NEUTRAL_SHAPE[key] + (target[key] - NEUTRAL_SHAPE[key]) * k;
  }
  return out;
}

/** Transition time between expressions (150-300 ms): bigger changes take longer. */
export function transitionMs(from: EyeShape, to: EyeShape): number {
  const change =
    Math.abs(from.width - to.width) +
    Math.abs(from.height - to.height) +
    Math.abs(from.y - to.y) / 10 +
    Math.abs(from.tilt - to.tilt) / 20 +
    Math.abs(from.lid - to.lid);
  return Math.round(150 + Math.min(1, change / 0.6) * 150);
}
