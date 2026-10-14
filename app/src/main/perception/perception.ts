// Runs the perception sources and turns the attention module's choice into
// gaze commands for the face. Cheap sources run all the time (mouse, caret,
// foreground window, UI Automation); screen changes are diffed a few times
// per second; OCR runs only on changed regions (1-2 per second) and new text
// is "read" with a fixation sequence. Everything stays on the PC: the brain
// only gets the short summary of summary().
import type { AttentionKind, GazeCommand, Settings } from "../../shared/types";
import { log } from "../log";
import { Attention, type AttentionContext, type AttentionTarget, type Candidate } from "./attention";
import type { Change } from "./capture";
import { appName, perceptionSummary, type ReadText } from "./context";
import { pausedFor, type ForegroundWindow } from "./desktop";
import { findText, normalizeText, type TextItem } from "./grounding";
import { readingPlan, type Fixation, type ReadLine } from "./reading";
import type { UiaSnapshot } from "./uia";

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

export interface OcrLine {
  text: string;
  rect: Rect;
  words: { text: string; rect: Rect }[];
}

export interface PerceptionHost {
  settings(): Settings;
  /** Center of the face (screen DIP). */
  faceCenter(): Point;
  cursor(): Point;
  /** Where the user sits, seen from the face: bottom center of Lumi's screen. */
  userPoint(): Point;
  context(): AttentionContext;
  /** The face is shown and not being dragged. */
  active(): boolean;
  sendGaze(command: GazeCommand): void;
  /** Why perception must pause (locked, away, do not disturb), or null. */
  globalPause(): string | null;
  foreground(): ForegroundWindow | null;
  systemCaret(): Rect | null;
  /** Physical screen pixels <-> DIP. */
  toDip(rect: Rect): Rect;
  toPhysical(rect: Rect): Rect;
  /** OCR of a region of the screen (physical pixels); lines in physical pixels. */
  ocr(region: Rect): Promise<OcrLine[] | null>;
  /** Bottom-right corner where Windows shows notifications (DIP). */
  notificationArea(): Rect;
  /** The screen Lumi is on (DIP). */
  screenBounds(): Rect;
  /** Clock (ms); tests drive it, the app uses Date.now. */
  now?(): number;
}

const TICK_MS = 33;
const SLOW_MS = 400;
const CARET_MS = 50;
/** The mouse counts as moving when it travels at least this far between ticks (DIP). */
const MOUSE_STEP = 3;
/** Text read in the last minute counts as known (not new) when it shows up again. */
const KNOWN_TEXT_MS = 90_000;
const MAX_READ = 8;
/** OCR results kept to find what the model talks about (look_at). */
const SCREEN_TEXT_MS = 120_000;

export class Perception {
  readonly attention = new Attention();
  private timers: NodeJS.Timeout[] = [];
  private lastCursor: Point | null = null;
  private lastSent = "";
  private lastTargetId: string | null = null;
  private foreground: ForegroundWindow | null = null;
  private pausedReason: string | null = null;
  private uia: UiaSnapshot | null = null;
  private lastCaretKey = "";
  private readonly known = new Map<string, number>();
  private read: ReadText[] = [];
  private screenText: { item: TextItem; at: number }[] = [];
  private pendingOcr: { rect: Rect; score: number; where?: string } | null = null;
  private ocrBusy = false;
  private lastOcrAt = 0;
  private reading: { id: string; plan: Fixation[]; index: number; nextAt: number } | null = null;
  private readonly plans = new Map<string, Fixation[]>();
  private looking: string | undefined;
  private readonly listeners = new Set<(target: { kind: AttentionKind; id: string } | null) => void>();
  /** Called with every block of new text read on screen. */
  onNewText: ((text: string, where: string | undefined) => void) | null = null;
  private target: AttentionTarget | null = null;

  /** What the eyes are on now (for the debug overlay). */
  currentTarget(): AttentionTarget | null {
    return this.target;
  }

