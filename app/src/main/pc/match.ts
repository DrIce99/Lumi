// From what the user said to something on the PC: the app index (Start menu
// apps, Store apps, Steam games), spoken names with typos and aliases
// ("esplora file", "il browser", "la cartella download"), and the open
// windows that belong to an app. Pure, tested; apps.ts and win32.ts do the
// reading.
import { normalizeText, similarity } from "../perception/grounding";
import { INSTALLER } from "./policy";

export interface AppEntry {
  name: string;
  kind: "app" | "game";
  /** What starts it: an AppUserModelID (shell:AppsFolder\<id>) or a steam:// link. */
  launch: string;
  /** The executable's file name when known ("code.exe"), to find its windows. */
  exe?: string;
}

/** One line of Get-StartApps, and one Start menu shortcut with its target. */
export interface StartApp {
  name: string;
  id: string;
}
export interface StartLink {
  name: string;
  target: string;
}
export interface SteamGame {
  id: string;
  name: string;
}

export const KNOWN_FOLDERS = ["downloads", "documents", "desktop", "pictures", "music", "videos", "home"] as const;
export type KnownFolder = (typeof KNOWN_FOLDERS)[number];

/** Steam's own runtimes and redistributables are not games. */
const NOT_A_GAME = /redistributable|steamworks|proton|steam linux runtime|steamvr\b.*beta/i;

const basename = (path: string) => path.split(/[\\/]/).pop() ?? "";

/** The index: Start menu apps (with their exe when a shortcut or the AppID tells it) plus Steam games without a shortcut. */
export function buildEntries(apps: StartApp[], links: StartLink[], games: SteamGame[]): AppEntry[] {
  const exeOf = new Map<string, string>();
  for (const link of links) {
    if (/\.exe$/i.test(link.target)) exeOf.set(normalizeText(link.name), basename(link.target).toLowerCase());
  }
  const out: AppEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: AppEntry) => {
    const key = normalizeText(entry.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const app of apps) {
    const name = app.name.trim();
    const id = app.id.trim();
    // "X sul Web" and help links: web pages, not apps
    if (!name || !id || /^https?:/i.test(id) || /\.(url|html?|chm|pdf|txt)$/i.test(id)) continue;
    const steam = /^steam:\/\/rungameid\/(\d+)/i.exec(id);
    if (steam && NOT_A_GAME.test(name)) continue;
    const exe = /\.exe$/i.test(id) ? basename(id).toLowerCase() : exeOf.get(normalizeText(name));
    add({ name, kind: steam ? "game" : "app", launch: id, ...(exe ? { exe } : {}) });
  }
  const launched = new Set(out.map((e) => e.launch.toLowerCase()));
  for (const game of games) {
    const launch = `steam://rungameid/${game.id}`;
    if (launched.has(launch) || NOT_A_GAME.test(game.name) || game.id === "228980") continue;
    add({ name: game.name, kind: "game", launch });
  }
  return out;
}

// ---------------- Steam's files ----------------

export type Vdf = { [key: string]: string | Vdf };

/** Valve's KeyValues text (libraryfolders.vdf, appmanifest_*.acf). */
export function parseVdf(text: string): Vdf {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) tokens.push(m[2] ?? m[1].replace(/\\(.)/g, "$1"));
  let i = 0;
  const block = (): Vdf => {
    const out: Vdf = {};
    while (i < tokens.length) {
      const key = tokens[i++];
      if (key === "}") break;
      const value = tokens[i++];
      if (value === undefined) break;
      out[key] = value === "{" ? block() : value;
    }
    return out;
  };
  return block();
}

/** The library folders listed in libraryfolders.vdf. */
export function steamLibraries(vdf: Vdf): string[] {
  const root = (vdf.libraryfolders ?? vdf.LibraryFolders) as Vdf | undefined;
  if (!root || typeof root !== "object") return [];
  return Object.values(root).flatMap((v) => (typeof v === "object" && typeof v.path === "string" ? [v.path] : typeof v === "string" && /[\\/]/.test(v) ? [v] : []));
}

/** One appmanifest_*.acf: the game's id and name. */
export function steamManifest(vdf: Vdf): SteamGame | null {
  const state = vdf.AppState as Vdf | undefined;
  if (!state || typeof state.appid !== "string" || typeof state.name !== "string") return null;
  return { id: state.appid, name: state.name };
}

