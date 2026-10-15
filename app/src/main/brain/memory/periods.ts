// Weeks and months for the hierarchical summaries, and the names of the
// daily backups. Local time throughout: a "week" is Monday to Sunday where
// the user lives. Pure, tested.

export type PeriodKind = "week" | "month";

export interface PeriodSpan {
  kind: PeriodKind;
  /** ISO of the first instant and of the first instant after it. */
  start: string;
  end: string;
  /** How the summarizer and the model read it: "la settimana dal 9 al 15 marzo 2026". */
  label: string;
}

const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

/** Local Monday 00:00 of the week `d` is in. */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

export function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function weekSpan(d: Date): PeriodSpan {
  const start = weekStart(d);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  const from = start.getMonth() === last.getMonth() ? `${start.getDate()}` : `${start.getDate()} ${MONTHS[start.getMonth()]}`;
  return { kind: "week", start: start.toISOString(), end: end.toISOString(), label: `la settimana dal ${from} al ${last.getDate()} ${MONTHS[last.getMonth()]} ${last.getFullYear()}` };
}

export function monthSpan(d: Date): PeriodSpan {
  const start = monthStart(d);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { kind: "month", start: start.toISOString(), end: end.toISOString(), label: `${MONTHS[start.getMonth()]} ${start.getFullYear()}` };
}

/**
 * Weeks and months that are over, have at least one day summary and no
 * summary of their own yet: oldest first, weeks before months, at most
 * `max` (a long history catches up a few at a time).
 */
export function duePeriods(dayStarts: string[], existing: Set<string>, now: Date, max = 4): PeriodSpan[] {
  const thisWeek = weekStart(now).getTime();
  const thisMonth = monthStart(now).getTime();
  const weeks = new Map<string, PeriodSpan>();
  const months = new Map<string, PeriodSpan>();
  for (const iso of dayStarts) {
    const day = new Date(iso);
    if (Number.isNaN(day.getTime())) continue;
    const w = weekSpan(day);
    if (Date.parse(w.end) <= thisWeek && !existing.has(`week:${w.start}`)) weeks.set(w.start, w);
    const m = monthSpan(day);
    if (Date.parse(m.end) <= thisMonth && !existing.has(`month:${m.start}`)) months.set(m.start, m);
  }
  const byStart = (a: PeriodSpan, b: PeriodSpan) => a.start.localeCompare(b.start);
  return [...[...weeks.values()].sort(byStart), ...[...months.values()].sort(byStart)].slice(0, max);
}

// ---------------- backups ----------------

const BACKUP = /^memory-(\d{4}-\d{2}-\d{2})\.db$/;

export function backupName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `memory-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`;
}

/** The backups beyond the newest `keep` (other files are never touched). */
export function backupsToDelete(names: string[], keep: number): string[] {
  return names
    .filter((n) => BACKUP.test(n))
    .sort()
    .reverse()
    .slice(Math.max(0, keep));
}

export function isBackup(name: string): boolean {
  return BACKUP.test(name);
}
