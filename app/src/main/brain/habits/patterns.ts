// Habits from what the user does, without a model: deterministic counting
// over the "app" events (a new app in the foreground). Two kinds:
// - time: the user opens X around the same half hour on the same days
//   ("nei giorni feriali verso le 9 apri Spotify");
// - sequence: after A the user goes to B ("dopo VS Code apri Discord").
// A pattern becomes a hypothesis at >= minOccurrences and >= minFrequency.
// Local time throughout. Pure, tested.

export interface AppEvent {
  /** ISO time the app came to the foreground. */
  ts: string;
  app: string;
}

export type DayGroup = "ogni giorno" | "feriali" | "weekend" | `giorno ${number}`;

export interface TimePattern {
  kind: "time";
  key: string;
  app: string;
  days: DayGroup;
  /** Half-hour slot of the day, 0..47 (18 = 9:00-9:30). */
  slot: number;
  /** Days the user opened the app around that slot, and the share of observed days. */
  occurrences: number;
  frequency: number;
}

export interface SequencePattern {
  kind: "sequence";
  key: string;
  /** After `after` the user opens `app`. */
  after: string;
  app: string;
  occurrences: number;
  frequency: number;
}

export type Pattern = TimePattern | SequencePattern;

export interface PatternOptions {
  minOccurrences: number;
  minFrequency: number;
}

export const DEFAULT_PATTERN_OPTIONS: PatternOptions = { minOccurrences: 5, minFrequency: 0.7 };
/** B counts as following A when it comes within this time. */
export const SEQUENCE_WINDOW_MS = 10 * 60_000;

const WEEKDAY_NAMES = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function slotOf(d: Date): number {
  return d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
}

/** "9:00" for slot 18. */
export function slotTime(slot: number): string {
  return `${Math.floor(slot / 2)}:${slot % 2 ? "30" : "00"}`;
}

function inGroup(group: DayGroup, weekday: number): boolean {
  if (group === "ogni giorno") return true;
  if (group === "feriali") return weekday >= 1 && weekday <= 5;
  if (group === "weekend") return weekday === 0 || weekday === 6;
  return Number(group.slice(7)) === weekday;
}

/** "nei giorni feriali", "il lunedì"... */
export function groupText(group: DayGroup): string {
  if (group === "ogni giorno") return "ogni giorno";
  if (group === "feriali") return "nei giorni feriali";
  if (group === "weekend") return "nel fine settimana";
  const weekday = Number(group.slice(7));
  return `il ${WEEKDAY_NAMES[weekday]}`;
}

/**
 * Time habits: for each app and half-hour slot (an opening in the slot
 * before or after counts too: people aren't clocks), the days with an
 * opening over the days observed in each day group. The broadest group
 * that passes wins (every day > weekdays/weekend > one weekday), but only
 * if it holds on each weekday it contains: "every day" for something done
 * only on weekdays would be wrong even when the total passes.
 */
export function timePatterns(events: AppEvent[], options: PatternOptions = DEFAULT_PATTERN_OPTIONS): TimePattern[] {
  const observed = new Map<string, number>();
  const openings = new Map<string, Map<number, Set<string>>>();
  /** Openings exactly in a slot (not the neighbors): where the habit really sits. */
  const exact = new Map<string, Map<number, number>>();
  for (const e of events) {
    const d = new Date(e.ts);
    if (Number.isNaN(d.getTime())) continue;
    const day = localDay(d);
    observed.set(day, d.getDay());
    let slots = openings.get(e.app);
    if (!slots) openings.set(e.app, (slots = new Map()));
    const slot = slotOf(d);
    let counts = exact.get(e.app);
    if (!counts) exact.set(e.app, (counts = new Map()));
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
    for (const s of [slot - 1, slot, slot + 1]) {
      if (s < 0 || s > 47) continue;
      let days = slots.get(s);
      if (!days) slots.set(s, (days = new Set()));
      days.add(day);
    }
  }
  const groups: DayGroup[] = ["ogni giorno", "feriali", "weekend", ...[0, 1, 2, 3, 4, 5, 6].map((d) => `giorno ${d}` as DayGroup)];
  const out: TimePattern[] = [];
  for (const [app, slots] of openings) {
    const candidates: TimePattern[] = [];
    for (const [slot, days] of slots) {
      for (const group of groups) {
        const daysInGroup = [...observed].filter(([, weekday]) => inGroup(group, weekday)).map(([day]) => day);
        if (!daysInGroup.length) continue;
        const hits = daysInGroup.filter((d) => days.has(d)).length;
        const frequency = hits / daysInGroup.length;
        if (hits < options.minOccurrences || frequency < options.minFrequency) continue;
        // Each weekday in the group must hold too (a little looser: few weeks are few samples)
        const holds = [0, 1, 2, 3, 4, 5, 6]
          .filter((w) => inGroup(group, w))
          .every((w) => {
            const ofDay = [...observed].filter(([, weekday]) => weekday === w).map(([day]) => day);
            return !ofDay.length || ofDay.filter((d) => days.has(d)).length / ofDay.length >= options.minFrequency * 0.75;
          });
        if (!holds) continue;
        candidates.push({ kind: "time", key: `time:${app}:${group}:${slot}`, app, days: group, slot, occurrences: hits, frequency });
        break;
      }
    }
    // Neighboring slots describe the same habit: keep the strongest of each run, at the slot where the openings really are
    const centered = exact.get(app) ?? new Map<number, number>();
    candidates.sort((a, b) => b.frequency - a.frequency || (centered.get(b.slot) ?? 0) - (centered.get(a.slot) ?? 0) || b.occurrences - a.occurrences);
    const kept: TimePattern[] = [];
    for (const c of candidates) if (!kept.some((k) => Math.abs(k.slot - c.slot) <= 2)) kept.push(c);
    out.push(...kept);
  }
  return out.sort((a, b) => b.frequency - a.frequency || a.key.localeCompare(b.key));
}

/** Sequences: A then B (another app within 10 minutes), over all the times A was followed by something. */
export function sequencePatterns(events: AppEvent[], options: PatternOptions = DEFAULT_PATTERN_OPTIONS): SequencePattern[] {
  const after = new Map<string, Map<string, number>>();
  const total = new Map<string, number>();
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.app === b.app || Date.parse(b.ts) - Date.parse(a.ts) > SEQUENCE_WINDOW_MS) continue;
    total.set(a.app, (total.get(a.app) ?? 0) + 1);
    let next = after.get(a.app);
    if (!next) after.set(a.app, (next = new Map()));
    next.set(b.app, (next.get(b.app) ?? 0) + 1);
  }
  const out: SequencePattern[] = [];
  for (const [a, next] of after) {
    const n = total.get(a) ?? 0;
    for (const [b, count] of next) {
      const frequency = count / n;
      if (count >= options.minOccurrences && frequency >= options.minFrequency) out.push({ kind: "sequence", key: `seq:${a}:${b}`, after: a, app: b, occurrences: count, frequency });
    }
  }
  return out.sort((x, y) => y.frequency - x.frequency || x.key.localeCompare(y.key));
}

export function findPatterns(events: AppEvent[], options: PatternOptions = DEFAULT_PATTERN_OPTIONS): Pattern[] {
  return [...timePatterns(events, options), ...sequencePatterns(events, options)];
}

/** A plain Italian name, used when no model names the habit. */
export function defaultName(p: Pattern, label: (app: string) => string = (a) => a): string {
  if (p.kind === "time") return `${groupText(p.days)} verso le ${slotTime(p.slot)} apri ${label(p.app)}`;
  return `dopo ${label(p.after)} apri ${label(p.app)}`;
}