  constructor(private readonly host: PerceptionHost) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  start(): void {
    if (this.timers.length) return;
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.slowTick(), SLOW_MS));
    this.timers.push(setInterval(() => this.caretTick(), CARET_MS));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  add(candidate: Candidate): void {
    this.attention.add(candidate);
  }

  remove(id: string): void {
    this.attention.remove(id);
  }

  onTarget(listener: (target: { kind: AttentionKind; id: string } | null) => void): void {
    this.listeners.add(listener);
  }

  /** Why perception is paused right now, or null. */
  paused(): string | null {
    return this.pausedReason;
  }

  /** Perception (screen watching) is on and not paused. */
  watching(): boolean {
    return this.host.settings().perception.enabled && this.pausedReason === null;
  }

  /** The text selected in the focused element of another app, with that app's name; null when none or paused. */
  selection(): { app: string; text: string } | null {
    const text = this.uia?.selection?.trim();
    if (!this.watching() || !text || this.uia?.focus.isPassword) return null;
    return { app: this.foreground ? appName(this.foreground.process) : "", text };
  }

  /** The summary that goes into the prompt. */
  summary(): string {
    if (!this.host.settings().perception.enabled) return "";
    const f = this.uia?.focus;
    return perceptionSummary({
      now: this.now(),
      paused: this.pausedReason,
      app: this.foreground ? { process: this.foreground.process, title: this.foreground.title } : null,
      focus: f
        ? { controlType: f.controlType.replace(/Control$/, ""), name: f.name, line: this.uia?.line ?? null, selection: this.uia?.selection ?? null, isPassword: f.isPassword }
        : null,
      read: this.read,
      looking: this.looking,
    });
  }

  // ---------------- gaze ----------------

  tick(now = this.now()): void {
    if (!this.host.active()) return;
    const cursor = this.host.cursor();
    if (this.lastCursor && Math.hypot(cursor.x - this.lastCursor.x, cursor.y - this.lastCursor.y) >= MOUSE_STEP) {
      this.add({ id: "mouse", kind: "mouse", rect: { x: cursor.x, y: cursor.y, width: 1, height: 1 }, salience: 1, t: now, moving: true });
    }
    this.lastCursor = cursor;
    const context = this.host.context();
    if (context.listening || context.speaking) {
      const user = this.host.userPoint();
      this.add({ id: "user", kind: "user", rect: { x: user.x, y: user.y, width: 1, height: 1 }, salience: 1, t: now });
    }
    this.advanceReading(now);
    const target = this.attention.select(now, context);
    this.target = target;
    const face = this.host.faceCenter();
    const command: GazeCommand = target
      ? { target: { dx: Math.round(target.point.x - face.x), dy: Math.round(target.point.y - face.y) }, kind: target.kind, pursuit: target.pursuit }
      : { target: null, kind: "idle", pursuit: false };
    const id = target?.id ?? null;
    if (id !== this.lastTargetId) {
      this.lastTargetId = id;
      this.onTargetChanged(target ? { kind: target.kind, id: target.id } : null, now);
      for (const listener of this.listeners) listener(target ? { kind: target.kind, id: target.id } : null);
    }
    const key = JSON.stringify(command);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.host.sendGaze(command);
  }

  private onTargetChanged(target: { kind: AttentionKind; id: string } | null, now: number): void {
    // New text won the eyes: read it
    if (target?.kind === "text" && this.plans.has(target.id)) {
      this.reading = { id: target.id, plan: this.plans.get(target.id)!, index: 0, nextAt: now };
      this.plans.delete(target.id);
    } else if (target?.kind !== "reading" && this.reading) {
      // Something more important interrupted the reading
      this.reading = null;
      this.attention.remove("reading");
    }
  }

  private advanceReading(now: number): void {
    const r = this.reading;
    if (!r || now < r.nextAt) return;
    if (r.index >= r.plan.length) {
      this.reading = null;
      this.attention.remove("reading");
      this.attention.remove(r.id);
      return;
    }
    const f = r.plan[r.index++];
    r.nextAt = now + f.ms;
    this.add({ id: "reading", kind: "reading", rect: { x: f.x, y: f.y, width: 1, height: 1 }, point: { x: f.x, y: f.y }, salience: 1, t: now });
  }

  // ---------------- sources ----------------

  private slowTick(): void {
    const settings = this.host.settings();
    const global = this.host.globalPause();
    this.foreground = settings.perception.enabled && !global ? this.host.foreground() : null;
    let reason: string | null = null;
    if (!settings.perception.enabled) reason = "turned off by the user";
    else if (global) reason = global;
    else if (this.foreground && pausedFor(this.foreground, settings.perception.pauseInApps)) reason = "a private window or an app on the user's pause list";
    if (reason !== this.pausedReason) {
      this.pausedReason = reason;
      if (reason) this.forget();
      log.info(reason ? `Perception paused: ${reason}` : "Perception resumed");
    }
    // Old known text and screen text expire
    const now = this.now();
    for (const [text, at] of this.known) if (now - at > KNOWN_TEXT_MS) this.known.delete(text);
    this.screenText = this.screenText.filter((s) => now - s.at < SCREEN_TEXT_MS);
    void this.runOcr(now);
  }

  private caretTick(): void {
    if (!this.watching()) return;
    const caret = this.uia?.caret ? this.host.toDip(this.uia.caret) : this.host.systemCaret();
    if (!caret) return;
    const key = `${caret.x},${caret.y}`;
    if (key === this.lastCaretKey) return;
    this.lastCaretKey = key;
    // The caret moved: the user is typing there
    this.add({ id: "caret", kind: "caret", rect: caret, point: { x: caret.x + caret.width / 2, y: caret.y + caret.height / 2 }, salience: 1, t: this.now() });
  }

  /** A new UI Automation snapshot from the sidecar. */
  onUia(snapshot: UiaSnapshot): void {
    if (!this.watching()) return;
    this.uia = snapshot;
    if (snapshot.focus.isPassword) this.uia = { ...snapshot, line: null, selection: null };
  }

  /** Screen changes from the capture loop. */
  onChanges(changes: Change[]): void {
    if (!this.watching()) return;
    const now = this.now();
    const caret = this.attention.candidatesNow().find((c) => c.kind === "caret");
    const notifications = this.host.notificationArea();
    for (const change of changes) {
      // The blinking caret and the line being typed are not news
      if (caret && now - caret.t < 1500 && intersects(change.rect, inflate(caret.rect, 40))) continue;
      const big = change.coverage > 0.5;
      const salience = Math.min(1, (0.35 + Math.sqrt(change.coverage)) * change.novelty);
      if (!big) {
        this.add({ id: `change:${Math.round(change.rect.x / 64)}:${Math.round(change.rect.y / 64)}`, kind: "change", rect: change.rect, salience, t: now });
      }
      // Changed areas may contain new text: the most interesting one gets OCR
      const where = intersects(change.rect, notifications) ? "notifica" : undefined;
      const score = salience + (where ? 0.5 : 0);
      if (change.novelty > 0.3 && (!this.pendingOcr || score > this.pendingOcr.score)) this.pendingOcr = { rect: change.rect, score, where };
    }
  }

  // ---------------- reading new text ----------------

  private async runOcr(now: number): Promise<void> {
    const region = this.pendingOcr;
    const fps = this.host.settings().perception.ocrFps;
    if (!region || this.ocrBusy || now - this.lastOcrAt < 1000 / fps || !this.watching()) return;
    this.pendingOcr = null;
    this.ocrBusy = true;
    this.lastOcrAt = now;
    try {
      // A little margin: text often sits right at the edge of the changed blocks
      const physical = this.host.toPhysical(inflate(region.rect, 12));
      const lines = await this.host.ocr(physical);
      if (lines && this.watching()) this.onText(lines.map((l) => this.lineToDip(l)), region.where);
    } catch (err) {
      log.warn("OCR failed", err);
    } finally {
      this.ocrBusy = false;
    }
  }

  private lineToDip(line: OcrLine): OcrLine {
    return { text: line.text, rect: this.host.toDip(line.rect), words: line.words.map((w) => ({ text: w.text, rect: this.host.toDip(w.rect) })) };
  }

  /** Lines read by OCR (DIP): the ones not seen recently are new text. */
  onText(lines: OcrLine[], where?: string): void {
    const now = this.now();
    const fresh: OcrLine[] = [];
    for (const line of lines) {
      const key = normalizeText(line.text);
      if (key.length < 3) continue;
      this.screenText.push({ item: { text: line.text, rect: line.rect, words: line.words }, at: now });
      if (!this.known.has(key)) fresh.push(line);
      this.known.set(key, now);
    }
    if (this.screenText.length > 400) this.screenText.splice(0, this.screenText.length - 400);
    if (!fresh.length) return;
    const app = this.foreground ? this.foreground.process.replace(/\.exe$/i, "") : undefined;
    const text = fresh.map((l) => l.text).join(" ");
    log.perception(`Read: ${text}`);
    this.read = [{ text, at: now, where: where ?? app }, ...this.read].slice(0, MAX_READ);
    this.onNewText?.(text, where);
    const id = `text:${now}`;
    const rect = union(fresh.map((l) => l.rect));
    const plan = readingPlan(fresh as ReadLine[]);
    this.plans.set(id, plan);
    // Keep only the last few plans
    for (const key of [...this.plans.keys()].slice(0, -3)) this.plans.delete(key);
    const salience = Math.min(1, 0.5 + fresh.length * 0.1 + (where === "notifica" ? 0.3 : 0));
    this.add({ id, kind: "text", rect, point: { x: rect.x + Math.min(rect.width / 2, 40), y: rect.y + rect.height / 2 }, salience, t: now });
  }

  // ---------------- what Lumi talks about ----------------

  /** Looks at visible text (while saying something about it). Returns a description for the model. */
  lookAtText(text: string, holdMs = 6000): string {
    const items: TextItem[] = this.screenText.map((s) => s.item);
    const f = this.uia?.focus;
    if (f && !f.isPassword && f.rect && f.name) items.push({ text: f.name, rect: this.host.toDip(f.rect) });
    const fg = this.foreground;
    if (fg?.rect && fg.title) items.push({ text: fg.title, rect: { ...this.host.toDip(fg.rect), height: 32 } });
    const match = findText(text, items);
    if (!match) {
      if (fg?.rect) {
        this.focusOn(this.host.toDip(fg.rect), "the active window", holdMs);
        return `"${text}" is not among the text you can read: looking at the active window instead.`;
      }
      return `"${text}" is not among the text you can read on screen.`;
    }
    this.focusOn(match.rect, `"${match.text.slice(0, 80)}"`, holdMs);
    return `Looking at "${match.text.slice(0, 120)}".`;
  }

  /** Looks at a region of the screen. */
  lookAtRegion(region: string, holdMs = 5000): string {
    const user = this.host.userPoint();
    const fg = this.foreground;
    switch (region) {
      case "user":
        this.focusOn({ x: user.x, y: user.y, width: 1, height: 1 }, "the user", holdMs);
        return "Looking at the user.";
      case "cursor": {
        const c = this.host.cursor();
        this.focusOn({ x: c.x, y: c.y, width: 1, height: 1 }, "the mouse pointer", holdMs);
        return "Looking at the mouse pointer.";
      }
      case "caret": {
        const caret = this.attention.candidatesNow().find((c) => c.kind === "caret");
        if (!caret) return "There is no text cursor to look at.";
        this.focusOn(caret.rect, "the text cursor", holdMs);
        return "Looking at the text cursor.";
      }
      case "active_window":
        if (!fg?.rect) return "There is no active window to look at.";
        this.focusOn(this.host.toDip(fg.rect), "the active window", holdMs);
        return "Looking at the active window.";
      default: {
        const b = this.host.screenBounds();
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const points: Record<string, Point> = {
          top: { x: cx, y: b.y + 80 },
          bottom: { x: cx, y: b.y + b.height - 80 },
          left: { x: b.x + 80, y: cy },
          right: { x: b.x + b.width - 80, y: cy },
          center: { x: cx, y: cy },
        };
        const point = points[region] ?? points.center;
        this.focusOn({ x: point.x, y: point.y, width: 1, height: 1 }, `the ${region} of the screen`, holdMs);
        return `Looking at the ${region} of the screen.`;
      }
    }
  }

  /** Forgets everything read (perception paused or turned off). */
  forget(): void {
    this.read = [];
    this.screenText = [];
    this.known.clear();
    this.plans.clear();
    this.reading = null;
    this.uia = null;
    this.pendingOcr = null;
    for (const kind of ["caret", "change", "text", "reading"] as const) this.attention.clear(kind);
  }

  private focusOn(rect: Rect, label: string, holdMs: number): void {
    this.looking = label;
    this.add({ id: "speaking", kind: "speaking", rect, point: { x: rect.x + Math.min(rect.width / 2, 60), y: rect.y + rect.height / 2 }, salience: 1, t: this.now() });
    setTimeout(() => {
      if (this.looking === label) this.looking = undefined;
    }, holdMs);
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

function union(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
