// Tracks whether the user is at the computer: input idle time, screen lock,
// and how long the current working session has lasted.
import { EventEmitter } from "node:events";

/** After this much input idle time the user counts as away. */
export const AWAY_AFTER_SEC = 5 * 60;
/** An absence this long ends a working session (it was a real break). */
const BREAK_MIN = 10;

export interface ActivitySnapshot {
  idleSec: number;
  away: boolean;
  locked: boolean;
  /** Minutes since the user came back from their last real break. */
  sessionMinutes: number;
  /** Minutes since the user went away (0 when present). */
  awayMinutes: number;
}

interface ActivityEvents {
  away: [];
  back: [minutesAway: number];
  lock: [];
  unlock: [];
}

export class Activity extends EventEmitter<ActivityEvents> {
  private idleSec = 0;
  private locked = false;
  private away = false;
  private awaySince = 0;
  private sessionStart: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly idleProvider: () => number,
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
    this.sessionStart = this.now();
  }

  start(intervalMs = 2000): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.locked = locked;
    this.emit(locked ? "lock" : "unlock");
    this.poll();
  }

  snapshot(): ActivitySnapshot {
    const now = this.now();
    return {
      idleSec: this.idleSec,
      away: this.away,
      locked: this.locked,
      sessionMinutes: Math.max(0, Math.round((now - this.sessionStart) / 60_000)),
      awayMinutes: this.away ? Math.round((now - this.awaySince) / 60_000) : 0,
    };
  }

  poll(): void {
    this.idleSec = this.idleProvider();
    const now = this.now();
    if (!this.away && (this.locked || this.idleSec >= AWAY_AFTER_SEC)) {
      this.away = true;
      this.awaySince = now - (this.locked ? 0 : this.idleSec * 1000);
      this.emit("away");
    } else if (this.away && !this.locked && this.idleSec < 5) {
      this.away = false;
      const minutes = (now - this.awaySince) / 60_000;
      if (minutes >= BREAK_MIN) this.sessionStart = now;
      this.emit("back", Math.round(minutes));
    }
  }
}
