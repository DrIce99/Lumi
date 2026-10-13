// LUMI_DEBUG_GAZE=1: a transparent, click-through window over Lumi's screen
// that draws the attention candidates (by kind) and the gaze target. It is
// excluded from captures like the face, so it doesn't feed the change
// detection.
import { BrowserWindow, type Rectangle } from "electron";
import { join } from "node:path";
import type { Candidate } from "./perception/attention";
import { score } from "./perception/attention";
import type { Perception } from "./perception/perception";

export interface DebugFrame {
  bounds: Rectangle;
  candidates: { rect: Rectangle; kind: string; score: number; id: string }[];
  target: { x: number; y: number; kind: string } | null;
}

export class GazeOverlay {
  private readonly win: BrowserWindow;
  private readonly timer: NodeJS.Timeout;

  constructor(
    url: string,
    private readonly perception: Perception,
    private readonly bounds: () => Rectangle,
    private readonly context: () => { listening: boolean; speaking: boolean },
  ) {
    const b = bounds();
    this.win = new BrowserWindow({
      ...b,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      show: false,
      webPreferences: { preload: join(__dirname, "../preload/debug.js"), contextIsolation: true, sandbox: true },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true);
    this.win.setContentProtection(true);
    this.win.once("ready-to-show", () => this.win.showInactive());
    void this.win.loadURL(url);
    this.timer = setInterval(() => this.send(), 100);
  }

  dispose(): void {
    clearInterval(this.timer);
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private send(): void {
    if (this.win.isDestroyed()) return;
    const now = Date.now();
    const context = this.context();
    const b = this.bounds();
    const current = this.win.getBounds();
    if (current.x !== b.x || current.y !== b.y || current.width !== b.width || current.height !== b.height) this.win.setBounds(b);
    const candidates = this.perception.attention.candidatesNow().map((c: Candidate) => ({ rect: c.rect, kind: c.kind, score: score(c, now, context), id: c.id }));
    const target = this.perception.currentTarget();
    const frame: DebugFrame = { bounds: b, candidates, target: target ? { ...target.point, kind: target.kind } : null };
    this.win.webContents.send("debug:gaze", frame);
  }
}
