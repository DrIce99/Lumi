// The command bar: a text field over everything, opened with a global
// shortcut. The window is created hidden at startup so it opens instantly;
// it sits centered at ~30% of the height of the monitor under the mouse,
// grows with the text, and gives the focus back to the previous window when
// it closes. Windows 11 (22H2+) draws it with the acrylic material and
// rounded corners; Windows 10 gets a transparent window with a dark panel.
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type Rectangle } from "electron";
import { release } from "node:os";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import type { BarContext, BarOpen } from "../shared/types";
import { readJson, writeJson } from "./jsonStore";
import { log } from "./log";
import { focusWindow, foregroundHandle, roundCorners } from "./perception/desktop";

export const BAR_WIDTH = 640;
const MIN_HEIGHT = 56;
const MAX_HEIGHT = 480;
export const HISTORY_SIZE = 50;
const FADE_MS = 140;

/** Where the bar goes on a monitor's work area: centered, its top at 30% of the height. */
export function barPosition(workArea: Rectangle, width = BAR_WIDTH): { x: number; y: number } {
  return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + workArea.height * 0.3) };
}

/** The prompt history after sending `text`: no duplicates (the new one moves to the end), at most HISTORY_SIZE. */
export function pushHistory(history: string[], text: string): string[] {
  const t = text.trim();
  if (!t) return history;
  return [...history.filter((h) => h !== t), t].slice(-HISTORY_SIZE);
}

/** The acrylic material needs Windows 11 22H2 (build 22621) or later; `osRelease` as from os.release(). */
export function supportsAcrylic(osRelease: string, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  const build = Number(osRelease.split(".")[2]);
  return Number.isFinite(build) && build >= 22621;
}

export interface CommandBarHost {
  /** The text selected in another app right now, when the setting allows it. */
  context(): BarContext | null;
  submit(msg: { text: string; context: BarContext | null; files: string[] }): void;
  /** The bar is shown at `rect` (screen DIP) or hidden (null); `typing` refreshes the eyes' interest. */
  gaze(rect: Rectangle | null): void;
}

export class CommandBar {
  readonly win: BrowserWindow;
  private shown = false;
  private previous: unknown = null;
  private context: BarContext | null = null;
  private history: string[];
  private height = MIN_HEIGHT;
  private fadeTimer: NodeJS.Timeout | null = null;
  private readonly acrylic = supportsAcrylic(release());

  constructor(
    private readonly host: CommandBarHost,
    url: string,
    private readonly historyFile: string,
  ) {
    const loaded = readJson<{ history?: unknown }>(historyFile);
    this.history = Array.isArray(loaded?.history) ? loaded.history.filter((h): h is string => typeof h === "string").slice(-HISTORY_SIZE) : [];
    this.win = new BrowserWindow({
      width: BAR_WIDTH,
      height: MIN_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "Lumi",
      transparent: !this.acrylic,
      backgroundColor: "#00000000",
      ...(this.acrylic ? { backgroundMaterial: "acrylic" as const } : {}),
      webPreferences: {
        preload: join(__dirname, "../preload/commandbar.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    // Out of screen captures, like the face, until main applies face.showInCaptures
    this.win.setContentProtection(true);
    if (this.acrylic) roundCorners(this.win.getNativeWindowHandle());
    this.win.setMenu(null);
    // A file dropped outside the drop handlers must not replace the page
    this.win.webContents.on("will-navigate", (event) => event.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") log.warn(`[command bar] ${event.message}`);
    });
    void this.win.loadURL(`${url}${this.acrylic ? "?acrylic" : ""}`);

    const on = (channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void) =>
      ipcMain.on(channel, (event, ...args) => {
        if (event.sender === this.win.webContents) fn(event, ...args);
      });
    on(IPC.barCancel, () => this.close());
    on(IPC.barResize, (_e, height) => {
      if (typeof height === "number" && Number.isFinite(height)) this.resize(height);
    });
    on(IPC.barTyping, () => {
      if (this.shown) this.host.gaze(this.win.getBounds());
    });
    on(IPC.barSubmit, (_e, raw) => {
      const msg = (raw ?? {}) as { text?: unknown; useContext?: unknown; files?: unknown };
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 8000) : "";
      const files = Array.isArray(msg.files) ? msg.files.filter((f): f is string => typeof f === "string").slice(0, 20) : [];
      if (!text && !files.length) return;
      if (text) {
        this.history = pushHistory(this.history, text);
        try {
          writeJson(this.historyFile, { history: this.history });
        } catch (err) {
          log.warn("Saving the command bar history failed", err);
        }
      }
      const context = msg.useContext === true ? this.context : null;
      this.close();
      this.host.submit({ text, context, files });
    });
  }

  isOpen(): boolean {
    return this.shown;
  }

  toggle(): void {
    if (this.shown) this.close();
    else this.open();
  }

  open(): void {
    if (this.shown || this.win.isDestroyed()) return;
    // Read before the bar takes the focus: the window and selection the user was in
    this.previous = foregroundHandle();
    this.context = this.host.context();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y } = barPosition(display.workArea);
    this.height = MIN_HEIGHT;
    this.win.setBounds({ x, y, width: BAR_WIDTH, height: this.height });
    const msg: BarOpen = { context: this.context, history: this.history };
    this.win.webContents.send(IPC.barOpen, msg);
    this.shown = true;
    this.win.setOpacity(0);
    this.win.show();
    this.win.focus();
    this.fade(1);
    this.host.gaze(this.win.getBounds());
  }

  /** Hides the bar; the window the user was in gets the focus back. */
  close(): void {
    if (!this.shown || this.win.isDestroyed()) return;
    this.shown = false;
    const hadFocus = this.win.isFocused();
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.win.hide();
    this.win.webContents.send(IPC.barClose);
    this.host.gaze(null);
    if (hadFocus) focusWindow(this.previous);
    this.previous = null;
  }

  private resize(height: number): void {
    const h = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    if (h === this.height) return;
    this.height = h;
    const b = this.win.getBounds();
    this.win.setBounds({ x: b.x, y: b.y, width: BAR_WIDTH, height: h });
    if (this.shown) this.host.gaze(this.win.getBounds());
  }

  /** Window opacity ramp; the page animates its content (scale 0.96 -> 1) at the same time. */
  private fade(to: number): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    const start = Date.now();
    this.fadeTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / FADE_MS);
      if (!this.win.isDestroyed()) this.win.setOpacity(t * to);
      if (t >= 1 && this.fadeTimer) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
    }, 16);
  }
}
