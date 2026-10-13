// Tweened numbers: every visual parameter of the face eases toward a target
// instead of being set per frame.

export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;
export const easeInQuad: Easing = (t) => t * t;
export const easeOutQuad: Easing = (t) => 1 - (1 - t) * (1 - t);
export const easeOutCubic: Easing = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoots a little before settling: lively but small. */
export const easeOutBack: Easing = (t) => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export class Tween {
  private from: number;
  private to: number;
  private start = 0;
  private duration = 0;
  private easing: Easing = easeInOutCubic;

  constructor(value: number) {
    this.from = value;
    this.to = value;
  }

  get target(): number {
    return this.to;
  }

  /** Eases from the current value (at `now`) to `target` in `durationMs`. */
  set(target: number, durationMs: number, now: number, easing: Easing = easeInOutCubic): void {
    if (target === this.to && !this.active(now)) return;
    this.from = this.value(now);
    this.to = target;
    this.start = now;
    this.duration = Math.max(0, durationMs);
    this.easing = easing;
  }

  /** Sets the value immediately. */
  jump(value: number): void {
    this.from = value;
    this.to = value;
    this.duration = 0;
  }

  value(now: number): number {
    if (this.duration <= 0 || now >= this.start + this.duration) return this.to;
    if (now <= this.start) return this.from;
    const t = (now - this.start) / this.duration;
    return this.from + (this.to - this.from) * this.easing(t);
  }

  active(now: number): boolean {
    return this.duration > 0 && now < this.start + this.duration;
  }
}

/** Standard normal sample (Box-Muller). */
export function gaussian(random: () => number): number {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function between(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
