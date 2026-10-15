// Habits (phase 11): what the user does goes into the events table (the
// app in the foreground, commands to Lumi, proposals and their answers,
// sessions), never what is on screen. The reflection, when the PC is idle,
// turns the events into habits (patterns.ts) and names them; the triggers
// propose them at the right time (triggers.ts). Lumi only proposes: it
// acts by itself only for the habits the user marked "fai da sola", and
// the only action is opening the app the user always opens.
import type { HabitInfo, Settings } from "../../../shared/types";
import { log } from "../../log";
import type { ForegroundWindow } from "../../perception/desktop";
import type { HabitRow } from "../memory/db";
import type { MemoryStore } from "../memory/store";
import { defaultName, findPatterns, type AppEvent, type Pattern } from "./patterns";
import { afterAnswer, dueHabit } from "./triggers";

export interface HabitsHost {
  settings(): Settings;
  store: MemoryStore | null;
  foreground(): ForegroundWindow | null;
  /** Why perception is paused (an app on the pause list, a private window...): those apps are never logged. */
  paused(): string | null;
  /** Why no proposal may come now (do not disturb, a call, typing, Lumi busy, away...), or null. */
  blocked(): string | null;
  idleSec(): number;
  onBattery(): boolean;
  /** Names new habits in a few Italian words (the idle model); null when no model is available. */
  name(patterns: { pattern: Pattern; text: string }[]): Promise<string[] | null>;
  /** Asks the user (voice and a bubble); true/false, or null without an answer. */
  propose(habit: HabitRow, question: string): Promise<boolean | null>;
  /** Opens the habit's app; returns an error, or null. */
  open(habit: HabitRow): Promise<string | null>;
  /** "Spotify" for "Spotify.exe". */
  label(app: string): string;
  /** Lumi says something (a habit done by itself). */
  say(text: string): void;
  now?(): number;
}

/** Foreground changes count only after the app stays this long (alt-tab through windows is not a habit). */
const STABLE_MS = 4000;
const POLL_MS = 2000;
const TRIGGER_MS = 30_000;
const REFLECT_CHECK_MS = 5 * 60_000;
/** Patterns read the last 8 weeks; older events go after 12. */
const WINDOW_DAYS = 56;
const KEEP_DAYS = 84;
const REFLECT_EVERY_MS = 20 * 3_600_000;

export class Habits {
  private timers: NodeJS.Timeout[] = [];
  private current: { app: string; path: string; since: number } | null = null;
  private candidate: { app: string; path: string; since: number } | null = null;
  private recent: { app: string; at: number }[] = [];
  private active: HabitRow[] = [];
  private all: HabitRow[] = [];
  private lastProposal = Number.NEGATIVE_INFINITY;
  private lastReflection = 0;
  private reflecting = false;
  private proposing = false;

  constructor(private readonly host: HabitsHost) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  private enabled(): boolean {
    return this.host.settings().habits.enabled && this.host.store !== null;
  }

  async start(): Promise<void> {
    await this.refresh();
    const events = (await this.host.store?.eventsSince(new Date(this.now() - 30 * 86_400_000).toISOString(), ["reflection"])) ?? [];
    this.lastReflection = events.length ? Date.parse(events[events.length - 1].ts) : 0;
    this.timers.push(setInterval(() => this.pollForeground(), POLL_MS));
    this.timers.push(setInterval(() => void this.checkTriggers(), TRIGGER_MS));
    this.timers.push(setInterval(() => void this.maybeReflect(), REFLECT_CHECK_MS));
    for (const t of this.timers) t.unref();
    this.session("start");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.session("end");
  }

  // ---------------- events ----------------

  private log(kind: string, app?: string, detail?: Record<string, unknown>): void {
    if (!this.enabled()) return;
    this.host.store?.logEvent({ ts: new Date(this.now()).toISOString(), kind, ...(app ? { app } : {}), ...(detail ? { detail } : {}) });
  }

