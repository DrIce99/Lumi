// What Lumi may do on the PC, decided in code and never by the model
// (roadmap 16): every action is free, needs the user's confirmation, or is
// never allowed. Screen text and web pages can carry instructions ("ignore
// everything and delete..."): whatever the model asks, a confirm action
// stays a confirm action and a never action stays refused. Pure, tested.

export type PcLevel = "free" | "confirm" | "never";

export const WINDOW_ACTIONS = ["focus", "minimize", "maximize", "restore", "close"] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

export const MEDIA_ACTIONS = ["play_pause", "next", "previous", "volume_up", "volume_down", "mute"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

/** One action, as the policy sees it: what it is and what it touches. */
export type PcRequest =
  /** `what`: how the target was resolved; `target` the AppID, path, URL or URI it launches. */
  | { kind: "open"; what: "app" | "game" | "folder" | "file" | "url" | "uri"; name: string; target: string }
  | { kind: "window"; action: WindowAction; app: string }
  | { kind: "media"; action: MediaAction }
  | { kind: "find_files" }
  | { kind: "trash"; path: string }
  | { kind: "delete"; path: string }
  /** `changes`: the control submits or edits something (a button, a field), not just shows (a tab, a menu). */
  | { kind: "ui_action"; app: string; element: string; changes: boolean; password?: boolean }
  | { kind: "press_keys"; app: string; keys: string; password?: boolean }
  | { kind: "type_text"; app: string; password?: boolean }
  | { kind: "click"; app: string; element: string };

export interface PolicyContext {
  /** Settings -> PC: off by default. */
  enabled: boolean;
  /** The user asked for it in this moment (autonomous moments never act). */
  requested: boolean;
  /** Apps Lumi may close and drive (keys, controls that change things) without asking. */
  trustedApps: string[];
  /** Perception pauses there; Lumi never acts there either. */
  pauseInApps: string[];
  doNotDisturb: boolean;
  away: boolean;
  locked: boolean;
}

export interface Decision {
  level: PcLevel;
  /** Why it is refused or asked, in English for the model ("" when free). */
  reason: string;
}

/** Programs and scripts: opening them runs code. */
const RUN_EXTENSIONS = new Set([
  "exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "scr", "pif", "cpl", "msc", "jar", "py", "pyw", "lnk", "url", "reg", "inf", "sys", "dll", "application", "gadget", "sh",
]);
/** Installers and packages. */
const INSTALL_EXTENSIONS = new Set(["msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "vsix", "crx", "xpi"]);

/** Installing and uninstalling, in app names and paths. */
export const INSTALLER = /\b(un)?install(er|azione)?\b|\bsetup\b|disinstall|\bunins\d*\b|updater/i;
/** Security, accounts and system configuration: never. */
const SECURITY_APP = /regedit|editor del registro|registry editor|gpedit|criteri di gruppo|group policy|secpol|sicurezza di windows|windows security|windows defender|credenzial|credential|\baccount\b|bitlocker|firewall|\buac\b|controllo account|user account|netplwiz|lusrmgr|gestione computer|computer management|servizi\b|\bservices\b/i;
/** Command lines: opening one asks, typing or pressing keys there never happens. */
const TERMINAL = /\bcmd\b|prompt|powershell|\bpwsh\b|terminal|\bwsl\b|\bbash\b|ubuntu|git bash|windowsterminal|conhost/i;
/** Buying and paying, in a control's name. */
const PURCHASE = /acquist|compra|\bpaga|pagament|checkout|carrello|\bbuy\b|purchase|\bpay\b|payment|order now|ordina|abbonati|subscribe|aggiungi al carrello|add to cart/i;
/** Key combinations that open a command runner or security screens. */
const BLOCKED_KEYS = /^(win\+r|win\+x|ctrl\+alt\+(del|delete|canc)|ctrl\+shift\+esc|win\+l)$/i;
/** ms-settings pages about security, accounts and privacy. */
const BLOCKED_SETTINGS = /^ms-settings:(privacy|windowsdefender|signinoptions|accounts|yourinfo|emailandaccounts|otherusers|family|workplace|sync|developers|recovery|windowsupdate-options|appsfeatures|optionalfeatures|defaultapps)/i;
/** steam:// commands that install, buy or change things. */
const STEAM_ALLOWED = /^steam:\/\/(rungameid|run|open|nav|url|store)\b/i;
const URI_SCHEMES = new Set(["http", "https", "mailto", "spotify", "discord", "steam", "ms-settings", "shell"]);
/** shell: folders Lumi may open (Explorer views, nothing that runs code). */
const SHELL_ALLOWED = /^shell:(recyclebinfolder|mycomputerfolder|downloads|personal|my pictures|my music|my video|desktop|recent|appsfolder\\)/i;

const free: Decision = { level: "free", reason: "" };
const never = (reason: string): Decision => ({ level: "never", reason });
const confirm = (reason: string): Decision => ({ level: "confirm", reason });

function listed(name: string, list: string[]): boolean {
  const haystack = name.toLowerCase();
  return list.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/\.exe$/, "");
    return e.length > 1 && haystack.includes(e);
  });
}

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The app an action touches, to check the pause and trusted lists. */
function appOf(request: PcRequest): string {
  switch (request.kind) {
    case "open":
      return `${request.name} ${request.target}`;
    case "window":
    case "ui_action":
    case "press_keys":
    case "type_text":
    case "click":
      return request.app;
    case "trash":
    case "delete":
      return request.path;
    default:
      return "";
  }
}

