// The mood of the day. Every morning (days start at 5:00) a mood is drawn
// with the user's weights; the mood the previous day ended in weighs 50%
// more, so a sadness nobody lifted tends to linger. It colors every answer
// (a line in <situation>; the face at rest stays neutral) and changes only
// through change_mood, called by the model when the user's words really
// affected it, one step at a time along the tree in shared/dayMood.ts. A
// strong mood resists: it first softens, then moves.
//
// The pure functions are exported for the tests; DayMood keeps the state in
// mood.json.
import { DAY_MOODS, isDayMood, MOOD_PARENT, MOOD_VALENCE, type DayMoodId, type MoodWeights } from "../../shared/dayMood";
import { readJson, writeJson } from "../jsonStore";

/** A day starts at this local hour: staying up past midnight is still the same day. */
export const DAY_START_HOUR = 5;
/** Changes closer than this are refused: one kind word doesn't undo a bad day. */
export const SHIFT_COOLDOWN_MS = 90_000;
/** Above this intensity a mood softens before it moves. */
export const RESIST_ABOVE = 0.5;
/** Weight factor for the mood the previous day ended in. */
export const CARRY_OVER = 1.5;

export interface MoodChange {
  at: string;
  from: DayMoodId;
  to: DayMoodId;
  intensity: number;
  reason: string;
}

export interface DayMoodState {
  /** Local date of the day this mood belongs to ("2026-10-18"). */
  day: string;
  /** The mood drawn this morning. */
  rolled: DayMoodId;
  mood: DayMoodId;
  /** 0.2-1: how strong it is. */
  intensity: number;
  /** When the current mood began (ISO). */
  since: string;
  /** Today's changes, oldest first (at most 20). */
  changes: MoodChange[];
}

export type ShiftOutcome = "changed" | "softened" | "stronger" | "same" | "cooldown";