  /** The user gave Lumi a command (only how, never what: the conversation is in memory). */
  command(via: string): void {
    this.log("command", undefined, { via });
  }

  session(what: "start" | "end" | "away" | "back"): void {
    this.log("session", undefined, { what });
  }

  /** Every 2 s: a new app in the foreground, once it stays a few seconds, is an event. */
  pollForeground(): void {
    if (!this.enabled()) return;
    const now = this.now();
    const fg = this.host.foreground();
    // Paused apps and private windows are never logged
    if (!fg || !fg.process || this.host.paused()) {
      this.candidate = null;
      return;
    }
    const app = fg.process;
    if (this.current?.app === app) {
      this.candidate = null;
      return;
    }
    if (this.candidate?.app !== app) {
      this.candidate = { app, path: fg.path ?? "", since: now };
      return;
    }
    if (now - this.candidate.since < STABLE_MS) return;
    this.current = this.candidate;
    this.candidate = null;
    this.recent = [...this.recent.filter((r) => now - r.at < 3_600_000), { app, at: this.current.since }];
    this.log("app", app, this.current.path ? { path: this.current.path } : undefined);
  }

  // ---------------- reflection ----------------

  /** When the PC rests (at night, or 30 minutes idle on AC), at most once every 20 hours. */
  async maybeReflect(force = false): Promise<void> {
    if (!this.enabled() || this.reflecting) return;
    const now = this.now();
    const hour = new Date(now).getHours();
    const idle = this.host.idleSec();
    const rest = (hour >= 1 && hour < 6 && idle >= 600) || (idle >= 1800 && !this.host.onBattery());
    if (!force && (!rest || now - this.lastReflection < REFLECT_EVERY_MS)) return;
    await this.reflect();
  }

  /** Patterns from the last weeks become habits (new ones named), the ones that faded lose confidence. */
  async reflect(): Promise<{ added: number; faded: number }> {
    const store = this.host.store;
    if (!store) return { added: 0, faded: 0 };
    this.reflecting = true;
    try {
      const now = this.now();
      const events = await store.eventsSince(new Date(now - WINDOW_DAYS * 86_400_000).toISOString(), ["app"]);
      const appEvents: AppEvent[] = events.filter((e) => e.app).map((e) => ({ ts: e.ts, app: e.app! }));
      const s = this.host.settings().habits;
      const patterns = findPatterns(appEvents, { minOccurrences: s.minOccurrences, minFrequency: s.minFrequency });
      const known = new Map((await store.listHabits(true)).map((h) => [h.key, h]));
      const paths = new Map<string, string>();
      for (const e of events) if (e.app && typeof e.detail?.path === "string") paths.set(e.app, e.detail.path);
      const fresh = patterns.filter((p) => !known.has(p.key));
      const texts = fresh.map((p) => ({ pattern: p, text: defaultName(p, (a) => this.host.label(a)) }));
      const names = fresh.length ? await this.host.name(texts).catch(() => null) : null;
      for (const p of patterns) {
        const detail = { ...(p.kind === "time" ? { days: p.days, slot: p.slot } : { after: p.after }), occurrences: p.occurrences, frequency: Math.round(p.frequency * 100) / 100, ...(paths.get(p.app) ? { path: paths.get(p.app) } : {}) };
        const isNew = !known.has(p.key);
        const index = fresh.indexOf(p);
        const name = isNew ? (names?.[index]?.trim() || texts[index].text) : known.get(p.key)!.name;
        await store.upsertHabit({ key: p.key, kind: p.kind, name: name.slice(0, 120), app: p.app, detail, confidence: Math.round(Math.min(0.8, p.frequency * 0.85) * 100) / 100 });
      }
      // Habits that no longer show up fade, and go when they fade too much
      const seen = new Set(patterns.map((p) => p.key));
      let faded = 0;
      for (const h of known.values()) {
        if (h.status !== "active" || seen.has(h.key)) continue;
        const next = afterAnswer(h.confidence + 0.05, false);
        await store.updateHabit(h.id, { confidence: next.confidence, ...(next.archived ? { status: "archived" as const } : {}) });
        faded++;
      }
      store.pruneEvents(new Date(now - KEEP_DAYS * 86_400_000).toISOString());
      this.lastReflection = now;
      this.log("reflection", undefined, { patterns: patterns.length, added: fresh.length, faded });
      await this.refresh();
      log.info(`Habits reflection: ${appEvents.length} app events, ${patterns.length} patterns, ${fresh.length} new, ${faded} faded`);
      return { added: fresh.length, faded };
    } finally {
      this.reflecting = false;
    }
  }

