// Long-term memory: facts about the user, short-lived notes, the recent
// conversation (with interrupted answers marked as such), episodes (older
// parts of the conversation, summarized), a per-day diary and reminders.
// Saved in %APPDATA%\Lumi\memory.json. Every line of conversation, every
// episode and diary day also goes to memory.db (memory/db.ts, in a worker
// thread), so nothing said is lost when the recent window moves on:
// `recall` and `searchMemory` find it again, by words and by date.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiaryEntry, Fact, FactKind, Reminder } from "../../shared/types";
import { DebouncedWriter, readJson } from "../jsonStore";
import { log } from "../log";
import type { FactRow, ForgetItem, ForgetSelection, LineInput, MemoryHit, SearchRequest, SearchResult, Speaker, SummaryRecord } from "./memory/db";
import { duePeriods, type PeriodSpan } from "./memory/periods";
import type { MemoryStore } from "./memory/store";

export type { ForgetItem, ForgetSelection, PeriodSpan, SummaryRecord };

/** What a summary touched by a forget is rewritten from: the lines left (episode, day) or the days (week, month). */
export interface RewriteMaterial {
  lines: ConversationEntry[];
  days: SummaryRecord[];
}

/** Rewrites a summary from what is left; null deletes it instead. */
export type Rewriter = (summary: SummaryRecord, material: RewriteMaterial) => Promise<string | null>;

export interface ForgetReport {
  lines: number;
  facts: number;
  summaries: number;
  /** Summaries rewritten from what was left, and deleted because nothing (or no model) was left. */
  rewritten: number;
  removed: number;
}
import { localStamp } from "./memory/search";

export type { MemoryHit, Speaker };

export interface ConversationEntry {
  at: string;
  who: Speaker;
  text: string;
  /** Lumi was interrupted: `text` is only what was actually said. */
  interrupted?: boolean;
  /** Who spoke, when it wasn't the user or Lumi (a friend in a call, another voice in the room). */
  name?: string;
  /** Where it was heard, when not from the microphone ("Discord"). */
  via?: string;
}

export interface Episode {
  id: string;
  /** First and last line it covers (ISO). */
  start: string;
  end: string;
  summary: string;
}

export interface Stats {
  bornAt: string;
  lastSeenAt: string;
  chats: number;
}

interface MemoryData {
  version: 1;
  nextId: number;
  facts: Fact[];
  reminders: Reminder[];
  diary: DiaryEntry[];
  conversation: ConversationEntry[];
  /** Added later: missing in older files. */
  episodes?: Episode[];
  stats: Stats;
}

const NOTE_TTL_MS = 12 * 3600_000;
const MAX_NOTES = 40;
/** A fact's importance when nobody said otherwise. */
export const DEFAULT_IMPORTANCE: Record<FactKind, number> = { user: 7, work: 6, preference: 5, event: 6, lumi: 4, note: 3 };
/** Facts this important always reach the prompt. */
export const ALWAYS_IMPORTANCE = 8;
/** Facts in the prompt, at most (~750 tokens): notes, the important ones, the related ones, the recent ones. */
export const FACT_PROMPT_CHARS = 3000;
/** Facts learned in the last days are kept in view. */
const RECENT_FACT_MS = 3 * 24 * 3600_000;
const MAX_CONVERSATION = 120;
const MAX_DIARY = 60;
const MAX_EPISODES = 300;
/** Lines the prompt shows verbatim; older ones are summarized into episodes. */
export const RECENT_LINES = 24;
/** What tools brought back (a look at the screen, a web search...) stays in view this long, at most this many. */
const FINDING_MS = 30 * 60_000;
const MAX_FINDINGS = 5;
const FINDING_CHARS = 1200;

/** Something a tool brought back in an earlier moment, kept so a follow-up question can use it. */
export interface Finding {
  at: string;
  /** What produced it: "look_at_screen", "web_search", "read_page", "search_memory", "screen_now". */
  source: string;
  /** What was asked ("meteo Torino"), when there was a question. */
  about?: string;
  text: string;
}
/** Unsummarized older lines that make an episode worth writing. */
const EPISODE_LINES = 20;
/**
 * Automatic recall must not slow the answer down: the query's embedding
 * gets 400 ms, then words only. Measured: Ollama answers bge-m3 queries in
 * 15-80 ms, with rare spikes over 1 s (the GPU waking up).
 */
