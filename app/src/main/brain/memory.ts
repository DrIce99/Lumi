// Long-term memory: facts about the user, short-lived notes, the recent
// conversation (with interrupted answers marked as such), episodes (older
// parts of the conversation, summarized), a per-day diary and reminders.
// Saved in %APPDATA%\Lumi\memory.json. Every line of conversation also
// goes to archive.jsonl, so nothing said is lost when the recent window
// moves on: `search` finds it again.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DiaryEntry, Fact, FactKind, Reminder } from "../../shared/types";
import { DebouncedWriter, readJson } from "../jsonStore";
import { log } from "../log";
import { search, type RecallDoc, type RecallHit } from "./recall";

export type Speaker = "user" | "lumi" | "other";

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
/** Archived lines kept in memory for search (the file keeps everything). */
const MAX_ARCHIVE = 20_000;
/** Lines the prompt shows verbatim; older ones are summarized into episodes. */
export const RECENT_LINES = 16;
/** Unsummarized older lines that make an episode worth writing. */
const EPISODE_LINES = 20;
/** Archived lines searched together (a short exchange). */
const WINDOW = 3;

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

export class Memory {
  private data: MemoryData;
  private readonly writer: DebouncedWriter | null;
  private readonly archiveFile: string | null;
  private archive: ConversationEntry[] = [];
  /** Appends run one after the other, so the file keeps the order of the lines. */
  private archiveWrites: Promise<void> = Promise.resolve();

  constructor(
    file: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    const loaded = file ? readJson<MemoryData>(file) : null;
    this.data = loaded?.version === 1 ? loaded : this.empty();
    this.data.episodes ??= [];
    this.writer = file ? new DebouncedWriter(file, () => this.data) : null;
    this.archiveFile = file ? join(dirname(file), "archive.jsonl") : null;
    this.loadArchive();
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

  forget(id: string): boolean {
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) => f.id !== id);
    const removed = this.data.facts.length !== before;
    if (removed) this.save();
    return removed;
  }

  /** Wipes everything Lumi knows, keeping only its birthday. */
  clear(): void {
    const bornAt = this.data.stats.bornAt;
    this.data = this.empty();
    this.data.stats.bornAt = bornAt;
    this.archive = [];
    const file = this.archiveFile;
    if (file) {
      this.archiveWrites = this.archiveWrites.then(() => {
        try {
          writeFileSync(file, "", "utf8");
        } catch (err) {
          log.warn("Cannot clear the conversation archive", err);
        }
      });
    }
    this.save();
  }

  // ---- conversation and diary ----

  addMessage(who: Speaker, text: string, interrupted = false, extra: { name?: string; via?: string } = {}): void {
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
    this.toArchive([entry]);
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
   * and the lines no episode covers (from the archive, so lines that left
   * the recent window are not lost).
   */
  pendingDiaryDays(): { date: string; episodes: Episode[]; entries: ConversationEntry[] }[] {
    const today = localDate(this.now());
    const days = new Set<string>();
    for (const entry of this.data.conversation) {
      const date = localDate(new Date(entry.at));
      if (date < today) days.add(date);
    }
    const source = this.archive.length ? this.archive : this.data.conversation;
    return [...days].sort().map((date) => {
      const episodes = this.episodes().filter((e) => localDate(new Date(e.end)) === date);
      const coveredUntil = episodes[episodes.length - 1]?.end ?? "";
      const entries = source.filter((e) => localDate(new Date(e.at)) === date && e.at > coveredUntil);
      return { date, episodes, entries };
    });
  }

  /** Stores a day summary and drops that day's raw conversation (the archive keeps it). */
  addDiary(date: string, summary: string): void {
    this.data.diary = this.data.diary.filter((d) => d.date !== date);
    this.data.diary.push({ date, summary: summary.trim().slice(0, 1500) });
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
    this.save();
    return episode;
  }

  /** Past conversation, episodes and diary days related to `query` (the recent window is excluded: it is already in context). */
  search(query: string, limit = 3, user = "Utente"): RecallHit[] {
    const recent = this.data.conversation;
    const recentFrom = recent.length ? recent[Math.max(0, recent.length - RECENT_LINES)].at : "￿";
    const docs: RecallDoc[] = [];
    const older = this.archive.filter((e) => e.at < recentFrom);
    for (let i = 0; i < older.length; i += WINDOW) {
      const window = older.slice(i, i + WINDOW);
      docs.push({ id: `a${i}`, at: window[0].at, kind: "conversation", text: window.map((e) => `${speakerLabel(e, user)}: ${e.text}`).join("\n") });
    }
    for (const e of this.episodes()) docs.push({ id: e.id, at: e.start, kind: "episode", text: e.summary });
    for (const d of this.data.diary) docs.push({ id: `d${d.date}`, at: d.date, kind: "diary", text: d.summary });
    return search(docs, query, limit);
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

  private loadArchive(): void {
    if (!this.archiveFile) return;
    if (!existsSync(this.archiveFile)) {
      // First run with an archive: start it from the conversation kept so far
      this.toArchive(this.data.conversation);
      return;
    }
    try {
      for (const line of readFileSync(this.archiveFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.archive.push(JSON.parse(line) as ConversationEntry);
        } catch {
          // A torn last line after a crash: skip it
        }
      }
      if (this.archive.length > MAX_ARCHIVE) this.archive.splice(0, this.archive.length - MAX_ARCHIVE);
    } catch (err) {
      log.warn("Cannot read the conversation archive", err);
    }
  }

  private toArchive(entries: ConversationEntry[]): void {
    if (!entries.length) return;
    this.archive.push(...entries);
    if (this.archive.length > MAX_ARCHIVE) this.archive.splice(0, this.archive.length - MAX_ARCHIVE);
    if (!this.archiveFile) return;
    // Appended without blocking the main thread (the mouse hook runs on it)
    const file = this.archiveFile;
    const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    this.archiveWrites = this.archiveWrites
      .then(() => appendFile(file, text, "utf8"))
      .catch((err: unknown) => log.warn("Cannot append to the conversation archive", err));
  }

  /** Resolves once the archive file has every line (tests, shutdown). */
  archived(): Promise<void> {
    return this.archiveWrites;
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
