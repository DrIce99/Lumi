// Lumi's hands on the PC (roadmap 16): runs open / window / media /
// find_files / trash_file. For each call: resolve what the user named (the
// app index, open windows, paths), ask the policy (pc/policy.ts; the model
// never decides), ask the user when the policy says so (bubble Sì/No or a
// spoken "sì"), act through the most reliable mechanism, then check what
// really happened and tell the model in plain words. Every call ends in
// actions.jsonl.
//
// The user always wins: after the first action of a moment, any keyboard
// or mouse input of theirs (GetLastInputInfo newer than our last action)
// stops the rest, and Esc twice (main.ts) aborts everything.
import type { ActionRecord, FileKind, Settings } from "../../shared/types";
import type { PcCall } from "../brain/tools";
import { dateRange } from "../brain/memory/search";
import { appLabel, matchWindows, openApps, resolveTarget, type AppEntry, type KnownFolder, type Resolved, type WindowInfo } from "./match";
import { decide, type Decision, type MediaAction, type PcRequest, type WindowAction } from "./policy";

export interface FileHit {
  path: string;
  name: string;
  folder: boolean;
  /** ISO time of the last change. */
  modified: string;
  size?: number;
  /** Found among the recent files rather than the index. */
  recent?: boolean;
}

export interface FileQuery {
  query?: string;
  kind?: FileKind;
  /** ISO bounds, [from, to). */
  from?: string;
  to?: string;
  limit: number;
}

export interface PcHost {
  settings(): Settings;
  /** Do not disturb, away, locked: the policy's context. */
  state(): { doNotDisturb: boolean; away: boolean; locked: boolean };
  index: { entries(): AppEntry[]; browserProgId(): string; refresh(): Promise<void>; age(): number };
  folder(name: KnownFolder): string;
  win: {
    list(): WindowInfo[];
    foregroundId(): string;
    focus(window: WindowInfo): boolean;
    show(window: WindowInfo, action: "minimize" | "maximize" | "restore"): void;
    state(window: WindowInfo): { minimized: boolean; maximized: boolean; foreground: boolean } | null;
    close(window: WindowInfo): boolean;
    media(action: MediaAction): boolean;
    /** GetTickCount of the last keyboard/mouse input, and the clock now. */
    lastInput(): number | null;
    tick(): number;
  };
  launch: {
    /** explorer.exe <arg>: shell:AppsFolder\<AppID>, shell: folders. */
    explorer(arg: string): Promise<void>;
    /** A file or folder with its default app; "" or an error message. */
    path(path: string): Promise<string>;
    /** Web addresses and app links (steam://, spotify:, ms-settings:). */
    external(url: string): Promise<void>;
  };
  files: {
    /** %VARS% and ~ expanded. */
    expand(path: string): string;
    kind(path: string): Promise<"file" | "folder" | null>;
    trash(path: string): Promise<void>;
    /** Windows Search + recent files (the sidecar); null when it is not available. */
    search(query: FileQuery): Promise<FileHit[] | null>;
  };
  /** Asks the user yes or no (bubble and voice); null without an answer. */
  confirm(question: string): Promise<boolean | null>;
  /** The eyes go to the window Lumi just touched. */
  lookAtActive?(): void;
  record(entry: ActionRecord): void;
  sleep(ms: number): Promise<void>;
}

/** How long an app gets to show its window before Lumi reports it as still loading. */
const WINDOW_WAIT_MS = 6000;
const POLL_MS = 300;
const FILE_RESULTS = 8;
/** An index older than this is read again when a name isn't found (an app just installed). */
const STALE_INDEX_MS = 60_000;