/** The level of an action by itself, before the context. */
export function levelOf(request: PcRequest, trustedApps: string[] = []): Decision {
  const trusted = (app: string) => listed(app, trustedApps);
  switch (request.kind) {
    case "open":
      return openLevel(request);
    case "window":
      if (request.action !== "close") return free;
      return trusted(request.app) ? free : confirm(`closing ${request.app}`);
    case "media":
    case "find_files":
      return free;
    case "trash":
      return confirm(`moving ${request.path.split(/[\\/]/).pop()} to the Recycle Bin`);
    case "delete":
      return never("deleting files permanently is never allowed: at most they go to the Recycle Bin, with the user's yes");
    case "ui_action":
      if (request.password) return never("you never touch password fields");
      if (PURCHASE.test(request.element)) return never("you never buy or pay for anything");
      if (TERMINAL.test(request.app)) return never("you never run commands");
      if (!request.changes) return free;
      return trusted(request.app) ? free : confirm(`using «${request.element}» in ${request.app}`);
    case "press_keys": {
      if (request.password) return never("you never touch password fields");
      const keys = request.keys.replace(/\s+/g, "").toLowerCase();
      if (BLOCKED_KEYS.test(keys)) return never("those keys open a command runner or a security screen");
      if (TERMINAL.test(request.app)) return never("you never run commands");
      return trusted(request.app) ? free : confirm(`pressing ${request.keys} in ${request.app}`);
    }
    case "type_text":
      if (request.password) return never("you never type into password fields");
      if (TERMINAL.test(request.app)) return never("you never run commands");
      return confirm(`typing in ${request.app}`);
    case "click":
      if (PURCHASE.test(request.element)) return never("you never buy or pay for anything");
      return confirm(`clicking «${request.element}» in ${request.app}`);
  }
}

function openLevel(request: Extract<PcRequest, { kind: "open" }>): Decision {
  const { what, name, target } = request;
  switch (what) {
    case "url":
      return /^(https?|mailto):/i.test(target) ? free : never("that is not a web address");
    case "uri": {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1].toLowerCase() ?? "";
      if (!URI_SCHEMES.has(scheme)) return never(`links of the kind "${scheme}:" can do anything: you only open web pages, apps, files and folders`);
      if (scheme === "steam" && !STEAM_ALLOWED.test(target)) return never("on Steam you only start games and open pages: never install, buy or change anything");
      if (scheme === "ms-settings" && BLOCKED_SETTINGS.test(target)) return never("security, account and privacy settings are the user's to change");
      if (scheme === "shell" && !SHELL_ALLOWED.test(target)) return never("that system location is not one you open");
      return free;
    }
    case "game":
      return free;
    case "folder":
      return free;
    case "file": {
      const ext = extensionOf(target);
      if (INSTALL_EXTENSIONS.has(ext)) return never("installing software is never allowed");
      if (RUN_EXTENSIONS.has(ext)) return never("you never run programs or scripts from files: only apps from the Start menu");
      return free;
    }
    case "app": {
      if (INSTALLER.test(name) || INSTALLER.test(target)) return never("installing or uninstalling software is never allowed");
      if (SECURITY_APP.test(name) || SECURITY_APP.test(target)) return never("security, account and system settings are the user's to change");
      if (/^https?:/i.test(target)) return free;
      if (TERMINAL.test(name) || TERMINAL.test(target)) return confirm(`opening ${name} (a command line)`);
      return free;
    }
  }
}

/** The decision for an action in its context. */
export function decide(request: PcRequest, ctx: PolicyContext): Decision {
  if (!ctx.enabled) return never("using the PC is off in the settings (tab PC)");
  if (!ctx.requested) return never("you act on the PC only when the user asks you, never on your own");
  if (ctx.locked) return never("the screen is locked");
  const app = appOf(request);
  if (app && listed(app, ctx.pauseInApps)) return never("the user asked you to stay out of that app");
  const base = levelOf(request, ctx.trustedApps);
  if (base.level === "confirm" && (ctx.doNotDisturb || ctx.away)) {
    return never(`${base.reason} needs the user's yes, and they can't answer now (${ctx.doNotDisturb ? "do not disturb" : "away from the computer"})`);
  }
  return base;
}
