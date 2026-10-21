// How the 3D avatar is framed: a half-length shot, and where idle routines
// take the camera (the whole body, the screen's edge as a desk, the eyes up
// close). Pure, tested.

/**
 * The bust's vertical span for a model `height` m tall: from a little above
 * the hips (the waist) to just above the top of the hair. Without a usable
 * hips bone, the upper 42% of the model.
 */
export function bustSpan(height: number, hipsY: number | null): { bottom: number; top: number } {
  const top = height + 0.03;
  const bottom = hipsY !== null && hipsY > height * 0.3 && hipsY < height * 0.75 ? hipsY + 0.06 : height * 0.58;
  return { bottom, top };
}

/**
 * A camera looking straight at -Z from (x, y, d) toward (x, y, 0), with
 * vertical `fov` degrees over the face box. The face box's center shows the
 * point (x, y); the window around it shows more (setViewOffset).
 */
export interface CameraParams {
  x: number;
  y: number;
  d: number;
  fov: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The distance at which `scale` px per meter fill a face box `boxHeight` px tall. */
function distanceFor(scale: number, boxHeight: number, fov: number): number {
  return boxHeight / (scale * 2 * Math.tan((fov * Math.PI) / 360));
}

/**
 * The whole body in the window's free region: as large as fits (never larger
 * than the bust shot), centered, standing (or lying) on the region's bottom.
 * `body` is the world box of its bones (m), `region` the window area (px).
 */
export function bodyFraming(
  body: { minX: number; maxX: number; minY: number; maxY: number },
  region: { left: number; right: number; top: number; bottom: number },
  face: Box,
  bustScale: number,
  fov: number,
): CameraParams {
  const s = Math.min((region.right - region.left) / Math.max(0.1, body.maxX - body.minX), (region.bottom - region.top) / Math.max(0.1, body.maxY - body.minY), bustScale);
  const fcx = face.x + face.width / 2;
  const fcy = face.y + face.height / 2;
  return {
    x: (body.minX + body.maxX) / 2 - ((region.left + region.right) / 2 - fcx) / s,
    y: body.minY + (region.bottom - fcy) / s,
    d: distanceFor(s, face.height, fov),
    fov,
  };
}

/** The forearms' height (m) on the window's bottom edge (`bottomPx`): the screen's edge is her desk. Bust scale, the head centered. */
export function deskFraming(deskY: number, headX: number, bottomPx: number, face: Box, bustScale: number, fov: number): CameraParams {
  return { x: headX, y: deskY + (bottomPx - (face.y + face.height / 2)) / bustScale, d: distanceFor(bustScale, face.height, fov), fov };
}

/**
 * How close the close-up gets to the eye (m), how wide the lens opens
 * (degrees: the wide-angle meme), and the near clip (m): VRoid fringes hang
 * a few centimeters in front of the eyes, closer to the lens than the eye,
 * so the near plane cuts them away. It comes from a little below, under the
 * fringe (`rise`: the approach tilted up).
 */
export const CLOSEUP = { distance: 0.09, fov: 95, near: 0.01, rise: 0.1 };

/**
 * The camera between its usual shot (k = 0) and the eye up close (k = 1):
 * it moves toward the eye while the lens widens, so the face bulges.
 * `forward`: where the face looks (world), the side the camera comes from.
 */
export function closeupBlend(
  p: CameraParams,
  eye: [number, number, number] | null,
  k: number,
  forward: [number, number, number] = [0, 0, 1],
): { position: [number, number, number]; look: [number, number, number]; fov: number } {
  const base: [number, number, number] = [p.x, p.y, p.d];
  const look: [number, number, number] = [p.x, p.y, 0];
  if (!eye || k <= 0) return { position: base, look, fov: p.fov };
  const e = Math.min(1, k) ** 2 * (3 - 2 * Math.min(1, k));
  // In front of the eye along the way the face looks (she leans and tilts her head: the world's +Z went through it)
  const dir = [forward[0], forward[1] - CLOSEUP.rise, forward[2]];
  const n = Math.hypot(...dir) || 1;
  const near: [number, number, number] = [0, 1, 2].map((i) => eye[i] + (dir[i] / n) * CLOSEUP.distance) as [number, number, number];
  const mix = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * e) as [number, number, number];
  return { position: mix(base, near), look: mix(look, eye), fov: p.fov + (CLOSEUP.fov - p.fov) * e };
}

/**
 * How much the routine's own face (closed eyes, open mouth) shows in each
 * part: it settles in over the loop's first 0.8 s, fades over the exit's
 * first 0.5 s, and is gone at once when she wakes with a start.
 */
export function routineFace(phase: "enter" | "loop" | "exit" | "done", msInPhase: number, startled: boolean): number {
  if (phase === "loop") return Math.min(1, Math.max(0, msInPhase) / 800);
  if (phase === "exit" && !startled) return Math.max(0, 1 - Math.max(0, msInPhase) / 500);
  return 0;
}
