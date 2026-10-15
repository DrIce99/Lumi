// Natural blinking: log-normal intervals, occasional double blinks, blinks
// triggered by large saccades and sentence ends, slower when drowsy.
import { between, clamp, easeInQuad, easeOutQuad, gaussian } from "./tween";

export const CLOSE_MS = 60;
export const HOLD_MS = 20;
export const OPEN_MS = 90;
export const MIN_INTERVAL_MS = 1500;
export const MAX_INTERVAL_MS = 9000;
const MEAN_INTERVAL_MS = 4000;
const SIGMA = 0.5;
export const DOUBLE_BLINK_CHANCE = 0.15;

/** Time to the next spontaneous blink: log-normal with a mean of about 4 s, clamped to 1.5-9 s. */
export function blinkInterval(random: () => number, rate = 1): number {
  const mu = Math.log(MEAN_INTERVAL_MS) - (SIGMA * SIGMA) / 2;
  const raw = Math.exp(mu + SIGMA * gaussian(random));
  return clamp(raw, MIN_INTERVAL_MS, MAX_INTERVAL_MS) / Math.max(0.1, rate);
}

/** Lid closure (0 open .. 1 closed) `t` ms into a blink lasting `scale` times the normal one. */
export function blinkCurve(t: number, scale = 1): number {
  const close = CLOSE_MS * scale;
  const hold = HOLD_MS * scale;
  const open = OPEN_MS * scale;
  if (t < 0 || t >= close + hold + open) return 0;
  if (t < close) return easeInQuad(t / close);
  if (t < close + hold) return 1;
  return 1 - easeOutQuad((t - close - hold) / open);
}

export class Blinker {
  private startAt = Number.NEGATIVE_INFINITY;
  private scale = 1;
  private nextAt: number;
  private rate = 1;
  private slowness = 1;
  private pausedUntil = 0;
  /** A second blink is queued right after the running one (a double blink). */
  private second = false;

  constructor(
    now: number,
    private readonly random: () => number = Math.random,
  ) {
    this.nextAt = now + blinkInterval(random);
  }

  /** Multiplies the spontaneous blink frequency (talking: more, drowsy: less). */
  setRate(rate: number, now: number): void {
    if (rate === this.rate) return;
    // Rescale the wait still to go so a change takes effect right away
    const remaining = Math.max(0, this.nextAt - now);
    this.nextAt = now + (remaining * this.rate) / Math.max(0.1, rate);
    this.rate = rate;
  }

  /** Drowsy blinks are slower (1 = normal). */
  setSlowness(slowness: number): void {
    this.slowness = Math.max(1, slowness);
  }

  /** No blinks until `until` (surprise holds the eyes wide open). */
  pause(until: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, until);
    if (this.nextAt < until) this.nextAt = until + between(this.random, 200, 600);
  }

  /** Ends a pause at once (an expression without blinks is over). */
  resume(now: number): void {
    if (this.pausedUntil <= now) return;
    this.pausedUntil = 0;
    this.nextAt = now + between(this.random, 300, 900);
  }

  /** Blinks now, unless a blink is already running or blinking is paused. */
  trigger(now: number): boolean {
    if (this.blinking(now) || now < this.pausedUntil) return false;
    this.begin(now);
    return true;
  }

  /** Starts a spontaneous blink when one is due. Call every frame. */
  update(now: number): void {
    if (now >= this.nextAt && !this.blinking(now) && now >= this.pausedUntil) this.begin(now);
  }

  closure(now: number): number {
    return blinkCurve(now - this.startAt, this.scale);
  }

  blinking(now: number): boolean {
    return now - this.startAt < this.duration();
  }

  /** When the next blink is due (for waking an idle animation loop). */
  nextEventAt(): number {
    return Math.max(this.nextAt, this.pausedUntil);
  }

  private duration(): number {
    return (CLOSE_MS + HOLD_MS + OPEN_MS) * this.scale;
  }

  private begin(now: number): void {
    const isSecond = this.second;
    this.startAt = now;
    this.scale = this.slowness;
    const end = now + this.duration();
    // Now and then a second blink follows right away (never a third)
    this.second = !isSecond && this.random() < DOUBLE_BLINK_CHANCE;
    this.nextAt = this.second ? end + between(this.random, 70, 150) : end + blinkInterval(this.random, this.rate);
  }
}
