// Long-term memory: facts about the user, short-lived notes, the recent
// conversation (with interrupted answers marked as such), a per-day diary
// and reminders. Saved in %APPDATA%\Lumi\memory.json.
import type { DiaryEntry, Fact, FactKind, Reminder } from "../../shared/types";
import { DebouncedWriter, readJson } from "../jsonStore";

export interface ConversationEntry {
  at: string;
  who: "user" | "lumi";
  text: string;
  /** Lumi was interrupted: `text` is only what was actually said. */
  interrupted?: boolean;
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
  stats: Stats;
}

const NOTE_TTL_MS = 12 * 3600_000;
const MAX_FACTS = 150;
const MAX_NOTES = 40;
const MAX_CONVERSATION = 120;
const MAX_DIARY = 60;

export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class Memory {
  private data: MemoryData;
  private readonly writer: DebouncedWriter | null;

  constructor(
    file: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    const loaded = file ? readJson<MemoryData>(file) : null;
    this.data = loaded?.version === 1 ? loaded : this.empty();
    this.writer = file ? new DebouncedWriter(file, () => this.data) : null;
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
    this.save();
  }

  // ---- conversation and diary ----

  addMessage(who: "user" | "lumi", text: string, interrupted = false): void {
    const clean = text.trim();
    if (!clean) return;
    this.data.conversation.push({ at: this.now().toISOString(), who, text: clean.slice(0, 4000), ...(interrupted ? { interrupted } : {}) });
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

  /** Conversation grouped by past local days that still have to go into the diary. */
  pendingDiaryDays(): { date: string; entries: ConversationEntry[] }[] {
    const today = localDate(this.now());
    const byDay = new Map<string, ConversationEntry[]>();
    for (const entry of this.data.conversation) {
      const date = localDate(new Date(entry.at));
      if (date >= today) continue;
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date)!.push(entry);
    }
    return [...byDay.entries()].map(([date, entries]) => ({ date, entries }));
  }

  /** Stores a day summary and drops that day's raw conversation. */
  addDiary(date: string, summary: string): void {
    this.data.diary = this.data.diary.filter((d) => d.date !== date);
    this.data.diary.push({ date, summary: summary.trim().slice(0, 1500) });
    this.data.diary.sort((a, b) => a.date.localeCompare(b.date));
    if (this.data.diary.length > MAX_DIARY) this.data.diary.splice(0, this.data.diary.length - MAX_DIARY);
    this.data.conversation = this.data.conversation.filter((e) => localDate(new Date(e.at)) !== date);
    this.save();
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
      stats: { bornAt: now, lastSeenAt: now, chats: 0 },
    };
  }
}
