// Lumi's long-term memory on disk: one SQLite file (%APPDATA%\Lumi\memory.db)
// through node:sqlite (bundled with Electron's Node: no native module to
// rebuild). Layer 1 is the raw log of every line said (append-only, the
// source of truth); FTS5 indexes it and the summaries (episodes and diary
// days). Synchronous: it runs in a worker thread (worker.ts), never on the
// main thread, where the click-through mouse hook lives.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dateRange, enoughMatched, ftsQuery, queryTerms } from "./search";

export type Speaker = "user" | "lumi" | "other";

/** A line of conversation as the rest of the app knows it. */
export interface LineInput {
  at: string;
  who: Speaker;
  text: string;
  interrupted?: boolean;
  /** Who spoke, when not the user or Lumi. */
  name?: string;
  /** Where it was heard, when not from the microphone ("Discord"). */
  via?: string;
}

export interface StoredLine extends LineInput {
  id: number;
  session: number;
  /** How it reached Lumi: voice, text, bar, an app's name. */
  channel?: string;
}

export type SummaryKind = "episode" | "day";

export interface SummaryInput {
  kind: SummaryKind;
  start: string;
  end: string;
  text: string;
}

export type MemoryHit =
  | { kind: "conversation"; at: string; lines: StoredLine[]; score: number }
  | { kind: SummaryKind; at: string; end: string; text: string; score: number };

export interface SearchRequest {
  /** Words to look for; without them the range is listed in order. */
  query?: string;
  /** Local dates or months, as the model writes them ("2026-03", "2026-03-12"). */
  from?: string;
  to?: string;
  kind?: "conversation" | "summary" | "all";
  /** Lines from this moment on are already in the prompt: skip them (ISO). */
  before?: string;
  limit?: number;
}

export interface SearchResult {
  hits: MemoryHit[];
  /** Matching items left out by the limit. */
  more: number;
  /** The dates could not be read. */
  badRange?: boolean;
}

export interface LegacyImport {
  lines: LineInput[];
  summaries: SummaryInput[];
}

