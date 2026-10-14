// The face: two vertical capsule eyes on a transparent canvas. Expression,
// blink, gaze and the talk pulse are separate layers that compose
// additively. The canvas animates at display rate only while something
// moves, then sleeps until the next blink or eye movement is due.
import type { Expression } from "../../shared/emotions";
import type { FaceContrast, FaceGesture, FaceLayout, FaceState, GazeCommand } from "../../shared/types";
import { Blinker } from "./blink";
import { EXPRESSION_DEFS, NEUTRAL_SHAPE, shapeFor, transitionMs, type EyeShape } from "./expressions";
import { GazeController } from "./gaze";
import { clamp, easeOutBack, Tween } from "./tween";

/** Eye size and spacing at scale 1 (px). */
export const EYE_WIDTH = 14;
export const EYE_HEIGHT = 44;
export const EYE_GAP = 22;
/** Blinking squashes the eye down to this fraction of its height. */
const BLINK_MIN = 0.1;
/** Talk pulse: ±5% height following the speech level. */
const TALK_PULSE = 0.05;
const GESTURE_MS: Record<FaceGesture, number> = { nod: 520, shake: 460, bounce: 480, tremble: 380 };
/** Shadow and border opacity until main measures the backdrop (its middle band). */
const DEFAULT_CONTRAST: FaceContrast = { shadow: 0.3, border: 0.18 };
/** Contrast changes ease in this long. */
const CONTRAST_MS = 400;
/** Soft shadow under each eye, px at scale 1. */
const SHADOW_BLUR = 6;
const SHADOW_OFFSET_Y = 1;

export interface EyeGeometry {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Radians, canvas convention (positive = clockwise). */
  angle: number;
  /** Lid and cheek cuts, see EyeShape. */
  lidTop: number;
  lidAngle: number;
  cheek: number;
  cheekAngle: number;
}

export function effectiveExpression(state: FaceState): Expression {
  if (state.thinking) return "pensiero";
  if (state.listening) return "ascolto";
  if (state.drowsy && state.expression === "neutra") return "sonno";
  return state.expression;
}

