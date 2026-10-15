// When a habit becomes a proposal ("Sono le 9: apro Spotify?"). Lumi
// proposes, it doesn't act: only habits the user marked "fai da sola" run
// by themselves. At most one proposal every N minutes, none in "Non
// disturbare", during a call, while the user types, while Lumi talks; a
// habit at most once a day. Answers move the confidence: accepted +0.1,
// rejected -0.15, archived below 0.3. Pure, tested.
import type { HabitRow } from "../memory/db";
import { slotOf } from "./patterns";

export interface TriggerContext {
  now: Date;
  /** The app in the foreground now (process name), and since when. */
  foreground: { app: string; since: number } | null;
  /** Apps that came to the foreground in the last hour, with when (ms). */
  recentApps: { app: string; at: number }[];
  /** Why no proposal may come now (do not disturb, call, typing, busy...), or null. */
  blocked: string | null;
  lastProposal: number;
  cooldownMs: number;
}

export const ACCEPT_STEP = 0.1;
export const REJECT_STEP = 0.15;
export const ARCHIVE_BELOW = 0.3;
/** Below this confidence a habit is not proposed (it is still watched). */
export const PROPOSE_ABOVE = 0.4;
/** A sequence fires when A came to the foreground this recently. */
const SEQUENCE_FRESH_MS = 60_000;

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function weekdayMatches(days: string, weekday: number): boolean {
  if (days === "ogni giorno") return true;
  if (days === "feriali") return weekday >= 1 && weekday <= 5;
  if (days === "weekend") return weekday === 0 || weekday === 6;
  return days === `giorno ${weekday}`;
}

/** The habit to propose (or do) now, or null. */
export function dueHabit(habits: HabitRow[], ctx: TriggerContext): HabitRow | null {
  if (ctx.blocked || ctx.now.getTime() - ctx.lastProposal < ctx.cooldownMs) return null;
  const now = ctx.now.getTime();
  const usedRecently = (app: string, withinMs: number) => ctx.foreground?.app === app || ctx.recentApps.some((r) => r.app === app && now - r.at < withinMs);
  const candidates = habits.filter((h) => {
    if (h.status !== "active" || h.confidence < PROPOSE_ABOVE) return false;
    if (h.lastProposed && sameLocalDay(new Date(h.lastProposed), ctx.now)) return false;
    if (h.kind === "time") {
      const slot = Number(h.detail.slot);
      const days = String(h.detail.days);
      // Around its half hour (people aren't clocks), and the app not opened yet
      const current = slotOf(ctx.now);
      return weekdayMatches(days, ctx.now.getDay()) && Math.abs(current - slot) <= 1 && !usedRecently(h.app, 60 * 60_000);
    }
    const after = String(h.detail.after);
    return ctx.foreground?.app === after && now - ctx.foreground.since < SEQUENCE_FRESH_MS && !usedRecently(h.app, 10 * 60_000);
  });
  return candidates.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

/** The confidence after an answer, and whether the habit is archived. */
export function afterAnswer(confidence: number, accepted: boolean): { confidence: number; archived: boolean } {
  const next = Math.min(1, Math.max(0, confidence + (accepted ? ACCEPT_STEP : -REJECT_STEP)));
  return { confidence: Math.round(next * 100) / 100, archived: next < ARCHIVE_BELOW };
}

/** "sì", "certo", "va bene"... or "no", "no grazie"... said right after a proposal; null when it is something else. */
export function readAnswer(text: string): boolean | null {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(si|si grazie|certo|ok|okay|va bene|dai|perfetto|volentieri|si dai|si per favore|apri|aprilo|aprila|fallo|vai)( lumi)?$/.test(t)) return true;
  if (/^(no|no grazie|non ora|adesso no|lascia stare|no lumi|non serve|dopo|magari dopo)( lumi)?$/.test(t)) return false;
  return null;
}