/** A pause this long starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** FTS candidates checked before the "half of the words" filter. */
const CANDIDATES = 200;
/** Lines around a hit, for context (same session). */
const CONTEXT_LINES = 1;

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     ts TEXT NOT NULL,
     session_id INTEGER NOT NULL,
     speaker TEXT NOT NULL,
     name TEXT,
     via TEXT,
     channel TEXT,
     interrupted INTEGER NOT NULL DEFAULT 0,
     text TEXT NOT NULL
   );
   CREATE INDEX messages_ts ON messages(ts);
   CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;
   CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
   CREATE TABLE summaries (
     id INTEGER PRIMARY KEY,
     period TEXT NOT NULL,
     start TEXT NOT NULL,
     end TEXT NOT NULL,
     text TEXT NOT NULL,
     source_ids TEXT
   );
   CREATE INDEX summaries_start ON summaries(start);
   CREATE VIRTUAL TABLE summaries_fts USING fts5(text, content='summaries', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text); END;
   CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text); END;`,
];

interface MessageRow {
  id: number;
  ts: string;
  session_id: number;
  speaker: string;
  name: string | null;
  via: string | null;
  channel: string | null;
  interrupted: number;
  text: string;
  score?: number;
}

interface SummaryRow {
  id: number;
  period: string;
  start: string;
  end: string;
  text: string;
  score?: number;
}

function toLine(r: MessageRow): StoredLine {
  return {
    id: r.id,
    at: r.ts,
    session: r.session_id,
    who: r.speaker as Speaker,
    text: r.text,
    ...(r.interrupted ? { interrupted: true } : {}),
    ...(r.name ? { name: r.name } : {}),
    ...(r.via ? { via: r.via } : {}),
    ...(r.channel ? { channel: r.channel } : {}),
  };
}

export class MemoryDb {
  private readonly db: DatabaseSync;
  private last: { ts: string; session: number } | null = null;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    const row = this.db.prepare("SELECT ts, session_id FROM messages ORDER BY id DESC LIMIT 1").get() as { ts: string; session_id: number } | undefined;
    if (row) this.last = { ts: row.ts, session: row.session_id };
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let v = version; v < SCHEMA_VERSION; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Appends a line to the raw log; returns its id. */
  append(line: LineInput, channel?: string): number {
    const at = Date.parse(line.at);
    const session = !this.last ? 1 : at - Date.parse(this.last.ts) > SESSION_GAP_MS ? this.last.session + 1 : this.last.session;
    const result = this.db
      .prepare("INSERT INTO messages (ts, session_id, speaker, name, via, channel, interrupted, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(line.at, session, line.who, line.name ?? null, line.via ?? null, channel ?? null, line.interrupted ? 1 : 0, line.text);
    this.last = { ts: line.at, session };
    return Number(result.lastInsertRowid);
  }

  addSummary(summary: SummaryInput, sourceIds: number[] = []): number {
    const result = this.db
      .prepare("INSERT INTO summaries (period, start, end, text, source_ids) VALUES (?, ?, ?, ?, ?)")
      .run(summary.kind, summary.start, summary.end, summary.text, sourceIds.length ? JSON.stringify(sourceIds) : null);
    return Number(result.lastInsertRowid);
  }

  /** Lines in [from, to) (ISO), oldest first. */
  between(from: string, to: string, limit = 2000): StoredLine[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY id LIMIT ?").all(from, to, limit) as unknown as MessageRow[];
    return rows.map(toLine);
  }

  count(): { messages: number; summaries: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { messages: n("SELECT COUNT(*) AS n FROM messages"), summaries: n("SELECT COUNT(*) AS n FROM summaries") };
  }

  search(request: SearchRequest): SearchResult {
    const range = dateRange(request.from, request.to);
    if (!range) return { hits: [], more: 0, badRange: true };
    const limit = Math.max(1, Math.min(30, request.limit ?? 5));
    const kind = request.kind ?? "all";
    const until = request.before && request.before < range.to ? request.before : range.to;
    const fts = request.query ? ftsQuery(request.query) : null;
    if (request.query && !fts) return { hits: [], more: 0 };
    const hits: MemoryHit[] = [];
    let total = 0;

    if (kind !== "summary") {
      if (fts) {
        const words = queryTerms(request.query!);
        const rows = (
          this.db
            .prepare(
              "SELECT m.*, bm25(messages_fts) AS score FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? AND m.ts >= ? AND m.ts < ? ORDER BY score LIMIT ?",
            )
            .all(fts, range.from, until, CANDIDATES) as unknown as MessageRow[]
        ).filter((r) => enoughMatched(r.text, words));
        total += rows.length;
        for (const r of rows) hits.push({ kind: "conversation", at: r.ts, lines: this.around(r), score: -(r.score ?? 0) });
      } else {
        const n = (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND ts < ?").get(range.from, until) as { n: number }).n;
        total += n;
        const rows = this.db.prepare("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY id LIMIT ?").all(range.from, until, limit * 6) as unknown as MessageRow[];
        // Without words the lines are listed in order, a few per hit
        for (let i = 0; i < rows.length; i += 3) {
          const group = rows.slice(i, i + 3).map(toLine);
          hits.push({ kind: "conversation", at: group[0].at, lines: group, score: 0 });
        }
        total = Math.ceil(total / 3);
      }
    }

    if (kind !== "conversation") {
      const params: SQLInputValue[] = [range.from, until];
      if (fts) {
        const words = queryTerms(request.query!);
        const rows = (
          this.db
            .prepare(
              "SELECT s.*, bm25(summaries_fts) AS score FROM summaries_fts JOIN summaries s ON s.id = summaries_fts.rowid WHERE summaries_fts MATCH ? AND s.end >= ? AND s.start < ? ORDER BY score LIMIT ?",
            )
            .all(fts, ...params, CANDIDATES) as unknown as SummaryRow[]
        ).filter((r) => enoughMatched(r.text, words));
        total += rows.length;
        // Summaries carry more per hit than a line: a small edge in the ranking
        for (const r of rows) hits.push({ kind: r.period as SummaryKind, at: r.start, end: r.end, text: r.text, score: -(r.score ?? 0) * 1.2 });
      } else {
        const rows = this.db.prepare("SELECT * FROM summaries WHERE end >= ? AND start < ? ORDER BY start").all(...params) as unknown as SummaryRow[];
        total += rows.length;
        for (const r of rows) hits.push({ kind: r.period as SummaryKind, at: r.start, end: r.end, text: r.text, score: 1 });
      }
    }

    // With words: most relevant first, overlapping context merged; without: summaries first, then in order
    const sorted = fts ? hits.sort((a, b) => b.score - a.score) : hits.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at));
    const kept = mergeOverlapping(sorted).slice(0, limit);
    return { hits: kept, more: Math.max(0, total - kept.length) };
  }

  /** A hit with the lines just before and after it in the same session. */
  private around(row: MessageRow): StoredLine[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE id BETWEEN ? AND ? AND session_id = ? ORDER BY id")
      .all(row.id - CONTEXT_LINES, row.id + CONTEXT_LINES, row.session_id) as unknown as MessageRow[];
    return rows.map(toLine);
  }

  /** Imports the old archive.jsonl, episodes and diary once; returns how many lines were imported (0 if already done). */
  importLegacy(data: LegacyImport): number {
    if (this.db.prepare("SELECT value FROM meta WHERE key = 'legacy_import'").get()) return 0;
    this.db.exec("BEGIN");
    try {
      const lines = [...data.lines].sort((a, b) => a.at.localeCompare(b.at));
      for (const line of lines) this.append(line);
      for (const s of data.summaries) this.addSummary(s);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('legacy_import', ?)").run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.last = null;
      throw err;
    }
    return data.lines.length;
  }

  /** Forgets everything ("Dimentica tutto"): rows, indexes, and the free pages in the file. */
  clear(): void {
    this.db.exec("DELETE FROM messages; DELETE FROM summaries;");
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild'); INSERT INTO summaries_fts(summaries_fts) VALUES ('rebuild');");
    this.last = null;
    this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}

/** Drops conversation hits whose lines another, better hit already shows. */
function mergeOverlapping(hits: MemoryHit[]): MemoryHit[] {
  const shown = new Set<number>();
  const out: MemoryHit[] = [];
  for (const hit of hits) {
    if (hit.kind === "conversation") {
      if (hit.lines.some((l) => shown.has(l.id))) continue;
      for (const l of hit.lines) shown.add(l.id);
    }
    out.push(hit);
  }
  return out;
}
