// First start of the installed app (roadmap 13): installs the sidecar's
// Python environment for the chosen profile, starts the sidecar and follows
// the models' first download. The settings window shows it (Generale →
// Motore della voce) and starts it with a button: torch with CUDA is a few
// GB, the user decides when. Until it's done Lumi works in text mode.
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Profile, RuntimeSetupState } from "../../shared/types";
import { log } from "../log";
import type { Sidecar } from "../sidecar";
import { envReady, envUsable, extrasFor, SyncProgress, syncEnvironment, type RuntimePaths } from "./runtime";

/** Total size of a folder (async, so a big models folder never stalls the main thread). */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else if (entry.isFile()) total += await stat(path).then((s) => s.size, () => 0);
  }
  return total;
}

export class RuntimeSetup extends EventEmitter<{ change: [RuntimeSetupState] }> {
  private running: RuntimeSetupState | null = null;
  private modelsStart = 0;
  private modelsTimer: NodeJS.Timeout | null = null;
  private lastEmit = 0;

  constructor(
    /** null in development: the sidecar's own .venv is used. */
    private readonly paths: RuntimePaths | null,
    private readonly profile: () => Profile,
    private readonly sidecar: Sidecar,
    private readonly modelsDir: string,
    private readonly logDir: string,
  ) {
    super();
    // While the models download, the engines' states come with the sidecar's status
    sidecar.on("status", () => {
      if (this.running?.phase === "models" || this.running?.phase === "starting") this.followModels();
    });
  }

  state(): RuntimeSetupState {
    if (this.running) return { ...this.running };
    const extras = this.paths ? extrasFor(this.profile()) : [];
    const base = { extras, downloaded: 0, total: 0, detail: "", modelsMb: 0 };
    if (!this.paths) return { ...base, phase: "dev" };
    if (envReady(this.paths, extras)) return { ...base, phase: "ready" };
    return { ...base, phase: envUsable(this.paths) ? "outdated" : "missing" };
  }

  /** The environment is missing or was built for another lock or profile. */
  needed(): boolean {
    const phase = this.state().phase;
    return phase === "missing" || phase === "outdated";
  }

  async install(): Promise<RuntimeSetupState> {
    if (!this.paths || (this.running && this.running.phase !== "error")) return this.state();
    const extras = extrasFor(this.profile());
    this.running = { phase: "installing", extras, downloaded: 0, total: 0, detail: "preparo Python…", modelsMb: 0 };
    this.emitNow();
    mkdirSync(this.logDir, { recursive: true });
    const logFile = join(this.logDir, "setup.log");
    appendFileSync(logFile, `\n=== ${new Date().toISOString()} uv sync, extras: ${extras.join(", ") || "-"}\n`);
    log.info(`Installing the sidecar environment (${extras.join(", ")}) in ${this.paths.envDir}`);
    const progress = new SyncProgress();
    // The sidecar runs from the environment uv rewrites: stop it during the sync
    await this.sidecar.stop();
    const result = await syncEnvironment(
      this.paths,
      extras,
      (event) => {
        progress.add(event);
        const r = this.running!;
        r.downloaded = progress.downloaded;
        r.total = progress.total;
        if (event.kind === "python") r.detail = "scarico Python…";
        else if (event.kind === "download") r.detail = `scarico ${event.name}…`;
        else if (event.kind === "phase") r.detail = event.phase === "install" ? "installo i pacchetti…" : event.phase === "prepare" ? "preparo i pacchetti…" : r.detail;
        this.emitSoon();
      },
      (line) => {
        try {
          appendFileSync(logFile, `${line}\n`);
        } catch {
          // the log must never break the setup
        }
      },
    );
    if (!result.ok) {
      log.error(`Sidecar environment setup failed: ${result.error}`);
      this.running = { ...this.running!, phase: "error", detail: result.error ?? "errore sconosciuto (vedi logs\\setup.log)" };
      this.emitNow();
      void this.sidecar.start();
      return this.state();
    }
    log.info("Sidecar environment ready");
    this.running = { ...this.running!, phase: "starting", detail: "avvio i motori…", downloaded: progress.total, total: progress.total };
    this.emitNow();
    this.modelsStart = await folderBytes(this.modelsDir);
    await this.sidecar.restart();
    this.modelsTimer = setInterval(() => void this.measureModels(), 3000);
    // Voice off or engines that load nothing: don't wait forever for a download that won't come
    setTimeout(() => {
      if (this.running?.phase === "starting") this.finish("ready", "");
    }, 90_000).unref();
    return this.state();
  }

  private followModels(): void {
    const status = this.sidecar.status();
    const r = this.running!;
    if (status.state === "error") {
      this.finish("error", status.message || "i motori non si sono avviati (vedi logs\\sidecar.log)");
      return;
    }
    if (status.state !== "ready") return;
    const loading = status.engines.filter((e) => e.state === "loading");
    if (loading.length) {
      r.phase = "models";
      r.detail = `scarico e carico: ${loading.map((e) => e.name).join(", ")}`;
      this.emitSoon();
    } else if (r.phase === "models" || status.engines.some((e) => e.state === "ready")) {
      this.finish("ready", "");
    }
  }

  private async measureModels(): Promise<void> {
    if (!this.running) return;
    this.running.modelsMb = Math.max(0, Math.round(((await folderBytes(this.modelsDir)) - this.modelsStart) / 1e6));
    this.emitSoon();
  }

  private finish(phase: "ready" | "error", detail: string): void {
    if (this.modelsTimer) clearInterval(this.modelsTimer);
    this.modelsTimer = null;
    const last = this.running!;
    this.running = phase === "error" ? { ...last, phase, detail } : null;
    if (phase === "ready") log.info(`First start done: ${last.modelsMb} MB of models downloaded`);
    this.emitNow();
  }

  private emitSoon(): void {
    if (Date.now() - this.lastEmit > 300) this.emitNow();
  }

  private emitNow(): void {
    this.lastEmit = Date.now();
    this.emit("change", this.state());
  }
}
