// The app index (roadmap 16.2): what "apri Spotify" can open. Start menu
// apps and Store apps with their AppUserModelID (Get-StartApps; launched
// through shell:AppsFolder\<id>, the way Start does) plus the shortcuts'
// targets (to know each app's exe and find its windows), and Steam games
// from the library manifests. Built in the background at startup and every
// hour, all in child processes and async reads: nothing waits on the main
// thread.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log";
import { buildEntries, parseVdf, steamLibraries, steamManifest, type AppEntry, type StartApp, type StartLink, type SteamGame } from "./match";

const REFRESH_MS = 60 * 60_000;

// One PowerShell call: Get-StartApps and the Start menu shortcuts' targets, as JSON
const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$apps = @(Get-StartApps | ForEach-Object { @{ n = $_.Name; id = $_.AppID } })
$sh = New-Object -ComObject WScript.Shell
$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
$links = @(Get-ChildItem -Path $dirs -Recurse -Filter *.lnk | ForEach-Object { @{ n = $_.BaseName; t = $sh.CreateShortcut($_.FullName).TargetPath } })
@{ apps = $apps; links = $links } | ConvertTo-Json -Compress -Depth 4
`;

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** A REG_SZ value from `reg query`, or "" when missing. */
async function regValue(key: string, value: string): Promise<string> {
  try {
    const out = await run("reg.exe", ["query", key, "/v", value], 5000);
    return new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, "i").exec(out)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

async function startMenu(): Promise<{ apps: StartApp[]; links: StartLink[] }> {
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], 30_000);
  const json = JSON.parse(out.replace(/^﻿/, "").trim() || "{}") as { apps?: { n?: unknown; id?: unknown }[]; links?: { n?: unknown; t?: unknown }[] };
  const apps = (json.apps ?? []).flatMap((a) => (typeof a.n === "string" && typeof a.id === "string" ? [{ name: a.n, id: a.id }] : []));
  const links = (json.links ?? []).flatMap((l) => (typeof l.n === "string" && typeof l.t === "string" ? [{ name: l.n, target: l.t }] : []));
  return { apps, links };
}

async function steamGames(): Promise<SteamGame[]> {
  const steam = (await regValue("HKCU\\Software\\Valve\\Steam", "SteamPath")).replace(/\//g, "\\");
  if (!steam) return [];
  let libraries: string[] = [steam];
  for (const file of [join(steam, "steamapps", "libraryfolders.vdf"), join(steam, "config", "libraryfolders.vdf")]) {
    try {
      libraries = [...new Set([steam, ...steamLibraries(parseVdf(await readFile(file, "utf8")))])];
      break;
    } catch {
      // older layouts keep it elsewhere
    }
  }
  const games: SteamGame[] = [];
  for (const library of libraries) {
    const dir = join(library, "steamapps");
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => /^appmanifest_\d+\.acf$/i.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const game = steamManifest(parseVdf(await readFile(join(dir, name), "utf8")));
        if (game) games.push(game);
      } catch {
        // a manifest being rewritten by Steam
      }
    }
  }
  return games;
}

export class AppIndex {
  private list: AppEntry[] = [];
  private progId = "";
  private updatedAt = 0;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer || process.platform !== "win32") return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  entries(): AppEntry[] {
    return this.list;
  }

  /** The default browser's ProgId ("ChromeHTML", "OperaGXStable"...). */
  browserProgId(): string {
    return this.progId;
  }

  /** Milliseconds since the last refresh (Infinity before the first). */
  age(): number {
    return this.updatedAt ? Date.now() - this.updatedAt : Number.POSITIVE_INFINITY;
  }

  counts(): { apps: number; games: number } {
    const games = this.list.filter((e) => e.kind === "game").length;
    return { apps: this.list.length - games, games };
  }

  /** Reads everything again; concurrent calls share one run. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const started = Date.now();
      try {
        const [menu, games, progId] = await Promise.all([
          startMenu().catch((err) => {
            log.warn("Reading the Start menu apps failed", err);
            return { apps: [], links: [] };
          }),
          steamGames().catch(() => []),
          regValue("HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "ProgId"),
        ]);
        const list = buildEntries(menu.apps, menu.links, games);
        // A failed read keeps the previous index
        if (list.length || !this.list.length) this.list = list;
        this.progId = progId || this.progId;
        this.updatedAt = Date.now();
        const counts = this.counts();
        log.info(`App index: ${counts.apps} apps, ${counts.games} games in ${Date.now() - started} ms`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