// ---------------- spoken names ----------------

/** Words around a name in a request: "apri il gioco Hollow Knight" -> "hollow knight". */
const FILLER = new Set(["apri", "avvia", "lancia", "aprimi", "avviami", "metti", "fammi", "vedere", "il", "lo", "la", "l", "i", "gli", "le", "un", "una", "uno", "app", "applicazione", "programma", "gioco", "videogioco", "the", "open", "start", "launch"]);

export function cleanName(query: string): string {
  return normalizeText(query)
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}

const FOLDER_WORDS: Record<string, KnownFolder> = {
  download: "downloads",
  downloads: "downloads",
  scaricati: "downloads",
  documenti: "documents",
  documents: "documents",
  desktop: "desktop",
  scrivania: "desktop",
  immagini: "pictures",
  foto: "pictures",
  pictures: "pictures",
  musica: "music",
  music: "music",
  video: "videos",
  videos: "videos",
  home: "home",
  utente: "home",
};

/** Places of Windows itself, opened through Explorer. */
const PLACES: Record<string, { uri: string; name: string }> = {
  cestino: { uri: "shell:RecycleBinFolder", name: "Cestino" },
  "recycle bin": { uri: "shell:RecycleBinFolder", name: "Cestino" },
  "questo pc": { uri: "shell:MyComputerFolder", name: "Questo PC" },
  "this pc": { uri: "shell:MyComputerFolder", name: "Questo PC" },
  "risorse del computer": { uri: "shell:MyComputerFolder", name: "Questo PC" },
  impostazioni: { uri: "ms-settings:", name: "Impostazioni" },
  "impostazioni di windows": { uri: "ms-settings:", name: "Impostazioni" },
  settings: { uri: "ms-settings:", name: "Impostazioni" },
  "impostazioni audio": { uri: "ms-settings:sound", name: "Impostazioni audio" },
  "impostazioni schermo": { uri: "ms-settings:display", name: "Impostazioni dello schermo" },
  "impostazioni bluetooth": { uri: "ms-settings:bluetooth", name: "Impostazioni Bluetooth" },
  "impostazioni wifi": { uri: "ms-settings:network-wifi", name: "Impostazioni Wi-Fi" },
  "windows update": { uri: "ms-settings:windowsupdate", name: "Windows Update" },
};

/** Spoken names for apps that have another name in the Start menu; "<browser>" is the default browser. */
const APP_ALIASES: Record<string, string[]> = {
  "esplora file": ["Esplora file", "File Explorer"],
  "esplora risorse": ["Esplora file", "File Explorer"],
  explorer: ["Esplora file", "File Explorer"],
  "file explorer": ["Esplora file", "File Explorer"],
  "gestione file": ["Esplora file", "File Explorer"],
  browser: ["<browser>"],
  internet: ["<browser>"],
  "il browser": ["<browser>"],
  musica: ["Spotify"],
  "la musica": ["Spotify"],
  vscode: ["Visual Studio Code"],
  "vs code": ["Visual Studio Code"],
  "visual studio code": ["Visual Studio Code"],
  "task manager": ["Gestione attività", "Task Manager"],
  "gestione attivita": ["Gestione attività", "Task Manager"],
  "blocco note": ["Blocco note", "Notepad"],
  notepad: ["Blocco note", "Notepad"],
  calcolatrice: ["Calcolatrice", "Calculator"],
  terminale: ["Terminale", "Terminal"],
  "prompt dei comandi": ["Prompt dei comandi", "Command Prompt"],
  word: ["Word"],
  excel: ["Excel"],
  powerpoint: ["PowerPoint"],
  posta: ["Outlook", "Posta"],
  email: ["Outlook", "Posta"],
};

/** The default browser's ProgId (HKCU ...\UrlAssociations\https\UserChoice) -> names it has in the Start menu. */
export function browserNames(progId: string): string[] {
  const p = progId.toLowerCase();
  if (p.startsWith("chromehtml")) return ["Google Chrome"];
  if (p.startsWith("msedgehtm")) return ["Microsoft Edge"];
  if (p.startsWith("firefoxurl")) return ["Firefox", "Mozilla Firefox"];
  if (p.startsWith("operagxstable")) return ["Opera GX", "Browser Opera GX"];
  if (p.startsWith("opera")) return ["Opera", "Browser Opera"];
  if (p.startsWith("bravehtml")) return ["Brave"];
  if (p.startsWith("vivaldihtm")) return ["Vivaldi"];
  if (p.startsWith("librewolf")) return ["LibreWolf"];
  return [];
}

