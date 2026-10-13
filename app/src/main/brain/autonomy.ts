// Decides when Lumi gets an autonomous moment (a spontaneous comment in a
// pause). The interval follows the sociability setting; the model can push
// the next moment back with stay_quiet, within limits.
import type { Sociability } from "../../shared/types";

/** Typical minutes between autonomous moments. */
const BASE_MINUTES: Record<Sociability, number> = { silenzioso: Infinity, discreto: 20, normale: 8, chiacchierone: 4 };
/** The earliest the next moment may come. */
const MIN_MINUTES: Record<Sociability, number> = { silenzioso: Infinity, discreto: 8, normale: 3, chiacchierone: 1.5 };

export class Autonomy {
  private nextAt: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sociability: () => Sociability,
    /** Whether a moment may run now (brain available, user present, not busy...). */
    private readonly canRun: () => boolean,
    private readonly run: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.nextAt = this.now() + 3 * 60_000;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The model asked for its next moment in `minutes` (stay_quiet). */
  scheduleIn(minutes: number): void {
    const s = this.sociability();
    const clamped = Math.min(240, Math.max(MIN_MINUTES[s], minutes));
    if (Number.isFinite(clamped)) this.nextAt = this.now() + clamped * 60_000;
  }

  /** Pushes the next moment back (rate limits, outages, a conversation that just happened). */
  backOff(minutes: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + minutes * 60_000);
  }

  millisUntilNext(): number {
    return this.nextAt - this.now();
  }

  check(): void {
    if (this.now() < this.nextAt) return;
    const base = BASE_MINUTES[this.sociability()];
    if (!Number.isFinite(base) || !this.canRun()) {
      this.nextAt = this.now() + 60_000;
      return;
    }
    // Default for the following moment; the run may override it via scheduleIn
    this.nextAt = this.now() + base * (0.75 + Math.random() * 0.5) * 60_000;
    this.run();
  }
}
