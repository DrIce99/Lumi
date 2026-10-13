// Geometry of the face window: where the window goes for a given face
// position, and where the face sits inside it. Pure, tested.
import { FACE_HEIGHT, FACE_WIDTH, type FaceLayout } from "../shared/types";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room for the bubble and the chat box beside the face (DIP). */
export const OVERLAY_HEIGHT = 300;
export const MIN_WINDOW_WIDTH = 400;

/** Window bounds and face layout for a face whose top-left corner is at `anchor` (screen DIP). */
export function computeLayout(anchor: Point, scale: number, color: string, workArea: Rect): { bounds: Rect; layout: FaceLayout } {
  const faceW = Math.round(FACE_WIDTH * scale);
  const faceH = Math.round(FACE_HEIGHT * scale);
  const width = Math.max(faceW + 40, MIN_WINDOW_WIDTH);
  const height = faceH + OVERLAY_HEIGHT;
  // Bubbles go above the eyes, or below them when the face is near the top of the screen
  const overlay = anchor.y - OVERLAY_HEIGHT >= workArea.y ? "above" : "below";
  // Keep the whole window on screen horizontally when possible; the face moves inside it
  const x = Math.round(Math.min(Math.max(anchor.x - (width - faceW) / 2, workArea.x), workArea.x + workArea.width - width));
  const y = Math.round(overlay === "above" ? anchor.y - OVERLAY_HEIGHT : anchor.y);
  return {
    bounds: { x, y, width, height },
    layout: {
      scale,
      color,
      face: { x: Math.round(anchor.x - x), y: overlay === "above" ? OVERLAY_HEIGHT : 0, width: faceW, height: faceH },
      windowWidth: width,
      windowHeight: height,
      overlay,
    },
  };
}

/** Keeps most of the face inside the work area. */
export function clampAnchor(anchor: Point, scale: number, area: Rect): Point {
  const faceW = FACE_WIDTH * scale;
  const faceH = FACE_HEIGHT * scale;
  return {
    x: Math.round(Math.min(Math.max(anchor.x, area.x - faceW * 0.3), area.x + area.width - faceW * 0.7)),
    y: Math.round(Math.min(Math.max(anchor.y, area.y - faceH * 0.3), area.y + area.height - faceH * 0.7)),
  };
}
