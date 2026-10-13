// Where the eyes point. The main process decides the target (attention);
// this module turns it into eye movements: fast saccades between fixations,
// micro-saccades while fixating, smooth pursuit of a moving mouse, a little
// vergence for targets close to the face and slow wandering when idle.
import type { AttentionKind, GazeCommand } from "../../shared/types";
import { between, clamp, easeOutCubic, easeOutQuad, Tween } from "./tween";

export const MAX_OFFSET_X = 9;
export const MAX_OFFSET_Y = 7;
/** Distance (DIP) at which the eyes reach ~76% of their range: offset = max · tanh(d / k). */
export const SATURATION_DIP = 350;
/** Below this distance from the face the eyes converge. */
const NEAR_DIP = 150;
const MAX_VERGENCE = 1.8;
/** A target jump this large (DIP) counts as a large saccade (>25°) and brings a blink. */
export const LARGE_SACCADE_DIP = 300;
const MICRO_PX = 0.5;
/** Kinds that cut a fixation short instead of waiting for it to end. */
const URGENT: ReadonlySet<AttentionKind> = new Set(["speaking", "caret", "user"]);

export interface Point {
  x: number;
  y: number;
}

/** Eye offset (px at scale 1) for a target `dx, dy` DIP away from the face center. */
export function gazeOffset(dx: number, dy: number): Point {
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const m = Math.tanh(d / SATURATION_DIP);
  return { x: (MAX_OFFSET_X * m * dx) / d, y: (MAX_OFFSET_Y * m * dy) / d };
}

/** Inward rotation of each eye for a target this far from the face. */
export function vergenceFor(distance: number): number {
  return distance >= NEAR_DIP ? 0 : MAX_VERGENCE * (1 - distance / NEAR_DIP);
}

/** Saccades last 30-60 ms, longer for bigger jumps. */
export function saccadeMs(amplitudePx: number): number {
  return Math.round(clamp(30 + amplitudePx * 2.2, 30, 60));
}

/** How long to hold a fixation on a target of this kind. */
export function fixationMs(kind: AttentionKind, random: () => number): number {
  return kind === "reading" ? 120 : between(random, 250, 800);
}

export interface GazeStyle {
  /** Eyes go here (-1..1 of the range) whatever the target. */
  bias: Point | null;
  /** Look away sideways from the target. */
  avert: boolean;
  /** Multiplies how often the eyes wander and micro-move. */
  saccadeRate: number;
}

export interface GazeOutput {
  x: number;
  y: number;
  /** Inward shift of each eye, px. */
  vergence: number;
}

export class GazeController {
  private readonly x = new Tween(0);
  private readonly y = new Tween(0);
  private readonly verg = new Tween(0);
  private readonly microX = new Tween(0);
  private readonly microY = new Tween(0);
  private command: GazeCommand = { target: null, kind: "idle", pursuit: false };
  private pending: GazeCommand | null = null;
  private fixationUntil = 0;
  private nextMicroAt: number;
  private nextWanderAt: number;
  private style: GazeStyle = { bias: null, avert: false, saccadeRate: 1 };
  private lastScreen: Point | null = null;
  private pursuitTarget: Point | null = null;
  /** Called when the eyes make a large jump (blink sync). */
  onLargeSaccade: ((now: number) => void) | null = null;

  constructor(
    now: number,
    private readonly random: () => number = Math.random,
  ) {
    this.nextMicroAt = now + between(random, 500, 1500);
    this.nextWanderAt = now + between(random, 1500, 4000);
  }

  setCommand(command: GazeCommand, now: number): void {
    if (command.pursuit && command.target) {
      this.command = command;
      this.pending = null;
      this.startPursuit(command.target, now);
      return;
    }
    this.pursuitTarget = null;
    if (now < this.fixationUntil && !URGENT.has(command.kind)) {
      this.pending = command;
      return;
    }
    this.pending = null;
    this.command = command;
    this.saccadeTo(command, now);
  }

  setStyle(style: GazeStyle, now: number): void {
    const changed =
      style.avert !== this.style.avert || style.bias?.x !== this.style.bias?.x || style.bias?.y !== this.style.bias?.y;
    this.style = style;
    if (changed) {
      this.pursuitTarget = null;
      this.saccadeTo(this.command, now);
    }
  }

  update(now: number): void {
    if (this.pursuitTarget) {
      // Pursuit lasts while the eyes are catching up; the next position restarts it
      if (this.moving(now)) return;
      this.pursuitTarget = null;
    }
    if (this.pending && now >= this.fixationUntil) {
      const next = this.pending;
      this.pending = null;
      this.command = next;
      this.saccadeTo(next, now);
      return;
    }
    const rate = Math.max(0.1, this.style.saccadeRate);
    if (!this.command.target && !this.style.bias && now >= this.nextWanderAt && now >= this.fixationUntil) {
      this.wander(now);
      this.nextWanderAt = now + between(this.random, 1500, 4000) / rate;
    }
    if (now >= this.nextMicroAt && !this.moving(now)) {
      // Tiny involuntary jitter while fixating
      this.microX.set(between(this.random, -MICRO_PX, MICRO_PX), 20, now, easeOutQuad);
      this.microY.set(between(this.random, -MICRO_PX, MICRO_PX), 20, now, easeOutQuad);
      this.nextMicroAt = now + between(this.random, 500, 1500) / rate;
    }
  }

