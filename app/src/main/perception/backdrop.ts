// What is behind the face, to keep the eyes readable on any background:
// the brighter the backdrop (close to the eye color), the stronger the
// dark shadow and border under the eyes. Content protection hides Lumi's
// window from captures, so the change detector's frames of Lumi's monitor
// show exactly what is behind it; we sample them once a second.
import type { FaceContrast } from "../../shared/types";
import type { Frame } from "./diff";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Shadow and border opacity per backdrop luminance band. */
export const DARK_CONTRAST: FaceContrast = { shadow: 0.2, border: 0.1 };
export const MID_CONTRAST: FaceContrast = { shadow: 0.3, border: 0.18 };
export const LIGHT_CONTRAST: FaceContrast = { shadow: 0.45, border: 0.3 };
/** Band edges (mean luminance 0..1). */
export const DARK_BELOW = 0.35;
export const LIGHT_ABOVE = 0.75;
/** A band is left only this far past its edge, so a backdrop near an edge doesn't flicker. */
const HYSTERESIS = 0.03;
/** One sample per second is plenty: the result is eased over 400 ms anyway. */
export const SAMPLE_MS = 1000;
/** Without a fresh sample (perception paused or off) fall back to the middle values. */
export const STALE_MS = 3000;

type Band = "dark" | "mid" | "light";

const CONTRAST: Record<Band, FaceContrast> = { dark: DARK_CONTRAST, mid: MID_CONTRAST, light: LIGHT_CONTRAST };

/** The band for a luminance, with no history. */
export function bandFor(luminance: number): Band {
  if (luminance < DARK_BELOW) return "dark";
  if (luminance > LIGHT_ABOVE) return "light";
  return "mid";
}

export function contrastFor(luminance: number): FaceContrast {
  return CONTRAST[bandFor(luminance)];
}

/**
 * Where a screen rectangle (DIP) falls in a frame of a display (frame
 * pixels), clipped to the frame; null when they don't overlap.
 */
export function rectInFrame(rect: Rect, display: Rect, frame: { width: number; height: number }): Rect | null {
  const sx = frame.width / display.width;
  const sy = frame.height / display.height;
  const x0 = Math.max(0, Math.floor((rect.x - display.x) * sx));
  const y0 = Math.max(0, Math.floor((rect.y - display.y) * sy));
  const x1 = Math.min(frame.width, Math.ceil((rect.x + rect.width - display.x) * sx));
  const y1 = Math.min(frame.height, Math.ceil((rect.y + rect.height - display.y) * sy));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Mean luminance (0..1) of a region of a frame (frame pixels). */
export function meanLuminance(frame: Frame, region: Rect): number {
  let sum = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    const row = y * frame.width;
    for (let x = region.x; x < region.x + region.width; x++) sum += frame.luma[row + x];
  }
  return sum / (region.width * region.height * 255);
}

/** Turns luminance samples into the contrast the face should use, with hysteresis and a stale fallback. */
export class Backdrop {
  private band: Band = "mid";
  private sampledAt = Number.NEGATIVE_INFINITY;

  /** Whether a new sample is due. */
  wantsSample(now: number): boolean {
    return now - this.sampledAt >= SAMPLE_MS;
  }

  sample(luminance: number, now: number): void {
    // Without a recent sample the band starts over, without history
    const fresh = now - this.sampledAt < STALE_MS;
    this.sampledAt = now;
    if (!fresh) {
      this.band = bandFor(luminance);
      return;
    }
    const enterDark = DARK_BELOW - (this.band === "dark" ? -HYSTERESIS : HYSTERESIS);
    const enterLight = LIGHT_ABOVE + (this.band === "light" ? -HYSTERESIS : HYSTERESIS);
    if (luminance < enterDark) this.band = "dark";
    else if (luminance > enterLight) this.band = "light";
    else this.band = "mid";
  }

  contrast(now: number): FaceContrast {
    return now - this.sampledAt < STALE_MS ? CONTRAST[this.band] : MID_CONTRAST;
  }
}