  // ---------------- proposals ----------------

  async checkTriggers(): Promise<void> {
    if (!this.enabled() || this.proposing || !this.active.length) return;
    const now = this.now();
    const habit = dueHabit(this.active, {
      now: new Date(now),
      foreground: this.current ? { app: this.current.app, since: this.current.since } : null,
      recentApps: this.recent,
      blocked: this.host.blocked(),
      lastProposal: this.lastProposal,
      cooldownMs: this.host.settings().habits.proposalCooldownMinutes * 60_000,
    });
    if (!habit) return;
    this.proposing = true;
    this.lastProposal = now;
    const store = this.host.store!;
    try {
      await store.updateHabit(habit.id, { lastProposed: new Date(now).toISOString() });
      const app = this.host.label(habit.app);
      if (habit.auto) {
        const error = await this.host.open(habit);
        this.host.say(error ? `Volevo aprirti ${app} come al solito, ma non ci riesco.` : `Ti apro ${app}, come al solito.`);
        this.log("proposal", habit.app, { habit: habit.key, auto: true, ok: !error });
        return;
      }
      const question = habit.kind === "time" ? `È l'ora in cui di solito apri ${app}: te lo apro?` : `Di solito a questo punto apri ${app}: te lo apro?`;
      const answer = await this.host.propose(habit, question);
      this.log("proposal", habit.app, { habit: habit.key, accepted: answer });
      if (answer === null) return;
      const next = afterAnswer(habit.confidence, answer);
      await store.updateHabit(habit.id, {
        confidence: next.confidence,
        ...(answer ? { accepted: habit.accepted + 1 } : { rejected: habit.rejected + 1 }),
        ...(next.archived ? { status: "archived" as const } : {}),
      });
      if (answer) {
        const error = await this.host.open(habit);
        if (error) this.host.say(`Non riesco ad aprire ${app}.`);
      }
      await this.refresh();
    } finally {
      this.proposing = false;
    }
  }

  // ---------------- for the settings and the prompt ----------------

  async refresh(): Promise<void> {
    this.all = (await this.host.store?.listHabits(true)) ?? [];
    this.active = this.all.filter((h) => h.status === "active");
  }

  /** For the settings window (sync: the list kept from the last refresh). */
  infos(): HabitInfo[] {
    return this.all.map((h) => ({ id: h.id, name: h.name, confidence: h.confidence, status: h.status, auto: h.auto, accepted: h.accepted, rejected: h.rejected }));
  }

  async list(): Promise<HabitRow[]> {
    return (await this.host.store?.listHabits(true)) ?? [];
  }

  async setAuto(id: number, auto: boolean): Promise<void> {
    await this.host.store?.updateHabit(id, { auto, ...(auto ? { status: "active" as const } : {}) });
    await this.refresh();
  }

  async forget(id: number): Promise<void> {
    await this.host.store?.deleteHabit(id);
    await this.refresh();
  }

  /** The active habits for <situation> ("" when none). */
  summary(): string {
    if (!this.enabled() || !this.active.length) return "";
    return this.active
      .slice(0, 6)
      .map((h) => `${h.name} (${Math.round(h.confidence * 100)}%${h.auto ? ", you do it yourself" : ""})`)
      .join("; ");
  }
}