/** The local date a moment belongs to: before DAY_START_HOUR it is still yesterday. */
export function dayKey(now: Date): string {
  const d = new Date(now.getTime() - DAY_START_HOUR * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Draws a mood with the weights; `previous` (yesterday's last mood) weighs CARRY_OVER times more. */
export function rollMood(weights: MoodWeights, previous: DayMoodId | null, random: () => number): DayMoodId {
  const w = DAY_MOODS.map((m) => Math.max(0, weights[m] ?? 0) * (m === previous ? CARRY_OVER : 1));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return "tranquilla";
  let r = random() * total;
  for (let i = 0; i < DAY_MOODS.length; i++) {
    r -= w[i];
    if (r < 0 && w[i] > 0) return DAY_MOODS[i];
  }
  // Rounding at the very end of the range: the last mood with a weight
  for (let i = DAY_MOODS.length - 1; i >= 0; i--) if (w[i] > 0) return DAY_MOODS[i];
  return "tranquilla";
}

/** A fresh day's mood: intensity 0.5-0.9. */
export function newDay(now: Date, weights: MoodWeights, previous: DayMoodId | null, random: () => number): DayMoodState {
  const mood = rollMood(weights, previous, random);
  return { day: dayKey(now), rolled: mood, mood, intensity: round(0.5 + random() * 0.4), since: now.toISOString(), changes: [] };
}

function ancestors(mood: DayMoodId): DayMoodId[] {
  const out: DayMoodId[] = [];
  for (let m = MOOD_PARENT[mood]; m; m = MOOD_PARENT[m]) out.push(m);
  return out;
}

/** The next mood on the way from `from` to `to`: a child toward `to` when it lies below, else the parent. */
export function stepToward(from: DayMoodId, to: DayMoodId): DayMoodId {
  if (from === to) return from;
  const path = [to, ...ancestors(to)];
  const at = path.indexOf(from);
  if (at > 0) return path[at - 1];
  return MOOD_PARENT[from] ?? from;
}

/**
 * Applies a change the model asked for. Toward calm, a mood above
 * RESIST_ABOVE first loses 0.3 intensity; asking for the same mood makes it
 * stronger. At most one change per SHIFT_COOLDOWN_MS.
 */
export function shiftMood(state: DayMoodState, to: DayMoodId, now: Date, reason: string): { state: DayMoodState; outcome: ShiftOutcome } {
  const last = state.changes.at(-1);
  if (last && now.getTime() - Date.parse(last.at) < SHIFT_COOLDOWN_MS) return { state, outcome: "cooldown" };
  const from = state.mood;
  let mood = from;
  let intensity = state.intensity;
  let outcome: ShiftOutcome;
  if (to === from) {
    if (from === "tranquilla") return { state, outcome: "same" };
    intensity = Math.min(1, intensity + 0.25);
    outcome = "stronger";
  } else {
    const step = stepToward(from, to);
    if (step === MOOD_PARENT[from] && intensity > RESIST_ABOVE) {
      intensity = Math.max(0.2, intensity - 0.3);
      outcome = "softened";
    } else {
      mood = step;
      intensity = step === MOOD_PARENT[from] ? 0.5 : 0.6;
      outcome = "changed";
    }
  }
  const change: MoodChange = { at: now.toISOString(), from, to: mood, intensity: round(intensity), reason: reason.slice(0, 200) };
  return {
    state: { ...state, mood, intensity: round(intensity), since: mood === from ? state.since : change.at, changes: [...state.changes, change].slice(-20) },
    outcome,
  };
}

/** What the model reads back after change_mood. */
export function describeShift(outcome: ShiftOutcome, before: DayMoodState, after: DayMoodState): string {
  switch (outcome) {
    case "cooldown":
      return `Your mood can't change again so soon: you are still ${after.mood}. Moods move slowly.`;
    case "same":
      return "You are calm, as before.";
    case "stronger":
      return `You feel ${after.mood} even more strongly now.`;
    case "softened":
      return `You are still ${after.mood}, but a little less (it takes more to change it). Let it show slightly.`;
    case "changed": {
      const better = MOOD_VALENCE[after.mood] > MOOD_VALENCE[before.mood];
      return `Your mood went from ${before.mood} to ${after.mood}${better ? ": you feel better" : ": you feel worse"}.`;
    }
  }
}

/** How each mood colors the answers (for the <situation> line). */
const MOOD_HINT: Record<DayMoodId, string> = {
  tranquilla: "calm and even, your usual self",
  allegra: "cheerful: light, playful, quick to joke",
  entusiasta: "bubbly and enthusiastic: energy, exclamations, joy in your eyes",
  annoiata: "bored: a bit flat and listless, short answers, a sigh or a deadpan line now and then (apatia sometimes)",
  malinconica: "wistful: softer and slower, a little sad under the surface",
  triste: "sad: low energy, gentle and sad replies, tristezza in your eyes often",
  irritata: "irritable: curt and a little prickly, easily annoyed, yet still helpful",
  arrabbiata: "angry: short, sharp answers, rabbia in your eyes; you still do what is asked, grudgingly",
};

function strength(intensity: number): string {
  return intensity >= 0.75 ? "strongly" : intensity > RESIST_ABOVE ? "clearly" : "slightly";
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The <situation> line: the mood, how strong, since when and why, and how it colors the answers. */
export function describeMood(state: DayMoodState): string {
  const last = state.changes.at(-1);
  const origin = !last ? `since ${clock(state.since)}, you woke up like this` : `since ${clock(last.at)}${last.reason ? `, because ${last.reason}` : ""}`;
  const parts = [`${state.mood}, ${strength(state.intensity)} (${origin}) - ${MOOD_HINT[state.mood]}`];
  if (state.rolled !== state.mood) parts.push(`you woke up ${state.rolled} today`);
  if (MOOD_VALENCE[state.mood] < 0) parts.push("only the user can make it better");
  return parts.join("; ");
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function readState(raw: unknown): { state: DayMoodState | null; last: DayMoodId | null } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const s = o.state && typeof o.state === "object" ? (o.state as Record<string, unknown>) : null;
  const ok = s && typeof s.day === "string" && isDayMood(s.mood) && isDayMood(s.rolled) && typeof s.intensity === "number" && typeof s.since === "string";
  const state = ok ? ({ ...(s as unknown as DayMoodState), changes: Array.isArray(s.changes) ? (s.changes as MoodChange[]) : [] } as DayMoodState) : null;
  return { state, last: state?.mood ?? null };
}

/** The mood of the day, kept in mood.json; a new day draws a new mood on first use. */
export class DayMood {
  private state: DayMoodState | null;

  constructor(
    private readonly file: string | null,
    private readonly weights: () => MoodWeights,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {
    this.state = readState(file ? readJson<unknown>(file) : null).state;
  }

  /** Today's mood (drawn now if the day changed). */
  current(): DayMoodState {
    const now = this.now();
    if (this.state?.day === dayKey(now)) return this.state;
    this.state = newDay(now, this.weights(), this.state?.mood ?? null, this.random);
    this.save();
    return this.state;
  }

  /** change_mood: returns the outcome and what the model reads. */
  shift(to: DayMoodId, reason: string): { outcome: ShiftOutcome; before: DayMoodState; after: DayMoodState; text: string } {
    const before = this.current();
    const { state: after, outcome } = shiftMood(before, to, this.now(), reason);
    if (after !== before) {
      this.state = after;
      this.save();
    }
    return { outcome, before, after, text: describeShift(outcome, before, after) };
  }

  /** Draws today's mood again (settings button). */
  reroll(): DayMoodState {
    this.state = newDay(this.now(), this.weights(), null, this.random);
    this.save();
    return this.state;
  }

  private save(): void {
    if (this.file && this.state) writeJson(this.file, { state: this.state });
  }
}
