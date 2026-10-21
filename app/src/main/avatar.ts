// What the 3D avatar loads: the bundled Lumi.vrm or the user's VRM, plus the
// user's extra gesture clips (Mixamo .fbx or .vrma files in
// %APPDATA%\Lumi\animations, named after the gesture: "wave.fbx" replaces
// the built-in wave, "dance.fbx" adds "dance"). The renderer reads them
// through app:// mounts, never straight from the disk. Idle routines live in
// animations\idle\<name>\ (enter.vrma, loop.vrma, exit.vrma, routine.json,
// as sidecar/motion writes them): a subfolder, so they never become gestures.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { toEmotion } from "../shared/emotions";
import { clipName } from "../shared/gestures";
import { IDLE_CAMERAS, type AvatarConfig, type IdleCamera, type IdleRoutine } from "../shared/types";
import { log } from "./log";
import { APP_ORIGIN, mountAppPath } from "./protocol";

export const BUNDLED_MODEL = `${APP_ORIGIN}/renderer/avatar/Lumi.vrm`;

export class AvatarFiles {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The idle routines as last read (main asks twice a second); null = read the folder again. */
  private idleCache: Record<string, IdleRoutine> | null = null;

  constructor(
    readonly clipsDir: string,
    private readonly changed: () => void,
  ) {
    try {
      mkdirSync(clipsDir, { recursive: true });
      // New clips dropped in the folder are picked up without a restart
      this.watcher = watch(clipsDir, { recursive: true }, () => {
        this.idleCache = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.changed(), 500);
      });
    } catch (err) {
      log.warn(`Cannot watch ${clipsDir}`, err);
    }
    mountAppPath("/user/animations/", clipsDir);
  }

  /** The model and the clips now; `model`: the settings' VRM path ("" = bundled). */
  config(model: string): AvatarConfig {
    let url = BUNDLED_MODEL;
    if (model && existsSync(model)) {
      mountAppPath("/user/model.vrm", model);
      // A new file at the same path must not come from the cache
      url = `${APP_ORIGIN}/user/model.vrm?v=${Math.round(statSync(model).mtimeMs)}`;
    } else {
      if (model) log.warn("The VRM model in the settings doesn't exist: using the bundled one");
      mountAppPath("/user/model.vrm", null);
    }
    return { model: url, clips: this.clips(), idles: this.idles() };
  }

  /** Routine name -> routine, for the complete folders in animations\idle. */
  idles(): Record<string, IdleRoutine> {
    return (this.idleCache ??= this.readIdles());
  }

  private readIdles(): Record<string, IdleRoutine> {
    const out: Record<string, IdleRoutine> = {};
    const root = join(this.clipsDir, "idle");
    let names: string[] = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return out;
    }
    for (const folder of names) {
      const dir = join(root, folder);
      const files = ["enter", "loop", "exit"].map((part) => join(dir, `${part}.vrma`));
      if (!files.every((f) => existsSync(f))) continue;
      let raw: unknown = {};
      try {
        if (existsSync(join(dir, "routine.json"))) raw = JSON.parse(readFileSync(join(dir, "routine.json"), "utf-8"));
      } catch (err) {
        log.warn(`Idle routine ${folder}: routine.json unreadable`, err);
      }
      // A new take copied over the old one must not come from the cache
      const version = Math.round(Math.max(...files.map((f) => statSync(f).mtimeMs)));
      const url = (part: string) => `${APP_ORIGIN}/user/animations/idle/${encodeURIComponent(folder)}/${part}.vrma?v=${version}`;
      const routine = parseRoutine(folder, raw, url);
      if (routine) out[routine.name] = routine;
    }
    return out;
  }

  /** Gesture name -> clip URL, for the files in the folder. */
  clips(): Record<string, string> {
    const out: Record<string, string> = {};
    let files: string[] = [];
    try {
      files = readdirSync(this.clipsDir);
    } catch {
      return out;
    }
    for (const file of files.sort()) {
      const name = clipName(file);
      if (name && !out[name]) out[name] = `${APP_ORIGIN}/user/animations/${encodeURIComponent(file)}`;
    }
    return out;
  }

  dispose(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }
}

export function clipsDirIn(dataDir: string): string {
  return join(dataDir, "animations");
}

/** An idle routine from its folder name and routine.json (anything missing gets a default); null for a bad name. */
export function parseRoutine(folder: string, raw: unknown, url: (part: "enter" | "loop" | "exit") => string): IdleRoutine | null {
  const name = clipName(`${folder}.vrma`);
  if (!name) return null;
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const face = r.face && typeof r.face === "object" ? (r.face as Record<string, unknown>) : {};
  const seconds = r.seconds && typeof r.seconds === "object" ? (r.seconds as Record<string, unknown>) : {};
  const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
  const camera = IDLE_CAMERAS.includes(r.camera as IdleCamera) ? (r.camera as IdleCamera) : "bust";
  const eyes = face.eyes === "closed" || face.eyes === "sleepy" ? face.eyes : "open";
  const walk = r.walk === true || typeof r.walkSpeed === "number";
  return {
    name,
    enter: url("enter"),
    loop: url("loop"),
    exit: url("exit"),
    camera,
    prop: r.prop === "book" ? "book" : null,
    face: { eyes, mouth: num(face.mouth, 0, 0, 1) },
    wake: typeof r.wake === "string" ? (toEmotion(r.wake) ?? null) : null,
    walkSpeed: walk ? num(r.walkSpeed, 0.8, 0.1, 3) : null,
    seconds: { enter: num(seconds.enter, 3, 0.1, 30), loop: num(seconds.loop, 6, 0.5, 30), exit: num(seconds.exit, 3, 0.1, 30) },
  };
}
