// Screen change detection on low-resolution captures: the frame is split
// into 32x32 blocks, blocks whose pixels changed are merged into
// rectangles. Regions that keep changing (a video, an animation) lose
// interest over time. Pure, tested.

export interface Frame {
  width: number;
  height: number;
  /** One luminance byte per pixel. */
  luma: Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BLOCK = 32;
/** A pixel counts as changed when its luminance moves by more than this. */
const PIXEL_DELTA = 18;
/** A block changed when at least this fraction of its pixels changed. */
const BLOCK_FRACTION = 0.015;

/** Luminance of a BGRA bitmap (what Electron's NativeImage.toBitmap gives on Windows). */
export function lumaFromBgra(bgra: Uint8Array, width: number, height: number): Frame {
  const luma = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = (bgra[p + 2] * 77 + bgra[p + 1] * 150 + bgra[p] * 29) >> 8;
  }
  return { width, height, luma };
}

/** Which blocks changed between two frames of the same size (row-major grid). */
export function changedBlocks(prev: Frame, next: Frame, block = BLOCK): { cols: number; rows: number; changed: Uint8Array } {
  const cols = Math.ceil(next.width / block);
  const rows = Math.ceil(next.height / block);
  const changed = new Uint8Array(cols * rows);
  if (prev.width !== next.width || prev.height !== next.height) {
    changed.fill(1);
    return { cols, rows, changed };
  }
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * block;
      const y0 = by * block;
      const x1 = Math.min(next.width, x0 + block);
      const y1 = Math.min(next.height, y0 + block);
      let count = 0;
      const needed = Math.max(1, Math.ceil((x1 - x0) * (y1 - y0) * BLOCK_FRACTION));
      outer: for (let y = y0; y < y1; y++) {
        const row = y * next.width;
        for (let x = x0; x < x1; x++) {
          if (Math.abs(next.luma[row + x] - prev.luma[row + x]) > PIXEL_DELTA && ++count >= needed) break outer;
        }
      }
      if (count >= needed) changed[by * cols + bx] = 1;
    }
  }
  return { cols, rows, changed };
}

/** Groups changed blocks into rectangles (8-connected), in frame pixels. */
export function mergeBlocks(grid: { cols: number; rows: number; changed: Uint8Array }, width: number, height: number, block = BLOCK): Box[] {
  const { cols, rows, changed } = grid;
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  for (let i = 0; i < changed.length; i++) {
    if (!changed[i] || seen[i]) continue;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % cols;
      const y = Math.floor(j / cols);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const k = ny * cols + nx;
          if (changed[k] && !seen[k]) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    const x = minX * block;
    const y = minY * block;
    boxes.push({ x, y, width: Math.min(width, (maxX + 1) * block) - x, height: Math.min(height, (maxY + 1) * block) - y });
  }
  return boxes;
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function area(b: Box): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

/**
 * Remembers which parts of the screen keep changing: a region that changed
 * in many recent frames (video, animation, a spinner) gets less salient.
 */
export class Habituation {
  private heat: Float32Array = new Float32Array(0);
  private cols = 0;

  /** Updates the per-block heat with this frame's changes and returns salience multipliers per box. */
  update(grid: { cols: number; rows: number; changed: Uint8Array }, boxes: Box[], block = BLOCK): number[] {
    if (this.heat.length !== grid.changed.length) {
      this.heat = new Float32Array(grid.changed.length);
      this.cols = grid.cols;
    }
    for (let i = 0; i < this.heat.length; i++) this.heat[i] = this.heat[i] * 0.85 + (grid.changed[i] ? 1 : 0);
    return boxes.map((box) => {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(box.y / block); y < Math.ceil((box.y + box.height) / block); y++) {
        for (let x = Math.floor(box.x / block); x < Math.ceil((box.x + box.width) / block); x++) {
          sum += this.heat[y * this.cols + x] ?? 0;
          n++;
        }
      }
      const heat = n ? sum / n : 0;
      // Heat ~1 for a first change, up to ~6.7 for a region changing in every frame
      return Math.max(0.1, Math.min(1, 1.6 / (0.6 + heat)));
    });
  }
}
