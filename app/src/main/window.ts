// The transparent, frameless, always-on-top window the face lives in. It is
// click-through except over the eyes (hit test in the renderer), it can be
// dragged anywhere, and it is excluded from screen captures and sharing.
// Besides the face it has room for a speech bubble and the chat box, above
// the eyes or, near the top of the screen, below them.
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type Rectangle } from "electron";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import {
  FACE_HEIGHT,
  FACE_WIDTH,
  type AudioBegin,
  type AudioChunk,
  type BubbleChunk,
  type BubbleEnd,
  type BubbleStart,
  type FaceContrast,
  type FaceGesture,
  type FaceLayout,
  type FaceState,
  type GazeCommand,
  type MicControl,
  type MicEvent,
  type PlaybackEvent,
} from "../shared/types";
import { clampAnchor, computeLayout, type Point } from "./layout";
import { flightMs, pathPoint, velocityAt, type MoveStyle } from "./motion/path";
import { log } from "./log";

export type { Point } from "./layout";

export interface FaceWindowHandlers {
  ready(): void;
  click(): void;
  contextMenu(): void;
  send(text: string): void;
  inputClosed(): void;
  bubbleClicked(): void;
  bubbleChoice(bubbleId: number, choice: string): void;
  playback(event: PlaybackEvent): void;
  mic(event: MicEvent): void;
  /** The face is somewhere else: dropped by the user (`byUser`), or arrived after a flight. */
  moved(anchor: { x: number; y: number }, byUser: boolean): void;
}

export class FaceWindow {
  readonly win: BrowserWindow;
  private inputOpen = false;
  private anchor: Point;
  private scale: number;
  private color: string;
  private layout: FaceLayout;
  private drag: { dx: number; dy: number; timer: NodeJS.Timeout } | null = null;
  private lastContrast: FaceContrast | null = null;
  private flight: { timer: NodeJS.Timeout; done: (arrived: boolean) => void } | null = null;
  /** A flight between monitors with different scales: fading out, jumping, fading in. */
  private fading = false;

  constructor(
    private readonly handlers: FaceWindowHandlers,
    options: { url: string; anchor: Point | null; scale: number; color: string },
  ) {
    this.scale = options.scale;
    this.color = options.color;
    this.anchor = this.validAnchor(options.anchor);
    const { bounds, layout } = this.compute();
    this.layout = layout;
    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Clicking the eyes must not steal focus from the user's work; the
      // window becomes focusable only while the chat box is open.
      focusable: false,
      title: "Lumi",
      webPreferences: {
        preload: join(__dirname, "../preload/face.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
        // The voice must play even though the window never gets a user gesture
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true, { forward: true });
    // Keeps the face out of screen captures and screen sharing until main applies
    // the user's choice (face.showInCaptures)
    this.win.setContentProtection(true);
    this.win.once("ready-to-show", () => {
      this.win.showInactive();
      log.info(`Face window shown at ${JSON.stringify(this.win.getBounds())}`);
    });
    const contents = this.win.webContents;
    contents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") log.warn(`[face window] ${event.message}`);
    });
    contents.on("preload-error", (_event, preloadPath, error) => log.error(`Preload ${preloadPath} failed`, error));
    contents.on("render-process-gone", (_event, details) => log.error(`Face renderer gone: ${details.reason}`));
    void this.win.loadURL(options.url);

