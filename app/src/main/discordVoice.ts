// Lumi's voice in Discord calls: starts the bot (src/discord/bot.ts) in an
// Electron utility process, keeps its token (DPAPI, like the API keys, or
// DISCORD_BOT_TOKEN) and forwards Lumi's audio while the bot sits in the
// user's voice channel. Meanwhile the face window keeps "playing" muted, so
// the eyes, the timing and barge-in work as usual, and the user hears Lumi
// in Discord like everybody else.
import { safeStorage, utilityProcess, type UtilityProcess } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AudioBegin } from "../shared/types";
import { log } from "./log";

export type DiscordState = "off" | "connecting" | "online" | "in-channel" | "error";

export interface DiscordStatus {
  state: DiscordState;
  /** Channel name, or what went wrong. */
  detail: string;
}

export class DiscordToken {
  constructor(private readonly file: string) {}

  get(): string | null {
    const env = process.env.DISCORD_BOT_TOKEN?.trim();
    if (env) return env;
    if (!existsSync(this.file) || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(readFileSync(this.file)) || null;
    } catch {
      return null;
    }
  }

  source(): "env" | "saved" | "none" {
    if (process.env.DISCORD_BOT_TOKEN?.trim()) return "env";
    return existsSync(this.file) ? "saved" : "none";
  }

  /** An empty token removes the saved one. */
  set(token: string): void {
    const clean = token.trim();
    if (!clean) {
      rmSync(this.file, { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows non permette di cifrare il token su questo account");
    writeFileSync(this.file, safeStorage.encryptString(clean));
  }
}

export class DiscordVoice {
  private child: UtilityProcess | null = null;
  private wanted: { token: string; userId: string } | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts = 0;
  private stateNow: DiscordStatus = { state: "off", detail: "" };
  /** Utterances that began while the bot was in a channel: only those are forwarded. */
  private readonly forwarding = new Set<number>();

  constructor(
    private readonly script: string,
    private readonly onStatus: (status: DiscordStatus) => void,
  ) {}

  status(): DiscordStatus {
    return this.stateNow;
  }

  /** Lumi's voice goes to Discord now (the bot is in the user's channel). */
  live(): boolean {
    return this.stateNow.state === "in-channel";
  }

  /** Runs the bot with this token for this user (null: stops it; `missing` says why it can't run). */
  configure(config: { token: string; userId: string } | null, missing = ""): void {
    if (JSON.stringify(config) === JSON.stringify(this.wanted) && (config || this.stateNow.detail === missing)) return;
    this.wanted = config;
    this.restarts = 0;
    if (!config) {
      this.post({ type: "stop" });
      this.kill();
      this.setStatus(missing ? { state: "error", detail: missing } : { state: "off", detail: "" });
      return;
    }
    this.spawn();
    this.post({ type: "start", ...config });
  }

  begin(msg: AudioBegin): void {
    if (!this.live()) return;
    this.forwarding.add(msg.id);
    this.post({ type: "begin", id: msg.id, volume: msg.volume });
  }

  chunk(id: number, pcm: Uint8Array, rate: number): void {
    if (this.forwarding.has(id)) this.post({ type: "audio", id, pcm, rate });
  }

  end(id: number): void {
    if (this.forwarding.delete(id)) this.post({ type: "end", id });
  }

  /** Barge-in: silence at once. */
  cut(): void {
    this.forwarding.clear();
    this.post({ type: "cut" });
  }

  dispose(): void {
    this.wanted = null;
    this.post({ type: "stop" });
    // Give the bot a moment to leave the channel cleanly
    setTimeout(() => this.kill(), 1000);
  }

  private spawn(): void {
    if (this.child) return;
    if (!existsSync(this.script)) {
      this.setStatus({ state: "error", detail: `manca ${this.script}` });
      return;
    }
    const child = utilityProcess.fork(this.script, [], { serviceName: "Lumi Discord", stdio: "pipe" });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => log.info(`[discord] ${d.toString().trim()}`));
    child.stderr?.on("data", (d: Buffer) => log.warn(`[discord] ${d.toString().trim()}`));
    child.on("message", (m: { type: string; state?: DiscordState; detail?: string; level?: string; message?: string }) => {
      if (m.type === "status" && m.state) this.setStatus({ state: m.state, detail: m.detail ?? "" });
      else if (m.type === "log" && m.message) (m.level === "warn" ? log.warn : log.info)(`Discord: ${m.message}`);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.forwarding.clear();
      if (!this.wanted) return;
      log.warn(`The Discord bot process exited (${code}); restarting`);
      this.setStatus({ state: "error", detail: "il processo del bot si è chiuso" });
      const delay = Math.min(60_000, 2000 * 2 ** this.restarts++);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.wanted) return;
        this.spawn();
        this.post({ type: "start", ...this.wanted });
      }, delay);
    });
  }

  private kill(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.forwarding.clear();
    child?.kill();
  }

  private post(message: unknown): void {
    this.child?.postMessage(message);
  }

  private setStatus(next: DiscordStatus): void {
    if (next.state === this.stateNow.state && next.detail === this.stateNow.detail) return;
    if (next.state !== "in-channel") this.forwarding.clear();
    this.stateNow = next;
    log.info(`Discord voice: ${next.state}${next.detail ? ` (${next.detail})` : ""}`);
    this.onStatus(next);
  }
}

export function botScript(appDir: string): string {
  return join(appDir, "dist", "discord", "bot.js");
}
