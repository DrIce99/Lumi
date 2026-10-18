// The sidecar's Python environment in the installed app (roadmap 13). The
// installer ships the sidecar's source, its uv.lock and uv.exe, not Python
// itself: torch with CUDA alone is gigabytes, and what to install depends
// on the PC (the profile). On first start uv downloads a managed CPython
// and installs the locked packages into %LOCALAPPDATA%\Lumi\sidecar-env
// (local, not roaming: big and machine-specific; outside the install
// folder, so an update keeps it). A marker file remembers which uv.lock
// and extras the environment was built for: an update with a new lock, or
// another profile, syncs again (uv only adds and removes what changed).
//
// In development the sidecar's own .venv (uv sync by hand) is used as before.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../../shared/types";

export interface RuntimePaths {
  /** The sidecar's source (server.py, pyproject.toml, uv.lock). */
  sidecarDir: string;
  /** uv.exe shipped with the app, or "uv" from PATH in development. */
  uv: string;
  /** The environment uv builds (UV_PROJECT_ENVIRONMENT). */
  envDir: string;
}

export interface EnvMarker {
  lock: string;
  extras: string[];
}

/** Extras of sidecar/pyproject.toml each profile needs. */
export function extrasFor(profile: Profile): string[] {
  // The light profile has no NVIDIA GPU: no torch (Kokoro, Whisper and the rest run on onnxruntime)
  return profile === "leggero" ? ["wakeword"] : ["gpu", "wakeword"];
}

export function lockHash(sidecarDir: string): string {
  return createHash("sha256").update(readFileSync(join(sidecarDir, "uv.lock"))).digest("hex").slice(0, 16);
}

export function envPython(envDir: string): string {
  return join(envDir, "Scripts", "python.exe");
}

const markerFile = (envDir: string) => join(envDir, "lumi-env.json");

export function readMarker(envDir: string): EnvMarker | null {
  try {
    const data = JSON.parse(readFileSync(markerFile(envDir), "utf8")) as Partial<EnvMarker>;
    return typeof data.lock === "string" && Array.isArray(data.extras) ? { lock: data.lock, extras: data.extras.map(String) } : null;
  } catch {
    return null;
  }
}

/** Ready = python is there and was synced for this lock with (at least) these extras. */
export function envReady(paths: RuntimePaths, extras: string[]): boolean {
  if (!existsSync(envPython(paths.envDir))) return false;
  const marker = readMarker(paths.envDir);
  if (!marker || !existsSync(join(paths.sidecarDir, "uv.lock"))) return false;
  return marker.lock === lockHash(paths.sidecarDir) && extras.every((e) => marker.extras.includes(e));
}

/** Any environment we built, even for an older lock or other extras: better than none while a sync is due. */
export function envUsable(paths: RuntimePaths): boolean {
  return existsSync(envPython(paths.envDir)) && readMarker(paths.envDir) !== null;
}

export type SyncEvent =
  | { kind: "python"; detail: string }
  | { kind: "download"; name: string; bytes: number }
  | { kind: "downloaded"; name: string }
  | { kind: "phase"; phase: "resolve" | "prepare" | "install" | "done"; detail: string }
  | { kind: "error"; detail: string };

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** One line of `uv sync` output (stderr, no progress bars when not a terminal) as an event. */
export function parseUvLine(line: string): SyncEvent | null {
  const text = line.trim();
  if (!text) return null;
  let m = /^Downloading (cpython-\S+)/.exec(text);
  if (m) return { kind: "python", detail: m[1] };
  m = /^Downloading (\S+) \(([\d.]+)\s*(B|KiB|MiB|GiB)\)/.exec(text);
  if (m) return { kind: "download", name: m[1], bytes: Math.round(Number(m[2]) * UNITS[m[3]]) };
  // uv 0.9 repeats "Downloading name" without the size when a download ends; older ones said "Downloaded"
  m = /^Downloading (\S+)$/.exec(text) ?? /^Downloaded (\S+)/.exec(text);
  if (m) return { kind: "downloaded", name: m[1] };
  if (/^(Using CPython|Creating virtual environment)/.test(text)) return { kind: "phase", phase: "resolve", detail: text };
  if (/^(Resolved|Audited) \d+ packages?/.test(text)) return { kind: "phase", phase: "resolve", detail: text };
  if (/^Prepared \d+ packages?/.test(text)) return { kind: "phase", phase: "prepare", detail: text };
  if (/^(Installed|Uninstalled) \d+ packages?/.test(text)) return { kind: "phase", phase: "install", detail: text };
  if (/^error:/i.test(text)) return { kind: "error", detail: text.replace(/^error:\s*/i, "") };
  return null;
}

/** Download progress from the events seen so far: bytes done of bytes announced. */
export class SyncProgress {
  private sizes = new Map<string, number>();
  private done = new Set<string>();

  add(event: SyncEvent): void {
    if (event.kind === "download") this.sizes.set(event.name, event.bytes);
    if (event.kind === "downloaded") this.done.add(event.name);
  }

  get total(): number {
    return [...this.sizes.values()].reduce((a, b) => a + b, 0);
  }

  get downloaded(): number {
    return [...this.done].reduce((sum, name) => sum + (this.sizes.get(name) ?? 0), 0);
  }
}

export interface SyncResult {
  ok: boolean;
  error?: string;
}

/** Arguments of the sync: locked, no dev tools, only the extras asked for. */
export function syncArgs(paths: RuntimePaths, extras: string[]): string[] {
  return ["sync", "--frozen", "--no-dev", "--project", paths.sidecarDir, ...extras.flatMap((e) => ["--extra", e])];
}

/**
 * Builds (or updates) the environment. `onEvent` gets every parsed line;
 * `onLine` the raw output, for the log. Resolves when uv exits.
 */
export function syncEnvironment(paths: RuntimePaths, extras: string[], onEvent: (e: SyncEvent) => void, onLine: (line: string) => void = () => {}): Promise<SyncResult> {
  return new Promise((resolve) => {
    let lastError = "";
    const child = spawn(paths.uv, syncArgs(paths, extras), {
      cwd: paths.sidecarDir,
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: paths.envDir,
        // uv's own CPython, the version the lock was made for, not whatever is on PATH
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_NO_PROGRESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let pending = "";
    const feed = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
        const event = parseUvLine(line);
        if (event?.kind === "error") lastError = event.detail;
        if (event) onEvent(event);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => resolve({ ok: false, error: `uv non parte: ${err.message}` }));
    child.on("exit", (code) => {
      if (pending) feed(Buffer.from("\n"));
      if (code !== 0) return resolve({ ok: false, error: lastError || `uv è uscito con codice ${code}` });
      writeFileSync(markerFile(paths.envDir), JSON.stringify({ lock: lockHash(paths.sidecarDir), extras } satisfies EnvMarker));
      onEvent({ kind: "phase", phase: "done", detail: "" });
      resolve({ ok: true });
    });
  });
}
