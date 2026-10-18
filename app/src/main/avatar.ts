// What the 3D avatar loads: the bundled Lumi.vrm or the user's VRM, plus the
// user's extra gesture clips (Mixamo .fbx or .vrma files in
// %APPDATA%\Lumi\animations, named after the gesture: "wave.fbx" replaces
// the built-in wave, "dance.fbx" adds "dance"). The renderer reads them
// through app:// mounts, never straight from the disk.
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { clipName } from "../shared/gestures";
import type { AvatarConfig } from "../shared/types";
import { log } from "./log";
import { APP_ORIGIN, mountAppPath } from "./protocol";

export const BUNDLED_MODEL = `${APP_ORIGIN}/renderer/avatar/Lumi.vrm`;

export class AvatarFiles {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly clipsDir: string,
    private readonly changed: () => void,
  ) {
    try {
      mkdirSync(clipsDir, { recursive: true });
      // New clips dropped in the folder are picked up without a restart
      this.watcher = watch(clipsDir, () => {
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
    return { model: url, clips: this.clips() };
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
