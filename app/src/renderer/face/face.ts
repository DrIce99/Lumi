// The face: two vertical capsule eyes on a transparent canvas. Expression,
// blink, gaze and the talk pulse are separate layers that compose
// additively. Some expressions change the eyes' shape (rings, chevrons,
// lines: crossfaded), bring props (glasses, lines) and a continuous motion
// (glyphs.ts). The canvas animates at display rate only while something
// moves, then sleeps until the next blink or eye movement is due.
import type { Expression } from "../../shared/emotions";
import type { FaceContrast, FaceGesture, FaceLayout, FaceState, GazeCommand } from "../../shared/types";
import { Blinker } from "./blink";
import { EXPRESSION_DEFS, NEUTRAL_SHAPE, shapeFor, transitionMs, type EyeShape } from "./expressions";
import { GazeController, MAX_OFFSET_X } from "./gaze";
import { glareEnd, glareFrame, SHIFT_PX, startGlare, type GlarePlay } from "./glare";
import {
  chevronLine,
  chevronPoints,
  glasses,
  GLASSES_PUSH_MS,
  glassesPush,
  motionAt,
  ringGeometry,
  SHOCK_COLOR,
  shockLine,
  shockLines,
  squintLine,
  squintLines,
  type Accessory,
  type Glyph,
  type Motion,
  type Segment,
} from "./glyphs";
import { clamp, easeOutBack, Tween } from "./tween";