export interface Scored {
  entry: AppEntry;
  score: number;
}

/** How well a cleaned query names an entry, 0..1. */
export function nameScore(query: string, entry: AppEntry): number {
  const q = query;
  const n = normalizeText(entry.name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const exe = entry.exe ? normalizeText(entry.exe.replace(/\.exe$/i, "")) : "";
  if (exe && q === exe) return 0.95;
  const qWords = q.split(" ");
  const nWords = n.split(" ");
  // Every spoken word is a word of the name ("chrome" in "google chrome"), or the start of one
  const contained = qWords.every((w) => nWords.some((x) => x === w || (w.length >= 3 && x.startsWith(w))));
  if (contained) return Math.max(0.8, 0.92 - 0.04 * (nWords.length - qWords.length));
  let best = similarity(q, n);
  // Typos within a part of the name of the same length ("spotfy")
  for (let i = 0; i + qWords.length <= nWords.length; i++) best = Math.max(best, similarity(q, nWords.slice(i, i + qWords.length).join(" ")) - 0.04);
  return best;
}

const MIN_SCORE = 0.75;

const INSTALL_WORDS = /\b(disinstall\w*|install\w*|uninstall\w*|rimuovi|setup)\b/g;

/**
 * Entries for a name, best first. Installers only when the query asks for
 * one ("disinstalla Node" -> "Uninstall Node.js", matched on the rest of
 * the name): the policy then refuses it, and the model learns why.
 */
export function matchApps(query: string, entries: AppEntry[], minScore = MIN_SCORE): Scored[] {
  const wantsInstaller = INSTALLER.test(query);
  const q = wantsInstaller ? cleanName(query).replace(INSTALL_WORDS, " ").replace(/\s+/g, " ").trim() : cleanName(query);
  if (!q) return [];
  return entries
    .filter((e) => wantsInstaller === INSTALLER.test(`${e.name} ${e.launch}`))
    .map((entry) => ({ entry, score: nameScore(q, wantsInstaller ? { ...entry, name: normalizeText(entry.name).replace(INSTALL_WORDS, " ").trim() } : entry) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
}

export type Resolved =
  | { kind: "url"; url: string }
  | { kind: "uri"; uri: string; name: string }
  /** An explicit path: file or folder, the executor looks. */
  | { kind: "path"; path: string }
  | { kind: "folder"; folder: KnownFolder; name: string }
  | { kind: "app"; entry: AppEntry }
  | { kind: "ambiguous"; options: string[] }
  | { kind: "none" };

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|it|org|net|io|dev|tv|gg|app|eu|co|me|ai|edu|gov|info|uk|de|fr|es)(\/\S*)?$/i;

/** Two matches this close are a real doubt: the model asks the user. */
const AMBIGUOUS_GAP = 0.03;

/** What "open X" means: a web address, a link, a path, a folder, an app or game; or a doubt. */
export function resolveTarget(target: string, entries: AppEntry[], browserProgId = ""): Resolved {
  const raw = target.trim().replace(/^["'«]|["'»]$/g, "");
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return { kind: "url", url: raw };
  if (/^www\./i.test(raw) || DOMAIN.test(raw)) return { kind: "url", url: `https://${raw}` };
  if (/^[a-z]:[\\/]/i.test(raw) || /^%[a-z_]+%/i.test(raw) || /^~[\\/]/.test(raw) || /^\\\\/.test(raw)) return { kind: "path", path: raw };
  if (/^[a-z][a-z0-9+.-]{1,30}:/i.test(raw)) return { kind: "uri", uri: raw, name: raw };

  const normalized = normalizeText(raw);
  const folderAsked = /\b(cartella|folder|directory)\b/.test(normalized);
  const q = cleanName(raw).replace(/\b(cartella|folder|directory|dei|degli|delle|del|della|di)\b/g, " ").replace(/\s+/g, " ").trim();
  if (folderAsked) {
    const folder = FOLDER_WORDS[q];
    return folder ? { kind: "folder", folder, name: raw } : { kind: "none" };
  }
  const exact = entries.find((e) => normalizeText(e.name) === q);
  if (exact) return { kind: "app", entry: exact };
  const place = PLACES[normalized] ?? PLACES[q];
  if (place) return { kind: "uri", uri: place.uri, name: place.name };
  const aliases = APP_ALIASES[q] ?? APP_ALIASES[normalized];
  if (aliases) {
    const names = aliases.flatMap((a) => (a === "<browser>" ? browserNames(browserProgId) : [a]));
    for (const name of names) {
      const found = entries.find((e) => normalizeText(e.name) === normalizeText(name)) ?? matchApps(name, entries, 0.85)[0]?.entry;
      if (found) return { kind: "app", entry: found };
    }
  }
  if (FOLDER_WORDS[q]) return { kind: "folder", folder: FOLDER_WORDS[q], name: raw };
  const found = matchApps(raw, entries);
  if (!found.length) return { kind: "none" };
  const close = found.filter((s) => found[0].score - s.score <= AMBIGUOUS_GAP && s.score < 1);
  if (close.length > 1 && found[0].score < 0.95) return { kind: "ambiguous", options: close.slice(0, 5).map((s) => s.entry.name) };
  return { kind: "app", entry: found[0].entry };
}

// ---------------- windows ----------------

export interface WindowInfo {
  /** Opaque handle, from win32.ts. */
  handle: unknown;
  /** The handle's address as text: compares windows across listings. */
  id: string;
  title: string;
  /** Executable name, e.g. "Discord.exe". */
  process: string;
  pid: number;
  minimized: boolean;
  maximized: boolean;
}

const compact = (s: string) => normalizeText(s).replace(/ /g, "");

/**
 * The name people use for the app a window belongs to: its Start menu name
 * when the index knows its exe, or when the title or the exe is that name
 * without spaces (Store apps: "WhatsApp.Root.exe" titled "WhatsApp";
 * "ZenlessZoneZero.exe"); else the exe's name.
 */
export function appLabel(window: WindowInfo, entries: AppEntry[]): string {
  const exe = window.process.toLowerCase();
  if (exe === "explorer.exe") return "Esplora file";
  const base = window.process.replace(/\.exe$/i, "");
  const byExe = entries.find((e) => e.exe === exe);
  if (byExe) return byExe.name;
  const title = compact(window.title);
  const short = compact(base);
  const byName = entries.find((e) => {
    const name = compact(e.name);
    return name.length >= 3 && (name === title || name === short);
  });
  return byName?.name ?? base;
}

/** The windows of the app the user named, in z-order (the topmost first); empty when none is close enough. */
export function matchWindows(query: string, windows: WindowInfo[], entries: AppEntry[]): WindowInfo[] {
  const q = cleanName(query)
    .replace(/\b(finestra|finestre|window|di|del|della|dello|dei|delle|degli|con)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return [];
  const scored = windows.map((w) => {
    const label = appLabel(w, entries);
    const fake: AppEntry = { name: label, kind: "app", launch: "", exe: w.process.toLowerCase() };
    let score = nameScore(q, fake);
    // An alias or an index entry that names this exe ("vs code" -> Visual Studio Code -> code.exe)
    for (const s of matchApps(q, entries, 0.85)) if (s.entry.exe === w.process.toLowerCase()) score = Math.max(score, s.score);
    const alias = APP_ALIASES[q];
    if (alias && alias.some((a) => normalizeText(a) === normalizeText(label))) score = Math.max(score, 0.97);
    // The title names it ("chiudi la finestra della bolletta")
    const title = normalizeText(w.title);
    if (q.length >= 4 && title.includes(q)) score = Math.max(score, 0.85);
    return { w, label, score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best < MIN_SCORE) return [];
  const label = scored.find((s) => s.score === best)!.label;
  return scored.filter((s) => s.label === label && s.score >= MIN_SCORE).map((s) => s.w);
}

/** The apps with a window open, by name, for <situation> (names only, never titles). */
export function openApps(windows: WindowInfo[], entries: AppEntry[], max = 12): string[] {
  return [...new Set(windows.map((w) => appLabel(w, entries)))].slice(0, max);
}
