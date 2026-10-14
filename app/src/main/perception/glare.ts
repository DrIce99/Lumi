// Glare: the watched screen jumps from mostly dark to mostly bright (a white
// page opened from a dark editor) and Lumi gets dazzled. Works on a 64x36
// thumbnail of the change detector's luminance frames (no extra capture),
// in linear light. The frames carry gamma-encoded luma (sidecar/screen.py),
// so linearizing the luma approximates Rec. 709 luminance on linearized RGB:
// exact for greys, close enough for these thresholds on real pages.
import type { Frame } from "./diff";

export const THUMB_W = 64;
export const THUMB_H = 36;
/** Mean linear luminance before (at most) and after (at least) the jump. */
export const DARK_BELOW = 0.25;
export const BRIGHT_ABOVE = 0.55;
/** A pixel counts as bright above this linear luminance... */
export const BRIGHT_PIXEL = 0.6;
/** ...and at least this share of the screen must be bright. */
export const BRIGHT_SHARE = 0.6;
/** The jump must happen within this time: slower fades let the eye adapt. */
export const JUMP_MS = 500;
export const COOLDOWN_MS = 20_000;

/** sRGB decoding (IEC 61966-2-1), 8-bit value -> linear 0..1. */
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export function linearize(value8: number): number {
  return LINEAR[Math.max(0, Math.min(255, Math.round(value8)))];
}

/** A THUMB_W x THUMB_H thumbnail of linear luminance, each cell the mean of its block of the frame. */
export function thumbnail(frame: Frame): Float32Array {
  const out = new Float32Array(THUMB_W * THUMB_H);
  for (let ty = 0; ty < THUMB_H; ty++) {
    const y0 = Math.floor((ty * frame.height) / THUMB_H);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * frame.height) / THUMB_H));
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x0 = Math.floor((tx * frame.width) / THUMB_W);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * frame.width) / THUMB_W));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * frame.width;
        for (let x = x0; x < x1; x++) sum += LINEAR[frame.luma[row + x]];
      }
      out[ty * THUMB_W + tx] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

export interface GlareStats {
  /** Mean linear luminance, 0..1. */
  mean: number;
  /** Share of bright pixels, 0..1. */
  bright: number;
  /** Centroid of the bright pixels, 0..1 across the display; null when none. */
  centroid: { x: number; y: number } | null;
}

export function glareStats(thumb: Float32Array): GlareStats {
  let sum = 0;
  let count = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < thumb.length; i++) {
    sum += thumb[i];
    if (thumb[i] > BRIGHT_PIXEL) {
      count++;
      cx += (i % THUMB_W) + 0.5;
      cy += Math.floor(i / THUMB_W) + 0.5;
    }
  }
  return {
    mean: sum / thumb.length,
    bright: count / thumb.length,
    centroid: count ? { x: cx / count / THUMB_W, y: cy / count / THUMB_H } : null,
  };
}

export interface GlareEvent {
  /** Where the light is, 0..1 across the watched display. */
  centroid: { x: number; y: number };
}

/** Watches the stats of one display over time and fires on a sudden dark-to-bright jump. */
export class GlareDetector {
  private history: { t: number; mean: number }[] = [];
  private displayId: number | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  /**
   * One sample of the watched display. `blocked`: Lumi is asleep or being
   * dragged, so nothing fires (the history still follows the screen).
   */
  push(stats: GlareStats, t: number, displayId: number, blocked = false): GlareEvent | null {
    // Another monitor is watched: its brightness says nothing about a jump
    if (displayId !== this.displayId) {
      this.displayId = displayId;
      this.history = [];
    }
    const wasDark = this.history.some((s) => t - s.t <= JUMP_MS && s.mean < DARK_BELOW);
    this.history = this.history.filter((s) => t - s.t <= JUMP_MS);
    this.history.push({ t, mean: stats.mean });
    if (blocked || !wasDark || t - this.lastAt < COOLDOWN_MS) return null;
    if (stats.mean <= BRIGHT_ABOVE || stats.bright <= BRIGHT_SHARE || !stats.centroid) return null;
    this.lastAt = t;
    return { centroid: stats.centroid };
  }
}