    const on = (channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void) =>
      ipcMain.on(channel, (event, ...args) => {
        if (event.sender === this.win.webContents) fn(event, ...args);
      });
    on(IPC.ready, () => {
      this.sendLayout();
      if (this.lastContrast) this.send(IPC.contrast, this.lastContrast);
      handlers.ready();
    });
    on(IPC.interactive, (_e, interactive) => this.win.setIgnoreMouseEvents(interactive !== true, { forward: true }));
    on(IPC.click, () => handlers.click());
    on(IPC.dragStart, () => this.startDrag());
    on(IPC.dragEnd, () => this.endDrag());
    on(IPC.contextMenu, () => handlers.contextMenu());
    on(IPC.send, (_e, text) => {
      if (typeof text === "string" && text.trim()) handlers.send(text.trim().slice(0, 4000));
    });
    on(IPC.closeInput, () => {
      this.releaseFocus();
      handlers.inputClosed();
    });
    on(IPC.bubbleClicked, () => handlers.bubbleClicked());
    on(IPC.bubbleChoice, (_e, id, choice) => {
      if (typeof id === "number" && typeof choice === "string") handlers.bubbleChoice(id, choice);
    });
    on(IPC.playback, (_e, event) => {
      if (event && typeof event === "object") handlers.playback(event as PlaybackEvent);
    });
    on(IPC.mic, (_e, event) => {
      if (event && typeof event === "object") handlers.mic(event as MicEvent);
    });
  }

  /** Center of the face in screen DIP. */
  faceCenter(): Point {
    const f = this.layout.face;
    const b = this.win.getBounds();
    return { x: b.x + f.x + f.width / 2, y: b.y + f.y + f.height / 2 };
  }

  /** The face box in screen DIP. */
  faceRect(): Rectangle {
    const f = this.layout.face;
    const b = this.win.getBounds();
    return { x: b.x + f.x, y: b.y + f.y, width: f.width, height: f.height };
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  /** Flying to a new place (not dragged by the user). */
  isMoving(): boolean {
    return this.flight !== null || this.fading;
  }

  /** The face's size now (DIP). */
  faceSize(): { width: number; height: number } {
    return { width: FACE_WIDTH * this.scale, height: FACE_HEIGHT * this.scale };
  }

  /**
   * Flies the face to `target` (its new top-left corner, screen DIP), moving
   * the window at 60 Hz like a drag does. Between monitors with different
   * scales it fades out and in instead (a window across two DPIs gets
   * resized by Windows). `done(true)` on arrival, `done(false)` when
   * interrupted (a drag, another flight).
   */
  flyTo(target: Point, style: MoveStyle, done: (arrived: boolean) => void = () => undefined): void {
    this.stopFlight();
    if (this.drag) return done(false);
    const to = this.validAnchor(target);
    const from = { ...this.anchor };
    const displayOf = (p: Point) => screen.getDisplayNearestPoint({ x: Math.round(p.x + (FACE_WIDTH * this.scale) / 2), y: Math.round(p.y + (FACE_HEIGHT * this.scale) / 2) });
    const a = displayOf(from);
    const b = displayOf(to);
    if (a.id !== b.id && a.scaleFactor !== b.scaleFactor) return this.fadeTo(to, done);
    const duration = Math.max(1, flightMs(from, to, style));
    const start = Date.now();
    const timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / duration);
      this.anchor = pathPoint(from, to, t, style);
      this.applyBounds();
      const v = velocityAt(from, to, t, style);
      this.send(IPC.travel, { vx: v.vx, vy: v.vy, landed: false });
      if (t >= 1) this.finishFlight(true);
    }, 16);
    this.flight = { timer, done };
  }

  /** Stops a flight where it is (the user grabbed the face). */
  stopFlight(): void {
    if (this.flight) this.finishFlight(false);
  }

  private finishFlight(arrived: boolean): void {
    const flight = this.flight;
    if (!flight) return;
    clearInterval(flight.timer);
    this.flight = null;
    this.send(IPC.travel, { vx: 0, vy: 0, landed: arrived });
    if (arrived) {
      this.anchor = this.validAnchor(this.anchor);
      this.applyBounds();
      this.handlers.moved(this.anchor, false);
    }
    flight.done(arrived);
  }

  private fadeTo(to: Point, done: (arrived: boolean) => void): void {
    this.fading = true;
    const steps = 8;
    let i = 0;
    const out = setInterval(() => {
      this.win.setOpacity(Math.max(0, 1 - ++i / steps));
      if (i < steps) return;
      clearInterval(out);
      this.anchor = to;
      this.applyBounds();
      let j = 0;
      const back = setInterval(() => {
        this.win.setOpacity(Math.min(1, ++j / steps));
        if (j < steps) return;
        clearInterval(back);
        this.fading = false;
        this.send(IPC.travel, { vx: 0, vy: 0, landed: true });
        this.handlers.moved(this.anchor, false);
        done(true);
      }, 18);
    }, 18);
  }

  setAppearance(scale: number, color: string): void {
    // Keep the face centered on the same point when it grows or shrinks
    const center = this.faceCenter();
    this.scale = scale;
    this.color = color;
    this.anchor = this.validAnchor({ x: center.x - (FACE_WIDTH * scale) / 2, y: center.y - (FACE_HEIGHT * scale) / 2 });
    this.applyBounds();
  }

  /** Screens were added, removed or rearranged. */
  displaysChanged(): void {
    this.anchor = this.validAnchor(this.anchor);
    this.applyBounds();
  }

  getAnchor(): Point {
    return { ...this.anchor };
  }

  isInputOpen(): boolean {
    return this.inputOpen;
  }

  openInput(): void {
    if (!this.win.isVisible()) this.win.showInactive();
    this.inputOpen = true;
    this.win.setFocusable(true);
    this.win.focus();
    this.send(IPC.inputOpen);
  }

  closeInput(): void {
    this.send(IPC.inputClose);
    this.releaseFocus();
  }

  state(state: FaceState): void {
    this.send(IPC.state, state);
  }

  gaze(gaze: GazeCommand): void {
    this.send(IPC.gaze, gaze);
  }

  gesture(gesture: FaceGesture): void {
    this.send(IPC.gesture, gesture);
  }

  /** Dazzled by a screen that turned bright; `lightDx`: the light's horizontal distance from the face center (DIP). */
  glare(lightDx: number): void {
    this.send(IPC.glare, { lightDx });
  }

  /** Shadow and border under the eyes; sent only when they change. */
  contrast(contrast: FaceContrast): void {
    const last = this.lastContrast;
    if (last && last.shadow === contrast.shadow && last.border === contrast.border) return;
    this.lastContrast = contrast;
    this.send(IPC.contrast, contrast);
  }

  bubbleStart(msg: BubbleStart): void {
    this.send(IPC.bubbleStart, msg);
  }

  bubbleChunk(msg: BubbleChunk): void {
    this.send(IPC.bubbleChunk, msg);
  }

  bubbleEnd(msg: BubbleEnd): void {
    this.send(IPC.bubbleEnd, msg);
  }

  bubbleHide(): void {
    this.send(IPC.bubbleHide);
  }

  audioBegin(msg: AudioBegin): void {
    this.send(IPC.audioBegin, msg);
  }

  audioChunk(msg: AudioChunk): void {
    this.send(IPC.audioChunk, msg);
  }

  audioEnd(id: number): void {
    this.send(IPC.audioEnd, { id });
  }

  audioStop(fadeMs: number): void {
    this.send(IPC.audioStop, { fadeMs });
  }

  /** Lumi's voice through the speakers, or muted here because it goes to a Discord call. */
  audioLocal(local: boolean): void {
    this.send(IPC.audioLocal, { local });
  }

  micControl(control: MicControl): void {
    this.send(IPC.micControl, control);
  }

  private validAnchor(anchor: Point | null): Point {
    const fallback = () => {
      const area = screen.getPrimaryDisplay().workArea;
      return { x: area.x + area.width - FACE_WIDTH * this.scale - 40, y: area.y + area.height - FACE_HEIGHT * this.scale - 30 };
    };
    const point = anchor ?? fallback();
    const display = screen.getDisplayNearestPoint({
      x: Math.round(point.x + (FACE_WIDTH * this.scale) / 2),
      y: Math.round(point.y + (FACE_HEIGHT * this.scale) / 2),
    });
    return clampAnchor(point, this.scale, display.workArea);
  }

  private compute(): { bounds: Rectangle; layout: FaceLayout } {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(this.anchor.x + (FACE_WIDTH * this.scale) / 2),
      y: Math.round(this.anchor.y + (FACE_HEIGHT * this.scale) / 2),
    });
    return computeLayout(this.anchor, this.scale, this.color, display.workArea);
  }

  private applyBounds(): void {
    const { bounds, layout } = this.compute();
    const changed = JSON.stringify(layout) !== JSON.stringify(this.layout);
    this.layout = layout;
    this.win.setBounds(bounds);
    if (changed) this.sendLayout();
  }

  private sendLayout(): void {
    this.send(IPC.layout, this.layout);
  }

  private startDrag(): void {
    if (this.drag) return;
    // The user's hand wins over a flight
    this.stopFlight();
    const cursor = screen.getCursorScreenPoint();
    this.drag = {
      dx: cursor.x - this.anchor.x,
      dy: cursor.y - this.anchor.y,
      timer: setInterval(() => {
        if (!this.drag) return;
        const now = screen.getCursorScreenPoint();
        this.anchor = { x: now.x - this.drag.dx, y: now.y - this.drag.dy };
        this.applyBounds();
      }, 16),
    };
  }

  private endDrag(): void {
    if (!this.drag) return;
    clearInterval(this.drag.timer);
    this.drag = null;
    this.anchor = this.validAnchor(this.anchor);
    this.applyBounds();
    this.handlers.moved(this.anchor, true);
  }

  private releaseFocus(): void {
    if (!this.inputOpen) return;
    this.inputOpen = false;
    this.win.setFocusable(false);
    this.win.blur();
  }

  private send(channel: string, payload?: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}
