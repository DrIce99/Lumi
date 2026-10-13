// Decides where Lumi looks. Every perception source produces candidates
// ({ rect, kind, salience, t }); each candidate's score is its kind's
// priority times its salience, decaying with age. The current target is
// kept unless something clearly more interesting shows up (hysteresis), so
// the eyes don't jump back and forth. Pure: no Electron, fully testable.
import type { AttentionKind } from "../../shared/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Candidate {
  /** Stable identity across updates ("mouse", "caret", "ocr:12"...); same id replaces the old one. */
  id: string;
  kind: AttentionKind;
  /** Screen DIP. The gaze goes to `point` when given, else to the rect's center. */
  rect: Rect;
  point?: { x: number; y: number };
  /** 0..1: how interesting this is at time `t`. */
  salience: number;
  /** When it was produced or last refreshed (ms). */
  t: number;
  /** Moves continuously (the mouse): followed with smooth pursuit. */
  moving?: boolean;
}

export interface AttentionContext {
  /** Lumi is listening to the user. */
  listening: boolean;
  /** Lumi is talking. */
  speaking: boolean;
}

export interface AttentionTarget {
  id: string;
  kind: AttentionKind;
  point: { x: number; y: number };
  pursuit: boolean;
}

/** Priority of each kind (README order): what Lumi talks about first, the user last. */
export const PRIORITY: Record<AttentionKind, number> = {
  speaking: 1,
  caret: 0.85,
  reading: 0.75,
  text: 0.7,
  change: 0.5,
  mouse: 0.4,
  user: 0.3,
  idle: 0,
};

/** How fast a candidate loses interest (half-life, ms). */
export const HALF_LIFE: Record<AttentionKind, number> = {
  speaking: 6000,
  caret: 2500,
  reading: 1500,
  text: 4000,
  change: 1200,
  mouse: 700,
  user: 4000,
  idle: 1000,
};

/** Below this score a candidate is forgotten. */
const MIN_SCORE = 0.05;
/** The current target keeps this advantage over challengers of the same rank. */
const HYSTERESIS = 1.3;
/** A target is kept at least this long unless a higher-priority kind shows up. */
const MIN_DWELL_MS = 350;

export function center(c: Pick<Candidate, "rect" | "point">): { x: number; y: number } {
  return c.point ?? { x: c.rect.x + c.rect.width / 2, y: c.rect.y + c.rect.height / 2 };
}

/** The priority of a candidate's kind in this context. */
export function rank(kind: AttentionKind, context: AttentionContext): number {
  // While listening Lumi looks at the user; while talking, at the user unless it talks about something
  if (kind === "user") return context.listening ? 0.8 : context.speaking ? 0.55 : PRIORITY.user;
  return PRIORITY[kind];
}

export function score(c: Candidate, now: number, context: AttentionContext): number {
  const age = Math.max(0, now - c.t);
  return rank(c.kind, context) * Math.max(0, Math.min(1, c.salience)) * Math.pow(0.5, age / HALF_LIFE[c.kind]);
}

export class Attention {
  private readonly candidates = new Map<string, Candidate>();
  private current: { id: string; since: number } | null = null;

  /** Adds or refreshes a candidate. */
  add(candidate: Candidate): void {
    this.candidates.set(candidate.id, candidate);
  }

  remove(id: string): void {
    this.candidates.delete(id);
  }

  /** Drops every candidate of a kind (e.g. when perception pauses). */
  clear(kind?: AttentionKind): void {
    if (!kind) {
      this.candidates.clear();
      this.current = null;
      return;
    }
    for (const [id, c] of this.candidates) if (c.kind === kind) this.candidates.delete(id);
  }

  candidatesNow(): Candidate[] {
    return [...this.candidates.values()];
  }

  /** The target to look at now, or null when nothing is worth a look. */
  select(now: number, context: AttentionContext): AttentionTarget | null {
    let best: Candidate | null = null;
    let bestScore = 0;
    for (const [id, c] of this.candidates) {
      const s = score(c, now, context);
      if (s < MIN_SCORE) {
        this.candidates.delete(id);
        continue;
      }
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (!best) {
      this.current = null;
      return null;
    }
    const held = this.current ? this.candidates.get(this.current.id) : undefined;
    if (held && held.id !== best.id) {
      const heldScore = score(held, now, context);
      const outranks = rank(best.kind, context) > rank(held.kind, context) + 1e-9;
      const dwellOver = now - this.current!.since >= MIN_DWELL_MS;
      // Keep the current target unless the challenger is a higher-priority kind,
      // or clearly more interesting once the minimum dwell is over
      if (!outranks && (!dwellOver || bestScore < heldScore * HYSTERESIS)) best = held;
    }
    if (!this.current || this.current.id !== best.id) this.current = { id: best.id, since: now };
    return { id: best.id, kind: best.kind, point: center(best), pursuit: best.moving === true };
  }
}