export class Face {
  private layout: FaceLayout;
  private state: FaceState = { expression: "neutra", intensity: 0.6, listening: false, thinking: false, speaking: false, drowsy: false };
  private expression: Expression = "neutra";
  private readonly blinker: Blinker;
  private readonly gaze: GazeController;
  private readonly shape: Record<keyof EyeShape, Tween>;
  private gestures: { kind: FaceGesture; start: number; seed: number }[] = [];
  private bounceAt = Number.NEGATIVE_INFINITY;
  private level = 0;
  private lastFrame = 0;
  private levelSource: (() => number) | null = null;
  /** Audio is playing right now (known in the renderer before main says "speaking"). */
  private talking = false;
  private raf = 0;
  private wakeTimer: number | undefined;
  private readonly ctx: CanvasRenderingContext2D;
  /** The eyes alone, and their grown silhouette for the border (offscreen). */
  private readonly layer = offscreen();
  private readonly outline = offscreen();
  private dpr = 1;
  private readonly shadow = new Tween(DEFAULT_CONTRAST.shadow);
  private readonly border = new Tween(DEFAULT_CONTRAST.border);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    layout: FaceLayout,
    private readonly random: () => number = Math.random,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.layout = layout;
    const now = performance.now();
    this.blinker = new Blinker(now, random);
    this.gaze = new GazeController(now, random);
    this.gaze.onLargeSaccade = (t) => {
      if (this.random() < 0.75) this.blinker.trigger(t);
    };
    this.shape = Object.fromEntries(Object.entries(NEUTRAL_SHAPE).map(([k, v]) => [k, new Tween(v)])) as Record<keyof EyeShape, Tween>;
    this.resize();
    this.wake();
  }

  setLayout(layout: FaceLayout): void {
    this.layout = layout;
    this.resize();
    this.wake();
  }

  setState(state: FaceState): void {
    const now = performance.now();
    const prev = this.state;
    this.state = state;
    const next = effectiveExpression(state);
    const changed = next !== this.expression || state.intensity !== prev.intensity;
    if (changed) this.applyExpression(next, state.intensity, now, next !== this.expression);
    if (state.speaking !== prev.speaking || state.drowsy !== prev.drowsy || changed) {
      const def = EXPRESSION_DEFS[next];
      this.blinker.setRate(def.blinkRate * (state.speaking ? 1.35 : 1), now);
      this.blinker.setSlowness(state.drowsy || next === "sonno" ? 2.5 : 1);
    }
    this.wake();
  }

  setGaze(command: GazeCommand): void {
    this.gaze.setCommand(command, performance.now());
    this.wake();
  }

  /** How strongly the eyes are outlined, from the brightness behind the face. */
  setContrast(contrast: FaceContrast): void {
    const now = performance.now();
    this.shadow.set(contrast.shadow, CONTRAST_MS, now);
    this.border.set(contrast.border, CONTRAST_MS, now);
    this.wake();
  }

  gesture(kind: FaceGesture): void {
    this.gestures.push({ kind, start: performance.now(), seed: this.random() * 1000 });
    this.wake();
  }

  /** A sentence starts playing: a small lift of the eyes. */
  sentenceStart(): void {
    this.bounceAt = performance.now();
    this.wake();
  }

  /** A sentence ended: people often blink at the end of a phrase. */
  sentenceEnd(): void {
    if (this.random() < 0.5) this.blinker.trigger(performance.now());
    this.wake();
  }

  /** Where the talk pulse reads the current output level (RMS, 0..1). */
  setLevelSource(source: (() => number) | null): void {
    this.levelSource = source;
    this.wake();
  }

  /** The voice is playing: the eyes pulse with it. */
  setTalking(talking: boolean): void {
    if (talking === this.talking) return;
    this.talking = talking;
    this.wake();
  }

  private speaking(): boolean {
    return this.state.speaking || this.talking;
  }

  /** Whether a point (window DIP) is on one of the eyes, with a few px of tolerance. */
  hitTest(x: number, y: number, margin = 4): boolean {
    const s = this.layout.scale;
    for (const eye of this.eyes(performance.now())) {
      const cos = Math.cos(-eye.angle);
      const sin = Math.sin(-eye.angle);
      const lx = (x - eye.cx) * cos - (y - eye.cy) * sin;
      const ly = (x - eye.cx) * sin + (y - eye.cy) * cos;
      // A blink must not make the eyes hard to grab
      const h = Math.max(eye.height, EYE_HEIGHT * 0.6 * s);
      if (Math.abs(lx) <= eye.width / 2 + margin && Math.abs(ly) <= h / 2 + margin) return true;
    }
    return false;
  }

  /** The two eyes' geometry at `now`, in window DIP. */
  eyes(now: number): [EyeGeometry, EyeGeometry] {
    const s = this.layout.scale;
    const f = this.layout.face;
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    const v = (k: keyof EyeShape) => this.shape[k].value(now);
    const look = this.gaze.output(now);
    const gesture = this.gestureOffset(now);
    const bounce = this.bounceOffset(now);
    const closure = this.blinker.closure(now);
    const talk = this.speaking() ? TALK_PULSE * (2 * this.level - 1) : 0;
    const width = EYE_WIDTH * v("width") * s;
    const baseHeight = EYE_HEIGHT * v("height") * s * (1 + talk);
    const lid = clamp(v("lid"), 0, 0.95);
    const half = (EYE_GAP + EYE_WIDTH) / 2 + v("spread") / 2;
    const tilt = (v("tilt") * Math.PI) / 180;
    const make = (side: -1 | 1): EyeGeometry => {
      const asym = side === 1 ? 1 + v("asym") : 1;
      const open = baseHeight * asym * (1 - lid);
      const height = Math.max(width * 0.2, open * (1 - (1 - BLINK_MIN) * closure));
      // The resting lid lowers the top of the eye; blinks squash toward the middle
      const lidDrop = (baseHeight * asym * lid) / 2;
      return {
        cx: cx + side * half * s + (look.x - side * look.vergence + gesture.x) * s,
        cy: cy + (v("y") + look.y + gesture.y + bounce) * s + lidDrop,
        width,
        height,
        angle: side * tilt,
        lidTop: clamp(v("lidTop"), 0, 0.9),
        lidAngle: v("lidAngle"),
        cheek: clamp(v("cheek"), 0, 0.9),
        cheekAngle: v("cheekAngle"),
      };
    };
    return [make(-1), make(1)];
  }

  private applyExpression(next: Expression, intensity: number, now: number, onset: boolean): void {
    const from = Object.fromEntries(Object.entries(this.shape).map(([k, t]) => [k, t.value(now)])) as unknown as EyeShape;
    const to = shapeFor(next, intensity);
    const ms = next === "sonno" ? 1800 : transitionMs(from, to);
    for (const key of Object.keys(this.shape) as (keyof EyeShape)[]) this.shape[key].set(to[key], ms, now);
    const def = EXPRESSION_DEFS[next];
    this.gaze.setStyle({ bias: def.gazeBias, avert: def.avert, saccadeRate: def.saccadeRate }, now);
    if (onset) {
      if (def.blinkPauseMs) this.blinker.pause(now + def.blinkPauseMs);
      if (def.onset) this.gesture(def.onset);
    }
    this.expression = next;
  }

  private gestureOffset(now: number): { x: number; y: number } {
    let x = 0;
    let y = 0;
    this.gestures = this.gestures.filter((g) => now - g.start < GESTURE_MS[g.kind]);
    for (const g of this.gestures) {
      const t = (now - g.start) / GESTURE_MS[g.kind];
      const fade = 1 - t;
      switch (g.kind) {
        case "nod":
          y += 3 * Math.sin(t * Math.PI * 4) * fade;
          break;
        case "shake":
          x += 2.6 * Math.sin(t * Math.PI * 4) * fade;
          break;
        case "bounce":
          y -= 5 * Math.abs(Math.sin(t * Math.PI * 2)) * fade;
          break;
        case "tremble":
          x += 1.2 * Math.sin(now * 0.09 + g.seed) * fade;
          break;
      }
    }
    return { x, y };
  }

  private bounceOffset(now: number): number {
    const t = (now - this.bounceAt) / 240;
    if (t < 0 || t >= 1) return 0;
    return -2.5 * (1 - easeOutBack(t));
  }

  private animating(now: number): boolean {
    return (
      this.speaking() ||
      this.blinker.blinking(now) ||
      this.gaze.active(now) ||
      this.gestures.length > 0 ||
      now - this.bounceAt < 240 ||
      this.shadow.active(now) ||
      this.border.active(now) ||
      Object.values(this.shape).some((t) => t.active(now))
    );
  }

  private wake = (): void => {
    window.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  private frame = (): void => {
    this.raf = 0;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    this.blinker.update(now);
    this.gaze.update(now);
    this.updateLevel(dt);
    this.draw(now);
    if (this.animating(now)) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.lastFrame = 0;
      const next = Math.min(this.blinker.nextEventAt(), this.gaze.nextEventAt());
      this.wakeTimer = window.setTimeout(this.wake, Math.max(10, next - now));
    }
  };

  private updateLevel(dt: number): void {
    const raw = this.speaking() && this.levelSource ? clamp(this.levelSource() / 0.12, 0, 1) : 0;
    // Fast attack, slower release, like a VU meter
    const tau = raw > this.level ? 30 : 90;
    this.level += (raw - this.level) * (1 - Math.exp(-dt / tau));
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const { windowWidth, windowHeight } = this.layout;
    this.canvas.style.width = `${windowWidth}px`;
    this.canvas.style.height = `${windowHeight}px`;
    for (const c of [this.canvas, this.layer.canvas, this.outline.canvas]) {
      c.width = Math.round(windowWidth * dpr);
      c.height = Math.round(windowHeight * dpr);
    }
  }

  private draw(now: number): void {
    const { scale, color } = this.layout;
    const dpr = this.dpr;
    // Canvas shadows ignore the transform: blur and offset are in device pixels
    const px = scale * dpr;
    // Only the face box (plus room for the glow) changes
    const f = this.layout.face;
    const margin = 14 * scale;
    const box = {
      x: Math.max(0, Math.floor((f.x - margin) * dpr)),
      y: Math.max(0, Math.floor((f.y - margin) * dpr)),
      width: Math.ceil((f.width + 2 * margin) * dpr),
      height: Math.ceil((f.height + 2 * margin) * dpr),
    };

    // 1. The eyes, lids and cheeks cut away, on their own layer
    const layer = this.layer;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(box.x, box.y, box.width, box.height);
    layer.setTransform(dpr, 0, 0, dpr, 0, 0);
    layer.fillStyle = color;
    this.eyes(now).forEach((eye, i) => {
      layer.save();
      layer.translate(eye.cx, eye.cy);
      layer.rotate(eye.angle);
      if (eye.lidTop > 0.001 || eye.cheek > 0.001) {
        layer.beginPath();
        lidPath(layer, eye, i === 0 ? -1 : 1);
        layer.clip();
      }
      layer.beginPath();
      layer.roundRect(-eye.width / 2, -eye.height / 2, eye.width, eye.height, Math.min(eye.width, eye.height) / 2);
      layer.fill();
      layer.restore();
    });

    // 2. The border: the eye shapes grown by one line width, in black
    const border = this.border.value(now);
    const outline = this.outline;
    const d = Math.max(0.75, scale) * dpr;
    outline.setTransform(1, 0, 0, 1, 0, 0);
    outline.clearRect(box.x, box.y, box.width, box.height);
    if (border > 0.001) {
      for (const [dx, dy] of OUTLINE_DIRS) blit(outline, layer.canvas, box, dx * d, dy * d);
      outline.globalCompositeOperation = "source-in";
      outline.fillStyle = "#000";
      outline.fillRect(box.x, box.y, box.width, box.height);
      outline.globalCompositeOperation = "source-over";
    }

    // 3. Composite: a warm glow (visible on dark backgrounds), the border, then
    // the eyes over a soft dark shadow, stronger the brighter the backdrop
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.shadowColor = withAlpha(color, 0.55);
    ctx.shadowBlur = 7 * px;
    blit(ctx, layer.canvas, box);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    if (border > 0.001) {
      ctx.globalAlpha = border;
      blit(ctx, outline.canvas, box);
      ctx.globalAlpha = 1;
    }
    ctx.shadowColor = `rgba(0, 0, 0, ${this.shadow.value(now)})`;
    ctx.shadowBlur = SHADOW_BLUR * px;
    ctx.shadowOffsetY = SHADOW_OFFSET_Y * px;
    blit(ctx, layer.canvas, box);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
}

