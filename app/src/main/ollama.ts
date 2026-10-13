// Starts Ollama when Lumi's brain is configured to use it but the local
// server isn't running (it is not started with Windows by default).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";

/** Whether the Ollama address is on this PC (only then can Lumi start it). */
export function isLocalOllama(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(url.trim());
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function installed(): { exe: string; args: string[] } | null {
  const base = join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama");
  // The tray app starts the server and keeps it up to date
  const app = join(base, "ollama app.exe");
  if (existsSync(app)) return { exe: app, args: [] };
  const cli = join(base, "ollama.exe");
  if (existsSync(cli)) return { exe: cli, args: ["serve"] };
  return null;
}

let starting: Promise<boolean> | null = null;

/** Makes sure the local Ollama server answers, starting it if needed. */
export function ensureOllama(url: string): Promise<boolean> {
  if (!isLocalOllama(url)) return Promise.resolve(false);
  starting ??= (async () => {
    if (await reachable(url)) return true;
    const ollama = installed();
    if (!ollama) {
      log.warn("Ollama is not running and is not installed in the usual folder");
      return false;
    }
    log.info(`Starting Ollama (${ollama.exe})`);
    const child = spawn(ollama.exe, ollama.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await reachable(url)) return true;
    }
    log.warn("Ollama didn't answer after starting it");
    return false;
  })().finally(() => {
    starting = null;
  });
  return starting;
}