const RECALL_TIMEOUT_MS = 650;
const RECALL_EMBED_MS = 400;
/** search_memory (the model asked): meaning is worth a short wait. */
const SEARCH_EMBED_MS = 1500;

export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How a line's speaker is named in transcripts. */
export function speakerLabel(e: ConversationEntry, user: string): string {
  if (e.who === "user") return user;
  if (e.who === "lumi") return "Lumi";
  return e.name || "Qualcun altro";
}

/** The importance of a fact (older facts have none: their kind's default). */
export function importanceOf(f: Pick<Fact, "kind" | "importance">): number {
  return f.importance ?? DEFAULT_IMPORTANCE[f.kind] ?? 5;
}

/** A stored fact as the app knows it: "f12" for a durable fact, "n13" for a note. */
export function factFromRow(row: FactRow): Fact {
  const kind = row.kind as FactKind;
  return { id: `${kind === "note" ? "n" : "f"}${row.id}`, text: row.text, kind, createdAt: row.created, importance: row.importance, ...(row.expires ? { expiresAt: row.expires } : {}) };
}

/** The number in a fact id ("f12" -> 12), or null for other ids (reminders, episodes). */
export function factNumber(id: string): number | null {
  const m = /^[fn](\d+)$/.exec(id.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The facts for the prompt, in priority order within a character budget:
 * today's notes, the important ones (>= 8), the ones related to now (from
 * a search), the recent ones. Everything else stays reachable through
 * search_memory. Pure.
 */
export function selectFacts(all: Fact[], related: string[], now: number, budget = FACT_PROMPT_CHARS): Fact[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const durable = all.filter((f) => f.kind !== "note");
  const newestFirst = (a: Fact, b: Fact) => b.createdAt.localeCompare(a.createdAt);
  const groups: Fact[][] = [
    all.filter((f) => f.kind === "note").sort(newestFirst),
    durable.filter((f) => importanceOf(f) >= ALWAYS_IMPORTANCE).sort((a, b) => importanceOf(b) - importanceOf(a) || newestFirst(a, b)),
    related.map((id) => byId.get(id)).filter((f): f is Fact => !!f),
    durable.filter((f) => now - Date.parse(f.createdAt) < RECENT_FACT_MS).sort(newestFirst),
  ];
  const out: Fact[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const group of groups) {
    for (const f of group) {
      if (seen.has(f.id)) continue;
      const cost = f.text.length + 24;
      if (used + cost > budget) continue;
      seen.add(f.id);
      used += cost;
      out.push(f);
    }
  }
  return out;
}

/** A memory found by a search, as the model reads it: "[2026-03-12 18:40] Diego: ..." or "[diario 2026-03-12] ...". */
export function describeHit(hit: MemoryHit, user: string, maxChars = 700): string {
  const clip = (t: string) => (t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t);
  if (hit.kind === "fact") {
    const f = factFromRow(hit.fact);
    return `[${f.id}, ${localStamp(hit.at).slice(0, 10)}, ${f.kind}, importanza ${importanceOf(f)}] ${clip(f.text)}`;
  }
  if (hit.kind === "conversation") {
    const lines = hit.lines.map((l) => `${speakerLabel(l, user)}${l.via ? ` (${l.via})` : ""}: ${l.text}${l.interrupted ? " [interrotto]" : ""}`);
    return `[${localStamp(hit.at)}] ${clip(lines.join("\n"))}`;
  }
  if (hit.kind === "day") return `[diario ${localStamp(hit.at).slice(0, 10)}] ${clip(hit.text)}`;
  if (hit.kind === "week") return `[settimana ${localStamp(hit.at).slice(0, 10)} - ${localStamp(new Date(Date.parse(hit.end) - 1).toISOString()).slice(0, 10)}] ${clip(hit.text)}`;
  if (hit.kind === "month") return `[mese ${localStamp(hit.at).slice(0, 7)}] ${clip(hit.text)}`;
  return `[riassunto ${localStamp(hit.at)} - ${localStamp(hit.end).slice(11)}] ${clip(hit.text)}`;
}

export class Memory {
  private data: MemoryData;
  private readonly writer: DebouncedWriter | null;
  /** The old archive (before memory.db); renamed once imported. */
  private readonly legacyArchive: string | null;
  /** Tool results of the last half hour: in memory only, never on disk. */
  private findings: Finding[] = [];
  /** Where the daily backups go, and how many to keep (0: none). */
  private backups: { dir: string; keep: () => number } | null = null;

  constructor(
    file: string | null,
    /** memory.db; null keeps only memory.json (searches find nothing). */
    private readonly store: MemoryStore | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    const loaded = file ? readJson<MemoryData>(file) : null;
    this.data = loaded?.version === 1 ? loaded : this.empty();
    this.data.episodes ??= [];
    this.writer = file ? new DebouncedWriter(file, () => this.data) : null;
    this.legacyArchive = file ? join(dirname(file), "archive.jsonl") : null;
  }

  /**
   * First start with memory.db: the old archive.jsonl (or, without it, the
   * conversation kept so far), episodes and diary go into it, once. The
   * archive is then renamed, not deleted.
   */
  async importLegacy(): Promise<void> {
    if (!this.store) return;
    const file = this.legacyArchive;
    let lines: ConversationEntry[] = [];
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line) as ConversationEntry);
        } catch {
          // A torn last line after a crash: skip it
        }
      }
    } else lines = [...this.data.conversation];
    const summaries = [
      ...this.episodes().map((e) => ({ kind: "episode" as const, start: e.start, end: e.end, text: e.summary })),
      ...this.data.diary.map((d) => ({ kind: "day" as const, start: dayStart(d.date), end: dayStart(d.date, 1), text: d.summary })),
    ];
    try {
      const imported = await this.store.importLegacy({ lines, summaries });
      if (imported) log.info(`Memory: imported ${imported} lines and ${summaries.length} summaries into memory.db`);
      if (file && existsSync(file)) renameSync(file, `${file}.imported`);
    } catch (err) {
      log.error("Importing the old archive into memory.db failed (it stays where it is)", err);
    }
  }

  /**
   * Facts live in memory.db (layer 3); the app keeps the active ones here
   * too, so reading them never waits: memory.json holds that copy, and the
   * first start with memory.db imports it. Then the database's list wins.
   */
  async loadFacts(): Promise<void> {
    if (!this.store) return;
    try {
      const imported = await this.store.importFacts(
        this.data.facts.map((f) => ({ id: factNumber(f.id) ?? this.data.nextId++, kind: f.kind, text: f.text, importance: importanceOf(f), created: f.createdAt, ...(f.expiresAt ? { expires: f.expiresAt } : {}) })),
      );
      if (imported) log.info(`Memory: imported ${imported} facts into memory.db`);
    } catch (err) {
      log.error("Importing the facts into memory.db failed (memory.json keeps them)", err);
      return;
    }
    const asked = this.now().toISOString();
    const rows = await this.store.listFacts();
    if (!rows) return;
    // Facts saved while the list was on its way stay
    const listed = new Set(rows.map((r) => factFromRow(r).id));
    const meanwhile = this.data.facts.filter((f) => !listed.has(f.id) && f.createdAt >= asked);
    this.data.facts = [...rows.map(factFromRow), ...meanwhile];
    for (const f of this.data.facts) this.data.nextId = Math.max(this.data.nextId, (factNumber(f.id) ?? 0) + 1);
    this.save();
  }

  // ---- facts and notes ----

  /** Durable facts plus unexpired notes. */
  facts(): Fact[] {
    const now = this.now().getTime();
    return this.data.facts.filter((f) => !f.expiresAt || Date.parse(f.expiresAt) > now);
  }

  /**
   * Saves a fact. `importance` 1-10 (else the kind's default); `replaces`:
   * the id of a fact this one corrects or updates, which then stops
   * counting (memory.db keeps it as history); `source`: the stretch of
   * conversation it comes from.
   */
  remember(text: string, kind: FactKind, options: { importance?: number; replaces?: string; source?: { from: string; to: string } } = {}): Fact {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 300);
    const existing = this.facts().find((f) => f.text.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const isNote = kind === "note";
    const number = this.data.nextId++;
    const importance = Math.round(Math.min(10, Math.max(1, options.importance ?? DEFAULT_IMPORTANCE[kind])));
    const fact: Fact = {
      id: `${isNote ? "n" : "f"}${number}`,
      text: clean,
      kind,
      createdAt: this.now().toISOString(),
      importance,
      ...(isNote ? { expiresAt: new Date(this.now().getTime() + NOTE_TTL_MS).toISOString() } : {}),
    };
    this.data.facts.push(fact);
    this.store?.putFact({ id: number, kind, text: clean, importance, created: fact.createdAt, ...(fact.expiresAt ? { expires: fact.expiresAt } : {}), ...(options.source ? { source: options.source } : {}) });
    const older = options.replaces ? this.facts().find((f) => f.id === options.replaces!.trim() && f.id !== fact.id) : undefined;
    if (older) {
      this.data.facts = this.data.facts.filter((f) => f.id !== older.id);
      this.store?.supersedeFact(factNumber(older.id)!, number);
    }
    this.pruneFacts();
    this.save();
    return fact;
  }

  /** Deletes a fact, a note or a pending reminder by id. */
  forget(id: string): boolean {
    const before = this.data.facts.length + this.data.reminders.length;
    const fact = this.data.facts.find((f) => f.id === id);
    this.data.facts = this.data.facts.filter((f) => f.id !== id);
    this.data.reminders = this.data.reminders.filter((r) => r.id !== id);
    const removed = this.data.facts.length + this.data.reminders.length !== before;
    if (fact && factNumber(fact.id) !== null) this.store?.deleteFact(factNumber(fact.id)!);
    if (removed) this.save();
    return removed;
  }

  /** The facts for this moment's prompt: notes, important, related to `related` (fact ids from recall), recent. */
  promptFacts(related: string[] = []): Fact[] {
    return selectFacts(this.facts(), related, this.now().getTime());
  }

  /**
   * What the episode writer must know to avoid duplicates and to mark
   * corrections: the important facts and those related to the transcript.
   */
  async factsFor(text: string, limit = 30): Promise<Fact[]> {
    const related = this.store ? ((await this.store.search({ query: text.slice(-1500), kind: "fact", limit: 20, embedTimeoutMs: 3000 }))?.hits ?? []) : [];
    const ids = related.flatMap((h) => (h.kind === "fact" ? [factFromRow(h.fact).id] : []));
    return selectFacts(this.facts().filter((f) => f.kind !== "note"), ids, this.now().getTime(), 6000).slice(0, limit);
  }

  /** Wipes everything Lumi knows, keeping only its birthday. */
  clear(): void {
    this.findings = [];
    const bornAt = this.data.stats.bornAt;
    this.data = this.empty();
    this.data.stats.bornAt = bornAt;
    const store = this.store;
    const backups = this.backups;
    // The backups would still hold everything: they start over too
    void store?.clear().then(() => (backups ? store.backup(backups.dir, backups.keep(), true).catch((err: unknown) => log.warn("Resetting the memory backups failed", err)) : null));
    for (const file of this.legacyArchive ? [this.legacyArchive, `${this.legacyArchive}.imported`] : []) {
      try {
        rmSync(file, { force: true });
      } catch (err) {
        log.warn(`Cannot delete ${file}`, err);
      }
    }
    this.save();
  }

  // ---- short-term: what tools brought back ----

  /** Keeps a tool's result for the next moments (RAM only, 30 minutes). */
  addFinding(source: string, text: string, about?: string): void {
    const clean = text.trim();
    if (!clean) return;
    const clipped = clean.length > FINDING_CHARS ? `${clean.slice(0, FINDING_CHARS - 1)}…` : clean;
    // The same question asked again replaces its older answer
    this.findings = this.findings.filter((f) => !(f.source === source && f.about === about));
    this.findings.push({ at: this.now().toISOString(), source, ...(about ? { about } : {}), text: clipped });
    if (this.findings.length > MAX_FINDINGS) this.findings.splice(0, this.findings.length - MAX_FINDINGS);
  }

  /** The findings still fresh, oldest first. */
  recentFindings(): Finding[] {
    const now = this.now().getTime();
    this.findings = this.findings.filter((f) => now - Date.parse(f.at) < FINDING_MS);
    return [...this.findings];
  }

  // ---- backups (10.4) ----

  setBackups(dir: string, keep: () => number): void {
    this.backups = { dir, keep };
  }

  /** Today's backup of memory.db, if not taken yet (and older ones rotated). */
  async backup(): Promise<void> {
    if (!this.store || !this.backups) return;
    try {
      const file = await this.store.backup(this.backups.dir, this.backups.keep());
      if (file) log.info(`Memory backup: ${file}`);
    } catch (err) {
      log.warn("The memory backup failed", err);
    }
  }

  // ---- weeks and months (10.4) ----

  /** Weeks and months that are over and have no summary yet (a few at a time). */
  async duePeriods(max = 4): Promise<PeriodSpan[]> {
    const state = this.store ? await this.store.periodState() : null;
    return state ? duePeriods(state.dayStarts, new Set(state.existing), this.now(), max) : [];
  }

  /** The day summaries of a period, oldest first. */
  async daysIn(start: string, end: string): Promise<SummaryRecord[]> {
    return this.store ? this.store.summariesIn(["day"], start, end) : [];
  }

  addPeriodSummary(span: PeriodSpan, text: string): void {
    const clean = text.trim().slice(0, 2500);
    if (clean) this.store?.addSummary({ kind: span.kind, start: span.start, end: span.end, text: clean });
  }

  // ---- forgetting (10.5) ----

  /** What may be about `query`, in every layer, for the user to choose (nothing is deleted here). */
  async findForForget(query: string): Promise<ForgetItem[]> {
    if (!this.store || !query.trim()) return [];
    return this.store.findForForget(query.trim().slice(0, 300));
  }

  /**
   * The forget cascade, for what the user chose: lines, summaries and
   * facts go from memory.db (with vectors and index entries) and from
   * memory.json; facts derived only from deleted lines go too; summaries
   * that cited them are rewritten from what is left (or deleted); then
   * the file is compacted so nothing deleted stays on disk, the old
   * archive goes and the backups start over.
   */
  async forgetItems(selection: ForgetSelection, rewrite?: Rewriter): Promise<ForgetReport> {
    if (!this.store) throw new Error("memory.db is not available");
    const store = this.store;
    const result = await store.forget(selection);
    const report: ForgetReport = { lines: result.messages.length, facts: result.facts.length, summaries: result.summaries.length, rewritten: 0, removed: 0 };
    // memory.json: the recent window, the facts, the episodes and diary days
    const goneLines = new Set(result.messages.map((m) => `${m.ts}|${m.text}`));
    this.data.conversation = this.data.conversation.filter((e) => !goneLines.has(`${e.at}|${e.text}`));
    const goneFacts = new Set(result.facts);
    this.data.facts = this.data.facts.filter((f) => !goneFacts.has(factNumber(f.id) ?? -1));
    for (const g of result.summaries) this.dropSummaryCopy(g.kind, g.start);
    for (const summary of result.stale) {
      const material: RewriteMaterial = { lines: [], days: [] };
      if (summary.kind === "episode" || summary.kind === "day") {
        const lines = await store.between(summary.start, new Date(Date.parse(summary.end) + 1).toISOString());
        material.lines = lines.map(({ id: _id, session: _session, channel: _channel, ...line }) => line);
      } else material.days = await store.summariesIn(["day"], summary.start, summary.end);
      const left = material.lines.length + material.days.length > 0;
      let text: string | null = null;
      if (left && rewrite) {
        try {
          text = (await rewrite(summary, material))?.trim().slice(0, 2500) || null;
        } catch (err) {
          log.warn("Rewriting a summary after a forget failed: it is deleted instead", err);
        }
      }
      if (text) {
        await store.replaceSummary(summary.id, text);
        this.updateSummaryCopy(summary.kind, summary.start, text);
        report.rewritten++;
      } else {
        // Nothing left, or no model to rewrite it: a summary that still says it can't stay
        await store.deleteSummary(summary.id);
        this.dropSummaryCopy(summary.kind, summary.start);
        report.removed++;
      }
    }
    this.save();
    this.writer?.flush();
    await store.compact();
    for (const file of this.legacyArchive ? [this.legacyArchive, `${this.legacyArchive}.imported`] : []) rmSync(file, { force: true });
    if (this.backups) await store.backup(this.backups.dir, this.backups.keep(), true);
    log.info(`Forgot ${report.lines} lines, ${report.facts} facts, ${report.summaries} summaries; ${report.rewritten} summaries rewritten, ${report.removed} deleted`);
    return report;
  }

  private dropSummaryCopy(kind: string, start: string): void {
    if (kind === "episode") this.data.episodes = this.episodes().filter((e) => e.start !== start);
    if (kind === "day") this.data.diary = this.data.diary.filter((d) => dayStart(d.date) !== start);
  }

  private updateSummaryCopy(kind: string, start: string, text: string): void {
    if (kind === "episode") for (const e of this.episodes()) if (e.start === start) e.summary = text;
    if (kind === "day") for (const d of this.data.diary) if (dayStart(d.date) === start) d.summary = text;
  }

  // ---- conversation and diary ----

  /** `channel`: how it reached Lumi (voice, text, bar, an app), kept in memory.db only. */
  addMessage(who: Speaker, text: string, interrupted = false, extra: { name?: string; via?: string; channel?: string } = {}): void {
    const clean = text.trim();
    if (!clean) return;
    const entry: ConversationEntry = {
      at: this.now().toISOString(),
      who,
      text: clean.slice(0, 4000),
      ...(interrupted ? { interrupted } : {}),
      ...(extra.name ? { name: extra.name } : {}),
      ...(extra.via ? { via: extra.via } : {}),
    };
    this.data.conversation.push(entry);
    this.store?.append(entry satisfies LineInput, extra.channel ?? extra.via);
    if (who === "user") this.data.stats.chats += 1;
    if (this.data.conversation.length > MAX_CONVERSATION) {
      this.data.conversation.splice(0, this.data.conversation.length - MAX_CONVERSATION);
    }
    this.save();
  }

  recentConversation(limit: number): ConversationEntry[] {
    return this.data.conversation.slice(-limit);
  }

  diary(): DiaryEntry[] {
    return this.data.diary;
  }

  /**
   * Past local days that still have to go into the diary: their episodes
   * and the lines no episode covers (from memory.db, so lines that left
   * the recent window are not lost).
   */
  async pendingDiaryDays(): Promise<{ date: string; episodes: Episode[]; entries: ConversationEntry[] }[]> {
    const today = localDate(this.now());
    const days = new Set<string>();
    for (const entry of this.data.conversation) {
      const date = localDate(new Date(entry.at));
      if (date < today) days.add(date);
    }
    const out: { date: string; episodes: Episode[]; entries: ConversationEntry[] }[] = [];
    for (const date of [...days].sort()) {
      const episodes = this.episodes().filter((e) => localDate(new Date(e.end)) === date);
      const coveredUntil = episodes[episodes.length - 1]?.end ?? "";
      const logged = this.store ? await this.store.between(dayStart(date), dayStart(date, 1)) : [];
      const source: ConversationEntry[] = logged.length ? logged.map(({ id: _id, session: _session, channel: _channel, ...line }) => line) : this.data.conversation;
      const entries = source.filter((e) => localDate(new Date(e.at)) === date && e.at > coveredUntil);
      out.push({ date, episodes, entries });
    }
    return out;
  }

  /** Stores a day summary and drops that day's raw conversation (memory.db keeps it). */
  addDiary(date: string, summary: string): void {
    const text = summary.trim().slice(0, 1500);
    this.data.diary = this.data.diary.filter((d) => d.date !== date);
    this.data.diary.push({ date, summary: text });
    this.store?.addSummary({ kind: "day", start: dayStart(date), end: dayStart(date, 1), text });
    this.data.diary.sort((a, b) => a.date.localeCompare(b.date));
    if (this.data.diary.length > MAX_DIARY) this.data.diary.splice(0, this.data.diary.length - MAX_DIARY);
    this.data.conversation = this.data.conversation.filter((e) => localDate(new Date(e.at)) !== date);
    this.save();
  }

  // ---- episodes and search ----

  episodes(): Episode[] {
    return (this.data.episodes ??= []);
  }

  /** Episodes the diary doesn't cover yet (today's, and those of days still to write). */
  recentEpisodes(limit = 6): Episode[] {
    const lastDiary = this.data.diary[this.data.diary.length - 1]?.date ?? "";
    return this.episodes()
      .filter((e) => localDate(new Date(e.end)) > lastDiary)
      .slice(-limit);
  }

  /** Older lines (outside the recent window) not yet summarized, once there are enough of them. */
  pendingEpisode(): ConversationEntry[] | null {
    const list = this.episodes();
    const lastEnd = list[list.length - 1]?.end ?? "";
    const older = this.data.conversation.slice(0, -RECENT_LINES).filter((e) => e.at > lastEnd);
    return older.length >= EPISODE_LINES ? older : null;
  }

  addEpisode(entries: ConversationEntry[], summary: string): Episode | null {
    const clean = summary.trim().replace(/\s+/g, " ").slice(0, 1200);
    if (!entries.length || !clean) return null;
    const episode: Episode = { id: `e${this.data.nextId++}`, start: entries[0].at, end: entries[entries.length - 1].at, summary: clean };
    const list = this.episodes();
    list.push(episode);
    if (list.length > MAX_EPISODES) list.splice(0, list.length - MAX_EPISODES);
    this.store?.addSummary({ kind: "episode", start: episode.start, end: episode.end, text: clean });
    this.save();
    return episode;
  }

  /** Where the recent window (already in the prompt) starts. */
  recentFrom(): string | undefined {
    const recent = this.data.conversation;
    return recent.length ? recent[Math.max(0, recent.length - RECENT_LINES)].at : undefined;
  }

  /** Past conversation, episodes, diary days and facts related to the user's words (automatic recall: quick, or nothing). */
  async recall(query: string, limit = 3): Promise<MemoryHit[]> {
    if (!this.store) return [];
    const result = await this.store.search({ query, limit, before: this.recentFrom(), embedTimeoutMs: RECALL_EMBED_MS }, RECALL_TIMEOUT_MS);
    return result?.hits ?? [];
  }

  /** The search_memory tool: words and/or dates and kind; null when memory.db is unavailable. */
  async searchMemory(request: SearchRequest): Promise<SearchResult | null> {
    if (!this.store) return null;
    // Words skip what the prompt already shows; a date range lists everything in it
    return this.store.search({ ...request, embedTimeoutMs: SEARCH_EMBED_MS, ...(request.query ? { before: this.recentFrom() } : {}) });
  }

  // ---- reminders ----

  reminders(): Reminder[] {
    return [...this.data.reminders].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  addReminder(text: string, dueAt: Date): Reminder {
    const reminder: Reminder = { id: `r${this.data.nextId++}`, text: text.trim().slice(0, 300), dueAt: dueAt.toISOString() };
    this.data.reminders.push(reminder);
    this.save();
    return reminder;
  }

  /** Removes and returns reminders that are due. */
  takeDueReminders(): Reminder[] {
    const now = this.now().getTime();
    const due = this.data.reminders.filter((r) => Date.parse(r.dueAt) <= now);
    if (due.length) {
      this.data.reminders = this.data.reminders.filter((r) => Date.parse(r.dueAt) > now);
      this.save();
    }
    return due;
  }

  // ---- stats ----

  stats(): Readonly<Stats> {
    return this.data.stats;
  }

  touch(): void {
    this.data.stats.lastSeenAt = this.now().toISOString();
    this.save();
  }

  flush(): void {
    this.writer?.flush();
  }

  private save(): void {
    this.writer?.schedule();
  }

  /** Resolves once memory.db has every line (tests, shutdown). */
  archived(): Promise<void> {
    return this.store?.settled() ?? Promise.resolve();
  }

  /** Expired notes go; durable facts are never dropped here (memory.db keeps them all, the prompt picks). */
  private pruneFacts(): void {
    const now = this.now().getTime();
    this.data.facts = this.data.facts.filter((f) => !f.expiresAt || Date.parse(f.expiresAt) > now);
    const notes = this.data.facts.filter((f) => f.kind === "note");
    const durable = this.data.facts.filter((f) => f.kind !== "note");
    this.data.facts = [...durable, ...notes.slice(-MAX_NOTES)];
  }

  private empty(): MemoryData {
    const now = this.now().toISOString();
    return {
      version: 1,
      nextId: 1,
      facts: [],
      reminders: [],
      diary: [],
      conversation: [],
      episodes: [],
      stats: { bornAt: now, lastSeenAt: now, chats: 0 },
    };
  }
}

/** Local midnight of a "YYYY-MM-DD" day (plus `days`), as ISO. */
function dayStart(date: string, days = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d + days).toISOString();
}