/** Eye size and spacing at scale 1 (px). */
export const EYE_WIDTH = 14;
export const EYE_HEIGHT = 44;
export const EYE_GAP = 22;
/** Blinking squashes the eye down to this fraction of its height. */
const BLINK_MIN = 0.1;
/** Talk pulse: ±5% height following the speech level. */
const TALK_PULSE = 0.05;
const GESTURE_MS: Record<FaceGesture, number> = { nod: 520, shake: 460, bounce: 480, tremble: 380, freeze: 900, glassesPush: GLASSES_PUSH_MS, land: 320 };
/** A shock freezes the eyes this long before the jolt. */
const FREEZE_MS = 500;
/** Changing the eyes' shape (capsule, ring, chevron) crossfades this long. */
const GLYPH_FADE_MS = 160;
/** Props fade in and out this fast. */
const PROP_IN_MS = 200;
const PROP_OUT_MS = 150;
const ACCESSORIES: Accessory[] = ["glasses", "squintLines", "shockLines"];
/** The idle animation never sleeps longer than this (a timer of Infinity would fire at once). */
const MAX_SLEEP_MS = 60_000;
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
  private glarePlay: GlarePlay | null = null;
  /** Flying: the eyes stretch along the motion and trail a little behind it. */
  private readonly travelX = new Tween(0);
  private readonly travelY = new Tween(0);
  /** The side the last suspicious look went to. */
  private lastSide: -1 | 1 = 1;
  /** The eyes' shape now, and the one fading out. */
  private glyph: { current: Glyph; previous: Glyph; since: number } = { current: "capsule", previous: "capsule", since: Number.NEGATIVE_INFINITY };
  private readonly pupil = new Tween(0);
  private readonly props = Object.fromEntries(ACCESSORIES.map((a) => [a, new Tween(0)])) as Record<Accessory, Tween>;
  private motion: Motion | null = null;
  private readonly motionStrength = new Tween(0);
  private readonly motionSeed: number;
  /** Where the eyes were looking when a shock froze them. */
  private frozenGaze: { x: number; y: number; vergence: number } | null = null;
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
    this.motionSeed = random() * 1000;
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
    const now = performance.now();
    // A gesture of the same kind restarts instead of piling up
    this.gestures = this.gestures.filter((g) => g.kind !== kind);
    this.gestures.push({ kind, start: now, seed: this.random() * 1000 });
    if (kind === "freeze") {
      this.frozenGaze = this.gaze.output(now);
      this.blinker.pause(now + GESTURE_MS.freeze);
    }
    this.wake();
  }

  /**
   * Dazzled by a screen that suddenly turned bright. `lightDx`: where the
   * light is, horizontally from the face center (screen DIP).
   */
  glare(lightDx: number): void {
    const now = performance.now();
    this.glarePlay = startGlare(now, lightDx, this.gaze.output(now).x, this.speaking(), this.random);
    // No spontaneous blink in the middle of the squint; the settling blinks come after
    this.blinker.pause(glareEnd(this.glarePlay));
    this.wake();
  }

  /** Lumi flies across the screen (window moved by main): `vx, vy` -1..1; `landed` squashes the eyes once. */
  travel(vx: number, vy: number, landed: boolean): void {
    const now = performance.now();
    this.travelX.set(clamp(vx, -1, 1), 90, now);
    this.travelY.set(clamp(vy, -1, 1), 90, now);
    if (landed) {
      this.gesture("land");
      this.blinker.trigger(now + 120);
    }
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
    const frozen = this.frozen(now);
    const look = frozen ?? this.gaze.output(now);
    const motion = frozen ? motionAt(null, now, 0) : motionAt(this.motion, now, this.motionSeed, this.motionStrength.value(now));
    const gesture = this.gestureOffset(now);
    const bounce = this.bounceOffset(now);
    const closure = this.blinker.closure(now);
    const talk = this.speaking() ? TALK_PULSE * (2 * this.level - 1) : 0;
    const tx = this.travelX.value(now);
    const ty = this.travelY.value(now);
    // Stretched along the flight, a little thinner across it; squashed on landing
    const land = this.landSquash(now);
    const width = EYE_WIDTH * v("width") * s * motion.sx * (1 + 0.28 * Math.abs(tx) - 0.1 * Math.abs(ty)) * (1 + 0.12 * land);
    const baseHeight = EYE_HEIGHT * v("height") * s * (1 + talk) * motion.sy * (1 + 0.32 * Math.abs(ty) - 0.12 * Math.abs(tx)) * (1 - 0.18 * land);
    const lid = clamp(v("lid"), 0, 0.95);
    const half = (EYE_GAP + EYE_WIDTH) / 2 + v("spread") / 2;
    const tilt = (v("tilt") * Math.PI) / 180;
    // Dazzled: the eye near the light squeezes shut, the gaze slips away from it
    const play = this.glarePlay;
    const dazzle = play ? glareFrame(play, now) : null;
    const away = play && dazzle ? -play.side * SHIFT_PX * dazzle.shift : 0;
    const make = (side: -1 | 1): EyeGeometry => {
      const asym = side === 1 ? 1 + v("asym") : 1;
      const squint = play && dazzle ? (side === play.side ? dazzle.near : dazzle.far) : 1;
      const open = baseHeight * asym * (1 - lid) * squint;
      const height = Math.max(width * 0.2, open * (1 - (1 - BLINK_MIN) * closure));
      // The resting lid lowers the top of the eye; blinks squash toward the middle
      const lidDrop = (baseHeight * asym * lid) / 2;
      return {
        cx: cx + side * half * s + (look.x + motion.gazeX * MAX_OFFSET_X * 0.5 - side * look.vergence + gesture.x + away + motion.dx - 3 * tx) * s,
        cy: cy + (v("y") + look.y + gesture.y + bounce + motion.dy - 3 * ty) * s + lidDrop,
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
    const previous = EXPRESSION_DEFS[this.expression];
    // A suspicious look goes to one side, chosen anew each time
    const side = def.randomSide && onset ? (this.random() < 0.5 ? -1 : 1) : 1;
    const bias = def.gazeBias ? { x: def.gazeBias.x * (def.randomSide && !onset ? this.lastSide : side), y: def.gazeBias.y } : null;
    if (def.randomSide && onset) this.lastSide = side;
    this.gaze.setStyle({ bias, avert: def.avert, saccadeRate: def.saccadeRate, still: def.still }, now);
    const glyph = def.glyph ?? "capsule";
    if (glyph !== this.glyph.current) this.glyph = { current: glyph, previous: this.glyph.current, since: now };
    this.pupil.set(def.pupil ?? 0, ms, now);
    for (const a of ACCESSORIES) {
      const on = def.accessories?.includes(a) ?? false;
      this.props[a].set(on ? 1 : 0, on ? PROP_IN_MS : PROP_OUT_MS, now);
    }
    if (def.motion) this.motion = def.motion;
    // The motion's strength follows the intensity; it fades out rather than stopping dead
    this.motionStrength.set(def.motion ? 0.5 + 0.5 * clamp(intensity, 0, 1) : 0, 250, now);
    if (def.noBlink) this.blinker.pause(now + 3_600_000);
    else if (previous.noBlink) this.blinker.resume(now);
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
        case "freeze": {
          // Still for half a second, then a small jolt upward
          const ms = now - g.start - FREEZE_MS;
          if (ms > 0) y -= 4 * Math.sin(Math.PI * Math.min(1, ms / (GESTURE_MS.freeze - FREEZE_MS)));
          break;
        }
      }
    }
    return { x, y };
  }

  /** 0..1..0 over the landing gesture. */
  private landSquash(now: number): number {
    const g = this.gestures.find((x) => x.kind === "land");
    if (!g) return 0;
    const t = (now - g.start) / GESTURE_MS.land;
    return t < 0 || t >= 1 ? 0 : Math.sin(Math.PI * t) * (1 - t * 0.5);
  }

  /** The gaze held by a shock's freeze, or null. */
  private frozen(now: number): { x: number; y: number; vergence: number } | null {
    const freeze = this.gestures.find((g) => g.kind === "freeze");
    if (!freeze || now - freeze.start >= FREEZE_MS || !this.frozenGaze) return null;
    return this.frozenGaze;
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
      this.glarePlay !== null ||
      now - this.glyph.since < GLYPH_FADE_MS ||
      this.travelX.active(now) ||
      this.travelY.active(now) ||
      Math.abs(this.travelX.value(now)) + Math.abs(this.travelY.value(now)) > 0.001 ||
      this.pupil.active(now) ||
      ACCESSORIES.some((a) => this.props[a].active(now)) ||
      (this.motion !== null && (this.motionStrength.value(now) > 0.001 || this.motionStrength.active(now))) ||
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
    this.updateGlare(now);
    this.updateLevel(dt);
    this.draw(now);
    if (this.animating(now)) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.lastFrame = 0;
      const next = Math.min(this.blinker.nextEventAt(), this.gaze.nextEventAt());
      this.wakeTimer = window.setTimeout(this.wake, Math.min(MAX_SLEEP_MS, Math.max(10, next - now)));
    }
  };

  /** The quick blinks that settle the eyes after a glare, then the end of it. */
  private updateGlare(now: number): void {
    const play = this.glarePlay;
    if (!play) return;
    while (play.blinks.length && play.blinks[0] <= now) {
      play.blinks.shift();
      this.blinker.trigger(now);
    }
    if (!play.blinks.length && now >= glareEnd(play)) this.glarePlay = null;
  }

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

    // 1. The eyes (lids and cheeks cut away) and their props, on their own layer
    const layer = this.layer;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(box.x, box.y, box.width, box.height);
    layer.setTransform(dpr, 0, 0, dpr, 0, 0);
    layer.fillStyle = color;
    layer.strokeStyle = color;
    layer.lineCap = "round";
    layer.lineJoin = "round";
    const eyes = this.eyes(now);
    // A change of shape crossfades: the old one fades out as the new one comes in
    const fade = clamp((now - this.glyph.since) / GLYPH_FADE_MS, 0, 1);
    const glyphs: [Glyph, number][] = fade < 1 && this.glyph.previous !== this.glyph.current ? [[this.glyph.previous, 1 - fade], [this.glyph.current, fade]] : [[this.glyph.current, 1]];
    eyes.forEach((eye, i) => {
      for (const [glyph, alpha] of glyphs) {
        layer.globalAlpha = alpha;
        this.drawEye(layer, eye, i === 0 ? -1 : 1, glyph, scale);
      }
    });
    layer.globalAlpha = 1;
    this.drawProps(layer, eyes, now, scale);

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

  /** One eye in one shape, eye-local after the tilt. */
  private drawEye(layer: CanvasRenderingContext2D, eye: EyeGeometry, side: -1 | 1, glyph: Glyph, scale: number): void {
    layer.save();
    layer.translate(eye.cx, eye.cy);
    layer.rotate(eye.angle);
    if (glyph === "ring") {
      const ring = ringGeometry(eye.width, eye.height, this.pupil.value(performance.now()), scale);
      layer.lineWidth = ring.line;
      layer.beginPath();
      layer.ellipse(0, 0, ring.rx, ring.ry, 0, 0, Math.PI * 2);
      layer.stroke();
      if (ring.pupil > 0) {
        layer.beginPath();
        layer.arc(0, 0, ring.pupil, 0, Math.PI * 2);
        layer.fill();
      }
    } else if (glyph === "chevron") {
      const [a, b, c] = chevronPoints(eye.width, eye.height, side);
      layer.lineWidth = chevronLine(scale);
      layer.beginPath();
      layer.moveTo(a.x, a.y);
      layer.lineTo(b.x, b.y);
      layer.lineTo(c.x, c.y);
      layer.stroke();
    } else {
      if (eye.lidTop > 0.001 || eye.cheek > 0.001) {
        layer.beginPath();
        lidPath(layer, eye, side);
        layer.clip();
      }
      layer.beginPath();
      layer.roundRect(-eye.width / 2, -eye.height / 2, eye.width, eye.height, Math.min(eye.width, eye.height) / 2);
      layer.fill();
    }
    layer.restore();
  }

  /** Glasses (with the pushing finger), doubt lines, shock lines: each fades with its expression. */
  private drawProps(layer: CanvasRenderingContext2D, eyes: [EyeGeometry, EyeGeometry], now: number, scale: number): void {
    const stroke = (segments: Segment[], width: number, alpha: number, color?: string) => {
      layer.save();
      layer.globalAlpha = alpha;
      layer.lineWidth = width;
      if (color) layer.strokeStyle = color;
      layer.beginPath();
      for (const [a, b] of segments) {
        layer.moveTo(a.x, a.y);
        layer.lineTo(b.x, b.y);
      }
      layer.stroke();
      layer.restore();
    };
    // The glasses sit on the face: they follow its gestures, not the gaze
    const f = this.layout.face;
    const half = ((EYE_GAP + EYE_WIDTH) / 2 + this.shape.spread.value(now) / 2) * scale;
    const gesture = this.gestureOffset(now);
    const center = { x: f.x + f.width / 2 + gesture.x * scale, y: f.y + f.height / 2 + (this.shape.y.value(now) + gesture.y) * scale };
    const glassesAlpha = this.props.glasses.value(now);
    if (glassesAlpha > 0.01) {
      const push = this.gestures.find((g) => g.kind === "glassesPush");
      const pushed = glassesPush(push ? now - push.start : GLASSES_PUSH_MS, scale);
      const g = glasses({ x: center.x - half, y: center.y }, { x: center.x + half, y: center.y }, scale, pushed.lift);
      layer.save();
      layer.globalAlpha = glassesAlpha;
      layer.lineWidth = g.line;
      layer.beginPath();
      for (const lens of g.lenses) layer.roundRect(lens.x, lens.y, lens.width, lens.height, lens.radius);
      for (const [a, b] of [g.bridge, ...g.temples]) {
        layer.moveTo(a.x, a.y);
        layer.lineTo(b.x, b.y);
      }
      layer.stroke();
      if (pushed.finger) {
        const right = g.lenses[1];
        const tip = { x: right.x + right.width + pushed.finger.x, y: right.y + right.height + pushed.finger.y };
        layer.globalAlpha = glassesAlpha * pushed.finger.alpha;
        layer.translate(tip.x, tip.y);
        layer.rotate(pushed.finger.angle);
        layer.beginPath();
        layer.roundRect(-pushed.finger.width / 2, 0, pushed.finger.width, pushed.finger.length, pushed.finger.width / 2);
        layer.fill();
      }
      layer.restore();
    }
    const squint = this.props.squintLines.value(now);
    // The doubt lines belong to the eyes: they move with them when the look goes sideways
    if (squint > 0.01) stroke(eyes.flatMap((e) => squintLines(e, scale)), squintLine(scale), squint);
    const shock = this.props.shockLines.value(now);
    if (shock > 0.01) stroke(shockLines(eyes[1], scale), shockLine(scale), shock, SHOCK_COLOR);
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
