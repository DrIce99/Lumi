// How each expression looks on the 3D avatar: weights of the VRM preset
// expressions (happy, angry, sad, relaxed, surprised) plus a posture (head,
// spine, shoulders), a resting eyelid and how lively the idle motion is.
// Targets only: avatar.ts eases toward them, like the eyes' expressions.
import type { Expression } from "../../shared/emotions";

export const VRM_EMOTIONS = ["happy", "angry", "sad", "relaxed", "surprised"] as const;
export type VrmEmotion = (typeof VRM_EMOTIONS)[number];

export interface AvatarExpression {
  faces: Partial<Record<VrmEmotion, number>>;
  /** Head offset in degrees, as the head bone's Euler XYZ (pose.ts): pitch (+ = down), yaw (+ = toward the viewer's right), roll. */
  head: [number, number, number];
  /** Spine lean, degrees (+ = forward). */
  lean: number;
  /** Shoulders up (+) or dropped (-), degrees. */
  shoulders: number;
  /** Resting eyelid closure, 0..1. */
  lid: number;
  /** Idle motion: 1 normal, < 1 calmer, > 1 livelier. */
  energy: number;
  /** A steady tremble, 0..1. */
  tremble?: number;
}

const E = (faces: AvatarExpression["faces"], head: AvatarExpression["head"], rest: Partial<Omit<AvatarExpression, "faces" | "head">> = {}): AvatarExpression => ({
  faces,
  head,
  lean: 0,
  shoulders: 0,
  lid: 0,
  energy: 1,
  ...rest,
});

export const AVATAR_EXPRESSIONS: Record<Expression, AvatarExpression> = {
  neutra: E({}, [0, 0, 0]),
  gioia: E({ happy: 1 }, [-4, 0, 3], { energy: 1.35, shoulders: 1 }),
  tristezza: E({ sad: 1 }, [11, 0, -2], { lean: 4, shoulders: -4, energy: 0.6 }),
  sorpresa: E({ surprised: 1 }, [-5, 0, 0], { lean: -4, shoulders: 5, energy: 1.2 }),
  rabbia: E({ angry: 1 }, [6, 0, 0], { lean: 4, shoulders: 2, energy: 1.1 }),
  pensiero: E({ relaxed: 0.3 }, [-7, 6, 8], { energy: 0.8 }),
  imbarazzo: E({ happy: 0.45, sad: 0.25 }, [9, -5, -7], { shoulders: 3, lid: 0.15 }),
  sonno: E({ relaxed: 0.6 }, [12, 0, 7], { lid: 0.55, shoulders: -3, energy: 0.4 }),
  saccente: E({ relaxed: 0.5 }, [-7, 0, 0], { lean: -2, energy: 0.9 }),
  sospetto: E({ angry: 0.35 }, [3, -8, -7], { lid: 0.4, energy: 0.7 }),
  paura: E({ surprised: 0.6, sad: 0.5 }, [5, 0, 0], { shoulders: 7, lean: -3, energy: 0.9, tremble: 1 }),
  spavento: E({ surprised: 1 }, [-4, 0, 0], { shoulders: 10, lean: -7, energy: 1.2, tremble: 0.4 }),
  smorfia: E({ angry: 0.6 }, [5, 0, 5], { lid: 0.7, shoulders: 4 }),
  apatia: E({ relaxed: 0.25 }, [2, 0, 5], { lid: 0.45, shoulders: -2, energy: 0.3 }),
  ascolto: E({ happy: 0.12 }, [3, 0, 7], { lean: 2, energy: 0.9 }),
};

/** The expression at an intensity (0..1): faces and posture scale, a strong one up to full. */
export function avatarExpression(expression: Expression, intensity: number): AvatarExpression {
  const def = AVATAR_EXPRESSIONS[expression] ?? AVATAR_EXPRESSIONS.neutra;
  // 0.6 is the usual intensity: it gives about 80% of the full look
  const k = Math.min(1, Math.max(0.15, 0.35 + 0.75 * intensity));
  const faces: AvatarExpression["faces"] = {};
  for (const [name, w] of Object.entries(def.faces) as [VrmEmotion, number][]) faces[name] = Math.min(1, w * k);
  return {
    faces,
    head: [def.head[0] * k, def.head[1] * k, def.head[2] * k],
    lean: def.lean * k,
    shoulders: def.shoulders * k,
    lid: def.lid * k,
    energy: 1 + (def.energy - 1) * k,
    ...(def.tremble ? { tremble: def.tremble * k } : {}),
  };
}

/** Mouth shapes for the lip sync. */
export const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
export type Viseme = (typeof VISEMES)[number];

/**
 * Mouth shapes from the voice: `level` (0..1, already smoothed) opens the
 * mouth, `bright` (share of the energy above ~1.5 kHz, 0..1) picks the vowel:
 * bright sounds are e/i, dark ones o/u, the middle a. `t` (ms) makes the
 * shape wander a little, so a long vowel doesn't freeze the mouth.
 */
export function visemes(level: number, bright: number, t: number): Record<Viseme, number> {
  const open = Math.min(1, Math.max(0, level));
  const out: Record<Viseme, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  if (open < 0.02) return out;
  const wobble = 0.5 + 0.5 * Math.sin(t / 97) * Math.sin(t / 211);
  const b = Math.min(1, Math.max(0, bright));
  if (b > 0.5) {
    const e = (b - 0.5) / 0.5;
    out.ee = open * (0.35 + 0.4 * e) * (0.7 + 0.3 * wobble);
    out.ih = open * 0.35 * (1 - wobble * 0.5);
    out.aa = open * 0.35 * (1 - e);
  } else if (b < 0.25) {
    const d = (0.25 - b) / 0.25;
    out.oh = open * (0.45 + 0.25 * wobble);
    out.ou = open * 0.45 * d * (1 - wobble * 0.4);
    out.aa = open * 0.25 * (1 - d);
  } else {
    out.aa = open * (0.75 + 0.25 * wobble);
    out.oh = open * 0.25 * (1 - wobble);
  }
  return out;
}
