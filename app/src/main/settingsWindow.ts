// Settings window and its IPC handlers.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import { isProvider, type ProviderId } from "../shared/providers";
import { PROFILES, type ConnectionReport, type Profile, type SettingsSnapshot, type SidecarStatus } from "../shared/types";
import { log } from "./log";

export interface SettingsBackend {
  snapshot(): SettingsSnapshot;
  save(settings: unknown, keys: Partial<Record<ProviderId, string>>): SettingsSnapshot;
  testConnection(): Promise<ConnectionReport[]>;
  listModels(provider: ProviderId): Promise<{ ok: boolean; models: string[]; message: string }>;
  testVoice(text: string): Promise<ConnectionReport>;
  applyProfile(profile: Profile): SettingsSnapshot;
  pickVoiceFile(window: BrowserWindow): Promise<string | null>;
  forgetFact(id: string): SettingsSnapshot;
  clearMemory(): SettingsSnapshot;
  openDataFolder(): void;
  restartSidecar(): Promise<SettingsSnapshot>;
}

export class SettingsWindow {
  private win: BrowserWindow | null = null;

  constructor(
    backend: SettingsBackend,
    private readonly url: string,
  ) {
    const handle = <T>(channel: string, fn: (...args: unknown[]) => T) =>
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!this.win || event.sender !== this.win.webContents) throw new Error("Not allowed");
        return fn(...args);
      });
    handle(IPC.settingsLoad, () => backend.snapshot());
    handle(IPC.settingsSave, (settings, keys) => {
      // Only well-formed key changes get through: provider id -> string
      const changes: Partial<Record<ProviderId, string>> = {};
      if (keys && typeof keys === "object") {
        for (const [id, value] of Object.entries(keys)) if (isProvider(id) && typeof value === "string") changes[id] = value;
      }
      return backend.save(settings, changes);
    });
    handle(IPC.settingsTest, () => backend.testConnection());
    handle(IPC.settingsListModels, (provider) => {
      if (!isProvider(provider)) throw new Error("Unknown provider");
      return backend.listModels(provider);
    });
    handle(IPC.settingsTestVoice, (text) => backend.testVoice(typeof text === "string" ? text.slice(0, 500) : ""));
    handle(IPC.settingsProfile, (profile) => {
      if (!(PROFILES as readonly unknown[]).includes(profile)) throw new Error("Unknown profile");
      return backend.applyProfile(profile as Profile);
    });
    handle(IPC.settingsPickVoice, () => backend.pickVoiceFile(this.win!));
    handle(IPC.settingsForget, (id) => backend.forgetFact(String(id)));
    handle(IPC.settingsClear, () => backend.clearMemory());
    handle(IPC.settingsOpenData, () => backend.openDataFolder());
    handle(IPC.settingsRestartSidecar, () => backend.restartSidecar());
  }

  isOpen(): boolean {
    return this.win !== null;
  }

  /** Pushes the voice engines' status to the open window. */
  status(status: SidecarStatus): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IPC.settingsStatus, status);
  }

  open(tab?: string): void {
    if (this.win) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 820,
      height: 780,
      minWidth: 600,
      minHeight: 520,
      title: "Impostazioni - Lumi",
      backgroundColor: "#16161c",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/settings.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win.setMenu(null);
    this.win.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") log.warn(`[settings window] ${event.message}`);
    });
    this.win.once("ready-to-show", () => this.win?.show());
    this.win.on("closed", () => {
      this.win = null;
    });
    void this.win.loadURL(tab ? `${this.url}#${tab}` : this.url);
  }

  /** The window, for capturing it in debug mode. */
  window(): BrowserWindow | null {
    return this.win;
  }
}