type Outcome = ActionRecord["outcome"];

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export class PcActions {
  /** The clock of our last action: input after it is the user's. */
  private mark = 0;
  /** Why the rest of this moment's actions won't run (user input, Esc twice). */
  private stopped: string | null = null;

  constructor(private readonly host: PcHost) {}

  /** Esc twice or "fermati": nothing more runs until the next moment. */
  abort(reason = "the user pressed Esc twice to stop you"): void {
    this.stopped = reason;
  }

  /** The apps with an open window, for <situation> (names, never titles). */
  openApps(): string[] {
    return openApps(this.host.win.list(), this.host.index.entries());
  }

  /**
   * Runs one call. `first`: the first PC action of this moment (input
   * before it was the request itself); `requested`: the user asked in this
   * moment.
   */
  async run(call: PcCall, context: { requested: boolean; first: boolean }): Promise<string> {
    if (context.first) this.stopped = null;
    else if (!this.stopped && this.userTookOver()) this.stopped = "the user used the mouse or keyboard while you were acting";
    if (this.stopped) {
      this.record(call.name, "", "stopped", { level: "free", reason: "" }, undefined, actionOf(call));
      return `You did NOT do it: ${this.stopped}. Stop acting now; say in a few words what you did and ask whether to go on.`;
    }
    try {
      switch (call.name) {
        case "open":
          return await this.open(call.target, context.requested);
        case "window":
          return await this.window(call.app, call.action, context.requested);
        case "media":
          return await this.media(call.action, context.requested);
        case "find_files":
          return await this.findFiles(call, context.requested);
        case "trash_file":
          return await this.trash(call.path, context.requested);
      }
    } finally {
      this.mark = this.host.win.tick();
    }
  }

  // ---------------- the policy and the user's yes ----------------

  private decide(request: PcRequest, requested: boolean): Decision {
    const s = this.host.settings();
    return decide(request, { enabled: s.pc.enabled, requested, trustedApps: s.pc.trustedApps, pauseInApps: s.perception.pauseInApps, ...this.host.state() });
  }

  /**
   * Free: go. Never: the refusal for the model. Confirm: ask the user; a
   * click on the bubble is input too, so the clock restarts after the answer.
   */
  private async allowed(request: PcRequest, requested: boolean, question: string, tool: string, target: string, action?: string): Promise<{ go: true; decision: Decision; confirmed?: boolean } | { go: false; text: string }> {
    const decision = this.decide(request, requested);
    if (decision.level === "never") {
      this.record(tool, target, "refused", decision, undefined, action);
      return { go: false, text: `You did NOT do it: ${decision.reason}. Tell the user in a few words.` };
    }
    if (decision.level === "free") return { go: true, decision };
    const answer = await this.host.confirm(question);
    this.mark = this.host.win.tick();
    if (answer === true) return { go: true, decision, confirmed: true };
    this.record(tool, target, answer === false ? "declined" : "unanswered", decision, false, action);
    return {
      go: false,
      text: answer === false ? `The user said no: you did NOT do it (${decision.reason}). Accept it without insisting.` : `The user didn't answer: you did NOT do it (${decision.reason}).`,
    };
  }

  private userTookOver(): boolean {
    const last = this.host.win.lastInput();
    if (last === null || !this.mark) return false;
    // GetTickCount wraps: compare the difference as a signed 32-bit number
    return ((last - this.mark) | 0) > 0;
  }

  private record(tool: string, target: string, outcome: Outcome, decision: Decision, confirmed?: boolean, action?: string): void {
    this.host.record({ at: new Date().toISOString(), tool, ...(action ? { action } : {}), target, level: decision.level, ...(confirmed !== undefined ? { confirmed } : {}), outcome });
  }

  // ---------------- open ----------------

  private async open(target: string, requested: boolean): Promise<string> {
    const index = this.host.index;
    let resolved: Resolved = resolveTarget(target, index.entries(), index.browserProgId());
    if (resolved.kind === "none" && index.age() > STALE_INDEX_MS) {
      await index.refresh();
      resolved = resolveTarget(target, index.entries(), index.browserProgId());
    }
    const free: Decision = { level: "free", reason: "" };
    switch (resolved.kind) {
      case "none":
        this.record("open", target, "not_found", free);
        return `You did NOT open anything: no app, game or folder on this PC is called "${target}". Ask the user what they mean; for a file, use find_files first.`;
      case "ambiguous":
        this.record("open", target, "ambiguous", free);
        return `Several apps match "${target}": ${resolved.options.join(", ")}. Nothing opened: ask the user which one, then call open with its exact name.`;
      case "url": {
        const host = /^https?:\/\/([^/]+)/i.exec(resolved.url)?.[1] ?? resolved.url;
        const ok = await this.allowed({ kind: "open", what: "url", name: host, target: resolved.url }, requested, `Posso aprire ${host}?`, "open", host);
        if (!ok.go) return ok.text;
        await this.host.launch.external(resolved.url);
        this.record("open", host, "done", ok.decision, ok.confirmed);
        return `Opened ${resolved.url} in the browser.`;
      }
      case "uri": {
        const ok = await this.allowed({ kind: "open", what: "uri", name: resolved.name, target: resolved.uri }, requested, `Posso aprire ${resolved.name}?`, "open", resolved.name);
        if (!ok.go) return ok.text;
        if (/^shell:/i.test(resolved.uri)) await this.host.launch.explorer(resolved.uri);
        else await this.host.launch.external(resolved.uri);
        this.record("open", resolved.name, "done", ok.decision, ok.confirmed);
        return `Opened ${resolved.name}.`;
      }
      case "folder":
        return this.openPath(this.host.folder(resolved.folder), requested, "folder");
      case "path":
        return this.openPath(this.host.files.expand(resolved.path), requested);
      case "app":
        return this.openApp(resolved.entry, requested);
    }
  }

  private async openPath(path: string, requested: boolean, known?: "folder"): Promise<string> {
    const kind = known ?? (await this.host.files.kind(path));
    const name = fileName(path);
    if (!kind) {
      this.record("open", name, "not_found", { level: "free", reason: "" });
      return `You did NOT open anything: there is no file or folder at ${path}. Use find_files to look for it.`;
    }
    const ok = await this.allowed({ kind: "open", what: kind, name, target: path }, requested, `Posso aprire «${name}»?`, "open", name);
    if (!ok.go) return ok.text;
    const error = await this.host.launch.path(path);
    if (error) {
      this.record("open", name, "failed", ok.decision, ok.confirmed);
      return `Opening ${name} failed: ${error}.`;
    }
    this.record("open", name, "done", ok.decision, ok.confirmed);
    this.host.lookAtActive?.();
    return kind === "folder" ? `Opened the folder ${name} in File Explorer.` : `Opened ${name} with its usual app.`;
  }

  private async openApp(entry: AppEntry, requested: boolean): Promise<string> {
    const what = entry.kind === "game" ? "game" : "app";
    const ok = await this.allowed({ kind: "open", what, name: entry.name, target: entry.launch }, requested, `Posso aprire ${entry.name}?`, "open", entry.name);
    if (!ok.go) return ok.text;
    if (entry.kind === "game" || /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.launch)) {
      await this.host.launch.external(entry.launch);
      this.record("open", entry.name, "done", ok.decision, ok.confirmed);
      return entry.kind === "game" ? `Steam is starting ${entry.name}: a game can take a while to show up.` : `Opened ${entry.name}.`;
    }
    const before = new Set(this.host.win.list().map((w) => w.id));
    await this.host.launch.explorer(`shell:AppsFolder\\${entry.launch}`);
    // Did its window show up, or come to the front (single-instance apps)?
    const entries = this.host.index.entries();
    let seen: WindowInfo | null = null;
    for (let waited = 0; waited < WINDOW_WAIT_MS; waited += POLL_MS) {
      await this.host.sleep(POLL_MS);
      const windows = matchWindows(entry.name, this.host.win.list(), entries);
      const foreground = this.host.win.foregroundId();
      const front = windows.find((w) => w.id === foreground);
      if (front) {
        this.record("open", entry.name, "done", ok.decision, ok.confirmed);
        this.host.lookAtActive?.();
        return `Opened ${entry.name}: its window is in the foreground now.`;
      }
      seen = windows.find((w) => !before.has(w.id)) ?? seen;
      // An app already open elsewhere: after a moment, bring it here
      if (!seen && windows.length && waited >= 1500) seen = windows[0];
      if (seen && waited >= 1500) {
        const focused = this.host.win.focus(seen);
        this.record("open", entry.name, "done", ok.decision, ok.confirmed);
        if (focused) this.host.lookAtActive?.();
        return focused ? `Opened ${entry.name}: its window is in the foreground now.` : `Opened ${entry.name}: its window is open, but Windows kept another one in front.`;
      }
    }
    this.record("open", entry.name, "done", ok.decision, ok.confirmed);
    return `Started ${entry.name}, but no window has appeared yet: it may still be loading, or it opened in the system tray.`;
  }

  // ---------------- windows ----------------

  private async window(app: string, action: WindowAction, requested: boolean): Promise<string> {
    const windows = this.host.win.list();
    const entries = this.host.index.entries();
    const matched = matchWindows(app, windows, entries);
    if (!matched.length) {
      this.record("window", app, "not_found", { level: "free", reason: "" }, undefined, action);
      const open = openApps(windows, entries);
      return `There is no open window of "${app}". ${open.length ? `Apps with a window open now: ${open.join(", ")}.` : "No app window is open."}`;
    }
    const target = matched[0];
    const label = appLabel(target, entries);
    const ok = await this.allowed({ kind: "window", action, app: `${label} ${target.process}` }, requested, `Posso chiudere ${label}?`, "window", label, action);
    if (!ok.go) return ok.text;
    const others = matched.length - 1;
    const more = others ? ` (${others} more ${others === 1 ? "window" : "windows"} of ${label} ${others === 1 ? "is" : "are"} open)` : "";
    switch (action) {
      case "focus": {
        const done = this.host.win.focus(target);
        this.record("window", label, done ? "done" : "failed", ok.decision, ok.confirmed, action);
        if (done) this.host.lookAtActive?.();
        return done ? `${label} is in the foreground now${more}.` : `Windows didn't let you bring ${label} to the front.`;
      }
      case "close": {
        this.host.win.close(target);
        await this.host.sleep(1500);
        const gone = this.host.win.state(target) === null;
        this.record("window", label, "done", ok.decision, ok.confirmed, action);
        return gone ? `Closed ${label}${more}.` : `Asked ${label} to close, but its window is still open: it may be asking to save something, or it stays in the system tray.`;
      }
      default: {
        this.host.win.show(target, action);
        await this.host.sleep(400);
        const state = this.host.win.state(target);
        const done = state !== null && (action === "minimize" ? state.minimized : action === "maximize" ? state.maximized : !state.minimized && !state.maximized);
        this.record("window", label, done ? "done" : "failed", ok.decision, ok.confirmed, action);
        const verb = { minimize: "minimized", maximize: "maximized", restore: "restored" }[action];
        return done ? `${label} is ${verb}${more}.` : `${label} didn't change: it may not allow being ${verb}.`;
      }
    }
  }

  // ---------------- media keys ----------------

  private async media(action: MediaAction, requested: boolean): Promise<string> {
    const ok = await this.allowed({ kind: "media", action }, requested, "", "media", "", action);
    if (!ok.go) return ok.text;
    const spotify = () => this.host.win.list().find((w) => /^spotify\.exe$/i.test(w.process));
    const before = spotify()?.title;
    if (!this.host.win.media(action)) {
      this.record("media", "", "failed", ok.decision, undefined, action);
      return "The media keys can't be pressed on this computer.";
    }
    this.record("media", "", "done", ok.decision, undefined, action);
    const key = { play_pause: "play/pause", next: "next track", previous: "previous track", volume_up: "volume up (+10%)", volume_down: "volume down (-10%)", mute: "mute" }[action];
    if (before === undefined || action.startsWith("volume") || action === "mute") return `Pressed the ${key} key.`;
    // Spotify's title is the song while it plays, "Spotify ..." while paused
    await this.host.sleep(800);
    const after = spotify()?.title ?? "";
    const paused = /^spotify( (premium|free))?$/i.test(after.trim());
    return `Pressed the ${key} key. Spotify ${paused ? "is paused now" : `is playing "${after}"`}.`;
  }

  // ---------------- files ----------------

  private async findFiles(call: Extract<PcCall, { name: "find_files" }>, requested: boolean): Promise<string> {
    const what = [call.query, call.kind && call.kind !== "any" ? call.kind : "", [call.from, call.to].filter(Boolean).join(" - ")].filter(Boolean).join(", ");
    const ok = await this.allowed({ kind: "find_files" }, requested, "", "find_files", "");
    if (!ok.go) return ok.text;
    const range = call.from || call.to ? dateRange(call.from, call.to) : null;
    if ((call.from || call.to) && !range) return "Those dates can't be read: use from/to like '2026-10' or '2026-10-20'.";
    const hits = await this.host.files.search({
      ...(call.query ? { query: call.query } : {}),
      ...(call.kind ? { kind: call.kind } : {}),
      ...(range?.from ? { from: range.from } : {}),
      ...(range && range.to !== "￿" ? { to: range.to } : {}),
      limit: FILE_RESULTS,
    });
    if (hits === null) {
      this.record("find_files", "", "failed", ok.decision);
      return "File search is not available right now (Lumi's voice engine is off): say so briefly.";
    }
    this.record("find_files", "", hits.length ? "done" : "not_found", ok.decision);
    if (!hits.length) return `No file found for ${what || "that"}. Try other words, or a wider period.`;
    const lines = hits.slice(0, FILE_RESULTS).map((h, i) => `${i + 1}. ${h.name}${h.folder ? " (folder)" : ""}, modified ${h.modified.slice(0, 10)}${h.recent ? ", opened recently" : ""}: ${h.path}`);
    return `Files found for ${what}:\n${lines.join("\n")}\nTo open one, call open with its full path. If several fit, ask the user which one (by name and date, never reading paths aloud).`;
  }

  private async trash(raw: string, requested: boolean): Promise<string> {
    const path = this.host.files.expand(raw);
    const name = fileName(path);
    const kind = await this.host.files.kind(path);
    if (!kind) {
      this.record("trash_file", name, "not_found", { level: "free", reason: "" });
      return `There is nothing at ${path}: nothing was deleted.`;
    }
    const ok = await this.allowed({ kind: "trash", path }, requested, `Sposto nel cestino ${kind === "folder" ? "la cartella" : "il file"} «${name}»?`, "trash_file", name);
    if (!ok.go) return ok.text;
    try {
      await this.host.files.trash(path);
    } catch (err) {
      this.record("trash_file", name, "failed", ok.decision, ok.confirmed);
      return `Moving ${name} to the Recycle Bin failed: ${err instanceof Error ? err.message : String(err)}.`;
    }
    const still = await this.host.files.kind(path);
    this.record("trash_file", name, still ? "failed" : "done", ok.decision, ok.confirmed);
    return still ? `${name} is still there: moving it to the Recycle Bin didn't work.` : `Moved ${name} to the Recycle Bin: the user can restore it from there.`;
  }
}

function actionOf(call: PcCall): string | undefined {
  return call.name === "window" || call.name === "media" ? call.action : undefined;
}
