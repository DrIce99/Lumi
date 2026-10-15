// Settings window and its IPC handlers.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import { isProvider, type ProviderId } from "../shared/providers";
import { PROFILES, VISION_PROVIDERS, type ConnectionReport, type ForgetCandidate, type Profile, type SettingsSnapshot, type SidecarStatus, type VisionProvider } from "../shared/types";
import { log } from "./log";

export interface SettingsBackend {
  snapshot(): SettingsSnapshot;
  save(settings: unknown, keys: Partial<Record<ProviderId, string>>): SettingsSnapshot;
  testConnection(): Promise<ConnectionReport[]>;
  listModels(provider: ProviderId): Promise<{ ok: boolean; models: string[]; message: string }>;
  listVisionModels(provider: VisionProvider): Promise<{ ok: boolean; models: string[]; message: string }>;
  testVoice(text: string): Promise<ConnectionReport>;
  applyProfile(profile: Profile): SettingsSnapshot;
  pickVoiceFile(window: BrowserWindow): Promise<string | null>;
  forgetMemory(id: string): SettingsSnapshot;
  clearMemory(): SettingsSnapshot;
  forgetVoice(id: string): SettingsSnapshot;
  setDiscordToken(token: string): SettingsSnapshot;
  openDataFolder(): void;
  restartSidecar(): Promise<SettingsSnapshot>;
  findForget(query: string): Promise<ForgetCandidate[]>;
  forgetItems(selection: { messages: number[]; summaries: number[]; facts: number[] }): Promise<{ ok: boolean; message: string; snapshot: SettingsSnapshot }>;
}

/** Only lists of positive integers get through to the forget cascade. */
function idList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 5000) : [];
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
    handle(IPC.settingsListVisionModels, (provider) => {
      if (!(VISION_PROVIDERS as readonly unknown[]).includes(provider)) throw new Error("Unknown provider");
      return backend.listVisionModels(provider as VisionProvider);
    });
    handle(IPC.settingsTestVoice, (text) => backend.testVoice(typeof text === "string" ? text.slice(0, 500) : ""));
    handle(IPC.settingsProfile, (profile) => {
      if (!(PROFILES as readonly unknown[]).includes(profile)) throw new Error("Unknown profile");
      return backend.applyProfile(profile as Profile);
    });
    handle(IPC.settingsPickVoice, () => backend.pickVoiceFile(this.win!));
    handle(IPC.settingsForget, (id) => backend.forgetMemory(String(id)));
    handle(IPC.settingsClear, () => backend.clearMemory());
    handle(IPC.settingsForgetVoice, (id) => backend.forgetVoice(String(id)));
    handle(IPC.settingsDiscordToken, (token) => backend.setDiscordToken(String(token ?? "")));
    handle(IPC.settingsOpenData, () => backend.openDataFolder());
    handle(IPC.settingsRestartSidecar, () => backend.restartSidecar());
    handle(IPC.settingsFindForget, (query) => backend.findForget(typeof query === "string" ? query.slice(0, 300) : ""));
    handle(IPC.settingsForgetItems, (selection) => {
      const s = (selection ?? {}) as Record<string, unknown>;
      return backend.forgetItems({ messages: idList(s.messages), summaries: idList(s.summaries), facts: idList(s.facts) });
    });
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

  /**
   * Opens the Memory tab on the forget list for `query` (Lumi was asked to
   * forget something): the user chooses and confirms there.
   */
  openForget(query: string): void {
    const send = () => this.win?.webContents.send(IPC.settingsForgetQuery, query);
    if (this.win) {
      this.open();
      send();
      return;
    }
    this.open("memory");
    this.win!.webContents.once("did-finish-load", () => setTimeout(send, 300));
  }

  /** The window, for capturing it in debug mode. */
  window(): BrowserWindow | null {
    return this.win;
  }
}
