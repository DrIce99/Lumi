// What the face window's renderer drives: the two eyes (face/face.ts) or the
// 3D avatar (avatar/avatar.ts, loaded on demand). Both get the same state,
// gaze, speech level and gestures; main.ts swaps them when the mode changes.
import type { FaceContrast, FaceGesture, FaceLayout, FaceState, GazeCommand } from "../shared/types";

export interface FaceView {
  setLayout(layout: FaceLayout): void;
  setState(state: FaceState): void;
  setGaze(command: GazeCommand): void;
  setContrast(contrast: FaceContrast): void;
  gesture(kind: FaceGesture): void;
  glare(lightDx: number): void;
  travel(vx: number, vy: number, landed: boolean): void;
  transit(kind: "out" | "in", target: { x: number; y: number }, alreadyMs?: number): number;
  resetTransit(): void;
  sentenceStart(): void;
  sentenceEnd(): void;
  setLevelSource(source: (() => number) | null): void;
  setTalking(talking: boolean): void;
  hitTest(x: number, y: number, margin?: number): boolean;
  dispose(): void;
}
