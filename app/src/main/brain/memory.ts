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
import type { LineInput, MemoryHit, SearchRequest, SearchResult, Speaker } from "./memory/db";
import type { MemoryStore } from "./memory/store";
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
const MAX_FACTS = 150;
const MAX_NOTES = 40;
const MAX_CONVERSATION = 120;
const MAX_DIARY = 60;
const MAX_EPISODES = 300;
/** Lines the prompt shows verbatim; older ones are summarized into episodes. */
export const RECENT_LINES = 16;
/** Unsummarized older lines that make an episode worth writing. */
const EPISODE_LINES = 20;
/** Automatic recall must not slow the answer down. */
const RECALL_TIMEOUT_MS = 400;

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

/** A memory found by a search, as the model reads it: "[2026-03-12 18:40] Diego: ..." or "[diario 2026-03-12] ...". */
export function describeHit(hit: MemoryHit, user: string, maxChars = 700): string {
  const clip = (t: string) => (t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t);
  if (hit.kind === "conversation") {
    const lines = hit.lines.map((l) => `${speakerLabel(l, user)}${l.via ? ` (${l.via})` : ""}: ${l.text}${l.interrupted ? " [interrotto]" : ""}`);
    return `[${localStamp(hit.at)}] ${clip(lines.join("\n"))}`;
  }
  if (hit.kind === "day") return `[diario ${localStamp(hit.at).slice(0, 10)}] ${clip(hit.text)}`;
  return `[riassunto ${localStamp(hit.at)} - ${localStamp(hit.end).slice(11)}] ${clip(hit.text)}`;
}

export class Memory {
  private data: MemoryData;
  private readonly writer: DebouncedWriter | null;
  /** The old archive (before memory.db); renamed once imported. */
  private readonly legacyArchive: string | null;

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

  // ---- facts and notes ----

  /** Durable facts plus unexpired notes. */
  facts(): Fact[] {
    const now = this.now().getTime();
    return this.data.facts.filter((f) => !f.expiresAt || Date.parse(f.expiresAt) > now);
  }

  remember(text: string, kind: FactKind): Fact {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 300);
    const existing = this.facts().find((f) => f.text.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const isNote = kind === "note";
    const fact: Fact = {
      id: `${isNote ? "n" : "f"}${this.data.nextId++}`,
      text: clean,
      kind,
      createdAt: this.now().toISOString(),
      ...(isNote ? { expiresAt: new Date(this.now().getTime() + NOTE_TTL_MS).toISOString() } : {}),
    };
    this.data.facts.push(fact);
    this.pruneFacts();
    this.save();
    return fact;
  }

  /** Deletes a fact, a note or a pending reminder by id. */
  forget(id: string): boolean {
    const before = this.data.facts.length + this.data.reminders.length;
    this.data.facts = this.data.facts.filter((f) => f.id !== id);
    this.data.reminders = this.data.reminders.filter((r) => r.id !== id);
    const removed = this.data.facts.length + this.data.reminders.length !== before;
    if (removed) this.save();
    return removed;
  }

  /** Wipes everything Lumi knows, keeping only its birthday. */
  clear(): void {
    const bornAt = this.data.stats.bornAt;
    this.data = this.empty();
    this.data.stats.bornAt = bornAt;
    void this.store?.clear();
    for (const file of this.legacyArchive ? [this.legacyArchive, `${this.legacyArchive}.imported`] : []) {
      try {
        rmSync(file, { force: true });
      } catch (err) {
        log.warn(`Cannot delete ${file}`, err);
      }
    }
    this.save();
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

  /** Past conversation, episodes and diary days related to the user's words (automatic recall: quick, or nothing). */
  async recall(query: string, limit = 3): Promise<MemoryHit[]> {
    if (!this.store) return [];
    const result = await this.store.search({ query, limit, before: this.recentFrom() }, RECALL_TIMEOUT_MS);
    return result?.hits ?? [];
  }

  /** The search_memory tool: words and/or dates and kind; null when memory.db is unavailable. */
  async searchMemory(request: SearchRequest): Promise<SearchResult | null> {
    if (!this.store) return null;
    // Words skip what the prompt already shows; a date range lists everything in it
    return this.store.search({ ...request, ...(request.query ? { before: this.recentFrom() } : {}) });
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

  private pruneFacts(): void {
    const now = this.now().getTime();
    this.data.facts = this.data.facts.filter((f) => !f.expiresAt || Date.parse(f.expiresAt) > now);
    const notes = this.data.facts.filter((f) => f.kind === "note");
    const durable = this.data.facts.filter((f) => f.kind !== "note");
    this.data.facts = [...durable.slice(-MAX_FACTS), ...notes.slice(-MAX_NOTES)];
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