  output(now: number): GazeOutput {
    return {
      x: this.x.value(now) + this.microX.value(now),
      y: this.y.value(now) + this.microY.value(now),
      vergence: this.verg.value(now),
    };
  }

  /** Something is moving right now (the animation loop must run). */
  active(now: number): boolean {
    return this.moving(now) || this.microX.active(now) || this.microY.active(now);
  }

  /** When the eyes will move next on their own (micro-saccade, wandering, a queued target). */
  nextEventAt(): number {
    let next = this.nextMicroAt;
    if (this.pending) next = Math.min(next, this.fixationUntil);
    if (!this.command.target && !this.style.bias) next = Math.min(next, Math.max(this.nextWanderAt, this.fixationUntil));
    return next;
  }

  /** Smooth pursuit: chase the moving target with a short lag; call again on every new position. */
  private startPursuit(target: { dx: number; dy: number }, now: number): void {
    const goal = this.aim(target);
    const jump = Math.hypot(goal.x - this.x.value(now), goal.y - this.y.value(now));
    this.pursuitTarget = goal;
    this.trackLargeJump(target, now);
    // A target far from where the eyes are needs a catch-up saccade first
    const duration = jump > 4 ? saccadeMs(jump) : 90;
    this.x.set(goal.x, duration, now, jump > 4 ? easeOutCubic : easeOutQuad);
    this.y.set(goal.y, duration, now, jump > 4 ? easeOutCubic : easeOutQuad);
    this.verg.set(vergenceFor(Math.hypot(target.dx, target.dy)), 120, now);
    this.fixationUntil = now + duration;
  }

  private saccadeTo(command: GazeCommand, now: number): void {
    const goal = command.target ? this.aim(command.target) : this.styleOnly();
    const amplitude = Math.hypot(goal.x - this.x.value(now), goal.y - this.y.value(now));
    if (amplitude < 0.15) {
      this.fixationUntil = now + fixationMs(command.kind, this.random);
      return;
    }
    if (command.target) this.trackLargeJump(command.target, now);
    const duration = saccadeMs(amplitude);
    this.x.set(goal.x, duration, now, easeOutCubic);
    this.y.set(goal.y, duration, now, easeOutCubic);
    this.verg.set(command.target ? vergenceFor(Math.hypot(command.target.dx, command.target.dy)) : 0, duration, now);
    this.microX.jump(0);
    this.microY.jump(0);
    this.fixationUntil = now + duration + fixationMs(command.kind, this.random);
  }

  /** Eye offset for a target, after the expression's bias or aversion. */
  private aim(target: { dx: number; dy: number }): Point {
    const bias = this.styleOnly();
    if (this.style.bias) return bias;
    const offset = gazeOffset(target.dx, target.dy);
    if (this.style.avert) {
      const side = offset.x === 0 ? 1 : -Math.sign(offset.x);
      return { x: side * MAX_OFFSET_X * 0.8, y: MAX_OFFSET_Y * 0.35 };
    }
    return offset;
  }

  private styleOnly(): Point {
    if (this.style.bias) return { x: this.style.bias.x * MAX_OFFSET_X, y: this.style.bias.y * MAX_OFFSET_Y };
    if (this.style.avert) return { x: MAX_OFFSET_X * 0.8, y: MAX_OFFSET_Y * 0.35 };
    return { x: 0, y: 0 };
  }

  private wander(now: number): void {
    // Drift around, or come back to the user (straight ahead, slightly down)
    const home = this.random() < 0.35;
    const goal = home
      ? { x: 0, y: MAX_OFFSET_Y * 0.25 }
      : { x: between(this.random, -0.4, 0.4) * MAX_OFFSET_X, y: between(this.random, -0.3, 0.3) * MAX_OFFSET_Y };
    const amplitude = Math.hypot(goal.x - this.x.value(now), goal.y - this.y.value(now));
    const duration = saccadeMs(amplitude);
    this.x.set(goal.x, duration, now, easeOutCubic);
    this.y.set(goal.y, duration, now, easeOutCubic);
    this.verg.set(0, duration, now);
    this.fixationUntil = now + duration + between(this.random, 250, 800);
  }

  private trackLargeJump(target: { dx: number; dy: number }, now: number): void {
    const screen = { x: target.dx, y: target.dy };
    if (this.lastScreen && Math.hypot(screen.x - this.lastScreen.x, screen.y - this.lastScreen.y) > LARGE_SACCADE_DIP) {
      this.onLargeSaccade?.(now);
    }
    this.lastScreen = screen;
  }

  private moving(now: number): boolean {
    return this.x.active(now) || this.y.active(now) || this.verg.active(now);
  }
}
