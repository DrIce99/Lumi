// Push-to-talk: hold a global hotkey to talk. Electron's global shortcuts
// only report the key press (and its auto-repeat), so the release is
// detected by polling the key state through user32.
import { globalShortcut } from "electron";
import { log } from "../log";
import { acceleratorKey, keyDown } from "../perception/desktop";

const POLL_MS = 30;

export class PushToTalk {
  private accelerator = "";
  private held = false;
  private timer: NodeJS.Timeout | null = null;
  private virtualKey: number | null = null;

  constructor(
    private readonly onDown: () => void,
    private readonly onUp: () => void,
  ) {}

  /** Registers `accelerator` (empty: disabled). Returns false when another app already uses it. */
  register(accelerator: string): boolean {
    this.unregister();
    if (!accelerator) return true;
    this.virtualKey = acceleratorKey(accelerator);
    try {
      const ok = globalShortcut.register(accelerator, () => this.pressed());
      if (!ok) log.warn(`Push-to-talk key ${accelerator} is already used by another application`);
      if (ok) this.accelerator = accelerator;
      return ok;
    } catch (err) {
      log.warn(`Invalid push-to-talk key ${accelerator}`, err);
      return false;
    }
  }

  unregister(): void {
    if (this.accelerator) globalShortcut.unregister(this.accelerator);
    this.accelerator = "";
    this.release();
  }

  isHeld(): boolean {
    return this.held;
  }

  private pressed(): void {
    // Auto-repeat while the key stays down: only the first press counts
    if (this.held) return;
    this.held = true;
    this.onDown();
    this.timer = setInterval(() => {
      if (this.virtualKey === null || !keyDown(this.virtualKey)) this.release();
    }, POLL_MS);
  }

  private release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    this.onUp();
  }
}