/** Eight directions, to grow a shape by stamping it around itself. */
const OUTLINE_DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7],
];

/** Copies a region of `src` (device pixels) to the same place in `ctx`, shifted by dx, dy. */
function blit(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }, dx = 0, dy = 0): void {
  ctx.drawImage(src, box.x, box.y, box.width, box.height, box.x + dx, box.y + dy, box.width, box.height);
}

/**
 * The part of an eye that stays visible (eye-local coordinates, after the
 * tilt): between a straight lid from above and a straight cheek line from
 * below, each possibly slanted.
 */
export function lidPath(ctx: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath">, eye: EyeGeometry, side: -1 | 1): void {
  const half = eye.height / 2;
  const m = eye.width / 2 + 2;
  // A line barely moved in can't be slanted much (it would cut the corners of an open eye)
  const slant = (angle: number, cut: number) => Math.tan((angle * Math.PI) / 180) * Math.min(1, cut * 8);
  const lidSlope = slant(eye.lidAngle, eye.lidTop);
  const cheekSlope = slant(eye.cheekAngle, eye.cheek);
  // `-side * x` grows toward the nose: positive angles put both lines lower on the inner side
  const lidAt = (x: number) => -half + eye.lidTop * eye.height + lidSlope * (-side * x);
  const cheekAt = (x: number) => half - eye.cheek * eye.height + cheekSlope * (-side * x);
  ctx.moveTo(-m, lidAt(-m));
  ctx.lineTo(m, lidAt(m));
  ctx.lineTo(m, cheekAt(m));
  ctx.lineTo(-m, cheekAt(-m));
  ctx.closePath();
}

function offscreen(): CanvasRenderingContext2D {
  return document.createElement("canvas").getContext("2d")!;
}

/** `#rrggbb` with an alpha, as an rgba() color. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(245, 243, 238, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
