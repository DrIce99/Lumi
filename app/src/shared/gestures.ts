// Body gestures the brain can ask for with a sentence (say.gesture). The 3D
// avatar plays them from its clip library (renderer/avatar/clips.ts, or a
// user clip with the same name); the two eyes show only the few that make
// sense for them.
import type { FaceGesture } from "./types";

export const BODY_GESTURES = [
  "wave",
  "nod",
  "shake_head",
  "shrug",
  "think",
  "point",
  "bow",
  "cheer",
  "clap",
  "facepalm",
  "cross_arms",
  "tilt_head",
  "hop",
] as const;
export type BodyGesture = (typeof BODY_GESTURES)[number];

/** What each gesture means, for the prompt. */
export const GESTURE_HINT: Record<BodyGesture, string> = {
  wave: "greeting or goodbye",
  nod: "yes, agreement",
  shake_head: "no, disagreement",
  shrug: "who knows, never mind",
  think: "hand on the chin, pondering",
  point: "pointing at the screen beside you",
  bow: "thanks, a polite little bow",
  cheer: "arms up, celebrating",
  clap: "applause, well done",
  facepalm: "exasperation, an embarrassing mistake",
  cross_arms: "arms crossed: offended, unconvinced, waiting",
  tilt_head: "curious or puzzled",
  hop: "a happy little jump",
};

/** The eye gesture that stands for a body gesture in the minimal face (null: nothing). */
export const EYE_GESTURE: Partial<Record<string, FaceGesture>> = {
  nod: "nod",
  shake_head: "shake",
  cheer: "bounce",
  hop: "bounce",
  clap: "bounce",
};

/** A gesture name as written in a say call: lower case with underscores; null for none or garbage. */
export function gestureId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return /^[a-z0-9_]{2,40}$/.test(id) && id !== "none" ? id : null;
}

/** A clip file name ("Wave Hip Hop.fbx") -> a gesture name ("wave_hip_hop"), or null for other files. */
export function clipName(file: string): string | null {
  const m = /^(.+)\.(fbx|vrma)$/i.exec(file);
  if (!m) return null;
  const id = m[1]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return id || null;
}
