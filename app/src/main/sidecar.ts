// The Python sidecar: speech recognition, speech synthesis, OCR and UI
// Automation. Electron starts it on 127.0.0.1 with a random port and a
// token, polls /health, restarts it with a growing delay when it crashes,
// and the app falls back to text mode while it is down.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { EngineStatus, GpuInfo, SidecarStatus } from "../shared/types";
import { bindToLumi } from "./jobObject";
import { log } from "./log";

export interface SidecarEndpoint {
  url: string;
  token: string;
}

export interface SidecarOptions {
  /** The sidecar folder (with server.py and its .venv). */
  dir: string;
  modelsDir: string;
  logDir: string;
  /** LUMI_SIDECAR_URL: use a sidecar started by hand. */
  externalUrl?: string;
  externalToken?: string;
}

interface Health {
  ok: boolean;
  engines: EngineStatus[];
  gpu: GpuInfo | null;
  installed: string[];
}

const START_TIMEOUT_MS = 120_000;
const HEALTH_EVERY_MS = 5000;
const MAX_LOG_BYTES = 3_000_000;

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Delay before the n-th consecutive restart: 1 s, 2 s, 4 s... up to a minute. */
export function restartDelay(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
}

export class Sidecar extends EventEmitter<{ status: [SidecarStatus]; ready: [SidecarEndpoint]; down: [] }> {
  private child: ChildProcess | null = null;
  private current: SidecarEndpoint | null = null;
  private state: SidecarStatus = { state: "off", message: "", engines: [], gpu: null, installed: [] };
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private crashes: number[] = [];
  private stopping = false;
  private readonly logFile: string;

  constructor(private readonly options: SidecarOptions) {
    super();
    mkdirSync(options.logDir, { recursive: true });
    this.logFile = join(options.logDir, "sidecar.log");
    try {
      if (statSync(this.logFile).size > MAX_LOG_BYTES) renameSync(this.logFile, join(options.logDir, "sidecar.old.log"));
    } catch {
      // no log yet
    }
  }

  status(): SidecarStatus {
    return this.state;
  }

  endpoint(): SidecarEndpoint | null {
    return this.state.state === "ready" ? this.current : null;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.options.externalUrl) {
      this.current = { url: this.options.externalUrl.replace(/\/+$/, ""), token: this.options.externalToken ?? "" };
      this.setState("starting", "uso un sidecar già avviato");
      this.watchHealth(Date.now());
      return;
    }
    const command = this.command();
    if (!command) {
      this.setState("error", "manca l'ambiente Python del sidecar: esegui `uv sync --extra gpu` nella cartella sidecar");
      return;
    }
    const port = await freePort();
    const token = randomBytes(24).toString("hex");
    this.current = { url: `http://127.0.0.1:${port}`, token };
    const args = [...command.args, "server.py", "--port", String(port), "--models-dir", this.options.modelsDir, "--parent-pid", String(process.pid)];
    log.info(`Starting the sidecar: ${command.exe} ${args.join(" ")}`);
    this.setState("starting", "avvio dei motori della voce…");
    const child = spawn(command.exe, args, {
      cwd: this.options.dir,
      env: {
        ...process.env,
        LUMI_SIDECAR_TOKEN: token,
        LUMI_MODELS_DIR: this.options.modelsDir,
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      // No stdin: a pipe there would be inherited by every subprocess the sidecar starts
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    // Windows ends the sidecar (and its children) with the app, even after a crash
    if (child.pid && !bindToLumi(child.pid)) log.warn("The sidecar is not bound to the app's lifetime");
    const write = (chunk: Buffer) => {
      try {
        appendFileSync(this.logFile, chunk);
      } catch {
        // logging must never break the voice
      }
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (err) => log.error("Sidecar process error", err));
    child.on("exit", (code, signal) => this.onExit(child, code, signal));
    this.watchHealth(Date.now());
  }

  /** Stops the sidecar (and its whole process tree). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.pid) {
      // The whole tree: the venv's python.exe is a launcher that starts the real interpreter
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.setState("off", "");
  }

  async restart(): Promise<void> {
    this.crashes = [];
    await this.stop();
    await this.start();
  }

  /** GET/POST to the sidecar with the token. */
  async request<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const endpoint = this.current;
    if (!endpoint) throw new Error("sidecar not running");
    const res = await fetch(`${endpoint.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${endpoint.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`sidecar ${path}: ${res.status} ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** WebSocket URL of an endpoint, with the token. */
  socketUrl(path: string): string | null {
    const endpoint = this.endpoint();
    return endpoint ? `${endpoint.url.replace(/^http/, "ws")}${path}?token=${endpoint.token}` : null;
  }

  private command(): { exe: string; args: string[] } | null {
    const venvPython = join(this.options.dir, ".venv", "Scripts", "python.exe");
    if (existsSync(venvPython)) return { exe: venvPython, args: [] };
    if (!existsSync(join(this.options.dir, "server.py"))) return null;
    // No environment yet: uv creates it on the first run
    return { exe: "uv", args: ["run", "--project", this.options.dir, "python"] };
  }

  private watchHealth(since: number): void {
    this.clearTimers();
    const poll = async () => {
      const starting = this.state.state !== "ready";
      try {
        const health = await this.request<Health>("/health", undefined, starting ? 3000 : 8000);
        const wasReady = this.state.state === "ready";
        this.state = { state: "ready", message: "", engines: health.engines, gpu: health.gpu, installed: health.installed };
        this.emit("status", this.state);
        if (!wasReady && this.current) {
          log.info(`Sidecar ready at ${this.current.url}`);
          this.emit("ready", this.current);
        }
      } catch (err) {
        if (starting && Date.now() - since > START_TIMEOUT_MS) {
          log.error("The sidecar didn't start in time", err);
          this.setState("error", "i motori della voce non si sono avviati: i dettagli sono in logs\\sidecar.log");
          if (this.child?.pid) spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true });
          return;
        }
        if (!starting) {
          log.warn("Sidecar health check failed", err);
          if (this.options.externalUrl) {
            this.setState("starting", "il sidecar esterno non risponde");
            this.emit("down");
          }
        }
      }
      if (!this.stopping) this.healthTimer = setTimeout(poll, this.state.state === "ready" ? HEALTH_EVERY_MS : 1000);
    };
    this.healthTimer = setTimeout(poll, 500);
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (child !== this.child && this.child !== null) return;
    this.child = null;
    this.clearTimers();
    if (this.stopping) return;
    log.warn(`Sidecar exited (code ${code}, signal ${signal})`);
    this.emit("down");
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 10 * 60_000), now];
    if (this.crashes.length > 5) {
      this.setState("error", "i motori della voce continuano a chiudersi: i dettagli sono in logs\\sidecar.log");
      return;
    }
    const delay = restartDelay(this.crashes.length - 1);
    this.setState("starting", `riavvio dei motori della voce tra ${Math.round(delay / 1000)} s…`);
    this.restartTimer = setTimeout(() => void this.start(), delay);
  }

  private setState(state: SidecarStatus["state"], message: string): void {
    this.state = { ...this.state, state, message, ...(state === "ready" ? {} : { engines: state === "off" ? [] : this.state.engines }) };
    this.emit("status", this.state);
  }

  private clearTimers(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.healthTimer = null;
    this.restartTimer = null;
  }
}
