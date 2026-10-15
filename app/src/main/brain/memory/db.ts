// Lumi's long-term memory on disk: one SQLite file (%APPDATA%\Lumi\memory.db)
// through node:sqlite (bundled with Electron's Node: no native module to
// rebuild). Layer 1 is the raw log of every line said (append-only, the
// source of truth); layer 3 the facts extracted from it, with importance,
// sources and supersession; layer 4 the summaries (episodes and diary
// days). FTS5 indexes the text of all three; sqlite-vec holds their
// embeddings, one vec0 table per model (the
// vectors are a rebuildable index: text stays the truth). Search is hybrid:
// FTS and vector candidates fused with RRF, then ordered by relevance,
// recency and importance. Synchronous: it runs in a worker thread
// (worker.ts), never on the main thread, where the mouse hook lives.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dateRange, DEFAULT_WEIGHTS, enoughMatched, ftsQuery, keepSimilar, memoryScore, queryTerms, rrf, type ScoreWeights } from "./search";

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

/** A fact as stored: `id` is the number in "f12" (durable) or "n13" (a note for today). */
export interface FactRow {
  id: number;
  kind: string;
  text: string;
  /** 1-10: how much it matters (8 and more always reach the prompt). */
  importance: number;
  created: string;
  /** Notes expire. */
  expires?: string;
}

export interface FactInput extends FactRow {
  /** The conversation it comes from (ISO span): its lines become `source_ids`. */
  source?: { from: string; to: string };
}

export type MemoryHit =
  | { kind: "conversation"; at: string; lines: StoredLine[]; score: number }
  | { kind: SummaryKind; at: string; end: string; text: string; score: number }
  | { kind: "fact"; at: string; fact: FactRow; score: number };

export interface SearchRequest {
  /** Words to look for; without them the range is listed in order. */
  query?: string;
  /** Local dates or months, as the model writes them ("2026-03", "2026-03-12"). */
  from?: string;
  to?: string;
  kind?: "conversation" | "summary" | "fact" | "all";
  /** Lines from this moment on are already in the prompt: skip them (ISO). */
  before?: string;
  limit?: number;
  /** How long the worker may wait for the query's embedding before searching words only. */
  embedTimeoutMs?: number;
}

export interface SearchResult {
  hits: MemoryHit[];
  /** Matching items left out by the limit. */
  more: number;
  /** The dates could not be read. */
  badRange?: boolean;
  /** The search used meaning (vectors) as well as words. */
  semantic?: boolean;
}

export interface LegacyImport {
  lines: LineInput[];
  summaries: SummaryInput[];
}

/** An item to embed: a line (with the one before it, for context) or a summary. */
export interface EmbedItem {
  kind: "message" | "summary" | "fact";
  id: number;
  text: string;
}

/** The query's embedding, from the model whose vectors to search. */
export interface QueryVector {
  model: string;
  vector: number[];
}

/** A pause this long starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** FTS and vector candidates per list (the "top 50" of the design). */
const CANDIDATES = 50;
/** FTS rows read before the "half of the words" filter. */
const FTS_ROWS = 200;
/** Lines around a hit, for context (same session). */
const CONTEXT_LINES = 1;
/** Lines shorter than this ("ok", "sì") get no vector: words find them. */
export const MIN_EMBED_CHARS = 12;

const SCHEMA_VERSION = 3;

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
  // v2: embeddings. Each row names its model; the vectors live in one vec0 table per model (vec_tables)
  `CREATE TABLE embeddings (
     id INTEGER PRIMARY KEY,
     owner_kind TEXT NOT NULL,
     owner_id INTEGER NOT NULL,
     model TEXT NOT NULL,
     dim INTEGER NOT NULL,
     created TEXT NOT NULL,
     UNIQUE (owner_kind, owner_id, model)
   );
   CREATE TABLE vec_tables (model TEXT PRIMARY KEY, dim INTEGER NOT NULL, name TEXT NOT NULL);`,
  // v3: facts. A newer fact that contradicts an older one sets its superseded_by: the history stays, the latest counts
  `CREATE TABLE facts (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     importance INTEGER NOT NULL DEFAULT 5,
     confidence REAL NOT NULL DEFAULT 1,
     created TEXT NOT NULL,
     updated TEXT NOT NULL,
     expires TEXT,
     superseded_by INTEGER,
     source_ids TEXT
   );
   CREATE VIRTUAL TABLE facts_fts USING fts5(text, content='facts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text); END;
   CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
   CREATE TRIGGER facts_au AFTER UPDATE OF text ON facts BEGIN
     INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
     INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
   END;`,
];

/** Active facts: not superseded, not an expired note. */
const ACTIVE_FACT = "superseded_by IS NULL AND (expires IS NULL OR expires > ?)";

interface FactDbRow {
  id: number;
  kind: string;
  text: string;
  importance: number;
  created: string;
  expires: string | null;
}

const toFact = (r: FactDbRow): FactRow => ({ id: r.id, kind: r.kind, text: r.text, importance: r.importance, created: r.created, ...(r.expires ? { expires: r.expires } : {}) });

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

const vectorBytes = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);

export class MemoryDb {
  private readonly db: DatabaseSync;
  private last: { ts: string; session: number } | null = null;
  /** sqlite-vec is loaded: vectors can be stored and searched. */
  readonly vectors: boolean;

  /** `vecExtension`: path of sqlite-vec's loadable library; without it the memory searches words only. */
  constructor(file: string, options: { vecExtension?: string | null } = {}) {
    this.db = new DatabaseSync(file, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    let vectors = false;
    if (options.vecExtension) {
      try {
        this.db.loadExtension(options.vecExtension);
        vectors = true;
      } catch {
        vectors = false;
      }
    }
    this.vectors = vectors;
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

  // ---------------- facts ----------------

  /** Stores a fact with its own id (the app numbers facts, notes and reminders together). */
  putFact(fact: FactInput): void {
    const sources = fact.source
      ? (this.db.prepare("SELECT id FROM messages WHERE ts >= ? AND ts <= ? ORDER BY id DESC LIMIT 200").all(fact.source.from, fact.source.to) as { id: number }[]).map((r) => r.id).reverse()
      : [];
    this.db
      .prepare("INSERT OR IGNORE INTO facts (id, kind, text, importance, created, updated, expires, source_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(fact.id, fact.kind, fact.text, Math.round(fact.importance), fact.created, fact.created, fact.expires ?? null, sources.length ? JSON.stringify(sources) : null);
  }

  /** `newer` replaces `older` (a correction, a change): the old one stays as history. */
  supersedeFact(older: number, newer: number): void {
    this.db.prepare("UPDATE facts SET superseded_by = ?, updated = ? WHERE id = ? AND superseded_by IS NULL").run(newer, new Date().toISOString(), older);
  }

  /** Deletes a fact with its vectors and index entry; true when it existed. */
  deleteFact(id: number): boolean {
    this.dropVectors("fact", [id]);
    return this.db.prepare("DELETE FROM facts WHERE id = ?").run(id).changes > 0;
  }

  /** The active facts (not superseded, notes not expired), oldest first. */
  listFacts(now = new Date().toISOString()): FactRow[] {
    return (this.db.prepare(`SELECT * FROM facts WHERE ${ACTIVE_FACT} ORDER BY id`).all(now) as unknown as FactDbRow[]).map(toFact);
  }

  /** Imports the facts kept in memory.json before memory.db had them, once; returns how many. */
  importFacts(facts: FactInput[]): number {
    if (this.db.prepare("SELECT value FROM meta WHERE key = 'facts_import'").get()) return 0;
    this.db.exec("BEGIN");
    try {
      for (const f of facts) this.putFact(f);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('facts_import', ?)").run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return facts.length;
  }

  /** Removes the vectors of some owners, in every model's table. */
  private dropVectors(kind: EmbedItem["kind"], ids: number[]): void {
    if (!ids.length) return;
    const marks = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id FROM embeddings WHERE owner_kind = ? AND owner_id IN (${marks})`).all(kind, ...ids) as { id: number }[];
    if (!rows.length) return;
    if (this.vectors) {
      const tables = this.db.prepare("SELECT name FROM vec_tables").all() as { name: string }[];
      for (const t of tables) for (const r of rows) this.db.prepare(`DELETE FROM ${t.name} WHERE rowid = ?`).run(BigInt(r.id));
    }
    this.db.prepare(`DELETE FROM embeddings WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  }

  // ---------------- embeddings ----------------

  /** The vec0 table of a model, created on first use (the dimension comes with the first vectors). */
  private vecTable(model: string, dim?: number): string | null {
    if (!this.vectors) return null;
    const row = this.db.prepare("SELECT name, dim FROM vec_tables WHERE model = ?").get(model) as { name: string; dim: number } | undefined;
    if (row) {
      if (dim !== undefined && dim !== row.dim) throw new Error(`${model} gave ${dim} dimensions, ${row.dim} expected`);
      return row.name;
    }
    if (dim === undefined) return null;
    const next = (this.db.prepare("SELECT COUNT(*) AS n FROM vec_tables").get() as { n: number }).n + 1;
    let name = `vec_${next}`;
    while (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name)) name = `${name}x`;
    this.db.exec(`CREATE VIRTUAL TABLE ${name} USING vec0(embedding float[${Math.round(dim)}] distance_metric=cosine, kind text, ts text, te text)`);
    this.db.prepare("INSERT INTO vec_tables (model, dim, name) VALUES (?, ?, ?)").run(model, dim, name);
    return name;
  }

  /** Lines and summaries without a vector for `model`, newest first (recent memories matter sooner). */
  pendingEmbeddings(model: string, limit: number): EmbedItem[] {
    if (!this.vectors) return [];
    const lines = this.db
      .prepare(
        `SELECT m.id, m.speaker, m.name, m.text,
           (SELECT p.speaker || '|' || COALESCE(p.name, '') || '|' || p.text FROM messages p WHERE p.id = m.id - 1 AND p.session_id = m.session_id) AS previous
         FROM messages m LEFT JOIN embeddings e ON e.owner_kind = 'message' AND e.owner_id = m.id AND e.model = ?
         WHERE e.id IS NULL AND length(m.text) >= ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(model, MIN_EMBED_CHARS, limit) as { id: number; speaker: string; name: string | null; text: string; previous: string | null }[];
    const label = (speaker: string, name: string | null) => (speaker === "user" ? "Utente" : speaker === "lumi" ? "Lumi" : name || "Qualcun altro");
    const items: EmbedItem[] = lines.map((r) => {
      const [ps, pn, ...pt] = r.previous?.split("|") ?? [];
      const before = r.previous ? `${label(ps, pn || null)}: ${pt.join("|")}\n` : "";
      return { kind: "message", id: r.id, text: `${before}${label(r.speaker, r.name)}: ${r.text}` };
    });
    if (items.length < limit) {
      const facts = this.db
        .prepare(
          `SELECT f.id, f.text FROM facts f LEFT JOIN embeddings e ON e.owner_kind = 'fact' AND e.owner_id = f.id AND e.model = ?
           WHERE e.id IS NULL AND f.superseded_by IS NULL AND f.expires IS NULL ORDER BY f.id DESC LIMIT ?`,
        )
        .all(model, limit - items.length) as { id: number; text: string }[];
      for (const f of facts) items.push({ kind: "fact", id: f.id, text: f.text });
    }
    if (items.length < limit) {
      const summaries = this.db
        .prepare(
          `SELECT s.id, s.text FROM summaries s LEFT JOIN embeddings e ON e.owner_kind = 'summary' AND e.owner_id = s.id AND e.model = ?
           WHERE e.id IS NULL ORDER BY s.id DESC LIMIT ?`,
        )
        .all(model, limit - items.length) as { id: number; text: string }[];
      for (const s of summaries) items.push({ kind: "summary", id: s.id, text: s.text });
    }
    return items;
  }

  /** Stores the vectors of `items` (same order) for `model`. */
  storeEmbeddings(model: string, items: EmbedItem[], vectors: number[][]): void {
    if (!this.vectors || !items.length) return;
    if (vectors.length !== items.length) throw new Error(`${items.length} items, ${vectors.length} vectors`);
    const table = this.vecTable(model, vectors[0].length)!;
    const owner = {
      message: this.db.prepare("SELECT ts AS ts, ts AS te FROM messages WHERE id = ?"),
      summary: this.db.prepare("SELECT start AS ts, end AS te FROM summaries WHERE id = ?"),
      fact: this.db.prepare("SELECT created AS ts, created AS te FROM facts WHERE id = ?"),
    };
    const insertRow = this.db.prepare("INSERT OR IGNORE INTO embeddings (owner_kind, owner_id, model, dim, created) VALUES (?, ?, ?, ?, ?)");
    const insertVec = this.db.prepare(`INSERT INTO ${table} (rowid, embedding, kind, ts, te) VALUES (?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      items.forEach((item, i) => {
        const span = owner[item.kind].get(item.id) as { ts: string; te: string } | undefined;
        // Gone meanwhile ("Dimentica tutto" during a batch)
        if (!span) return;
        const row = insertRow.run(item.kind, item.id, model, vectors[i].length, now);
        if (!row.changes) return;
        insertVec.run(BigInt(row.lastInsertRowid), vectorBytes(vectors[i]), item.kind, span.ts, span.te);
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** How much of the memory has vectors of `model`. */
  embeddingCoverage(model: string): { done: number; total: number } {
    const n = (sql: string, ...params: SQLInputValue[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
    const total =
      n("SELECT COUNT(*) AS n FROM messages WHERE length(text) >= ?", MIN_EMBED_CHARS) +
      n("SELECT COUNT(*) AS n FROM summaries") +
      n("SELECT COUNT(*) AS n FROM facts WHERE superseded_by IS NULL AND expires IS NULL");
    const done = n(
      `SELECT COUNT(*) AS n FROM embeddings e WHERE e.model = ? AND (e.owner_kind <> 'fact' OR EXISTS (SELECT 1 FROM facts f WHERE f.id = e.owner_id AND f.superseded_by IS NULL AND f.expires IS NULL))`,
      model,
    );
    return { done, total };
  }

  /** Once a new model covers everything, the old models' vectors go (they can't be searched with its queries). */
  dropOtherModels(model: string): number {
    if (!this.vectors) return 0;
    const others = this.db.prepare("SELECT model, name FROM vec_tables WHERE model <> ?").all(model) as { model: string; name: string }[];
    for (const o of others) {
      this.db.exec(`DROP TABLE IF EXISTS ${o.name}`);
      this.db.prepare("DELETE FROM embeddings WHERE model = ?").run(o.model);
      this.db.prepare("DELETE FROM vec_tables WHERE model = ?").run(o.model);
    }
    return others.length;
  }

  // ---------------- search ----------------

  search(request: SearchRequest, query: QueryVector | null = null, options: { now?: number; weights?: ScoreWeights } = {}): SearchResult {
    const range = dateRange(request.from, request.to);
    if (!range) return { hits: [], more: 0, badRange: true };
    const limit = Math.max(1, Math.min(30, request.limit ?? 5));
    const kind = request.kind ?? "all";
    const until = request.before && request.before < range.to ? request.before : range.to;
    const fts = request.query ? ftsQuery(request.query) : null;
    const table = query ? this.vecTable(query.model) : null;
    if (!request.query) return this.list(range.from, until, kind, limit);
    if (!fts && !table) return { hits: [], more: 0 };

    const lists: string[][] = [];
    const words = queryTerms(request.query);
    if (fts && (kind === "all" || kind === "conversation")) {
      const rows = this.db
        .prepare("SELECT m.id, m.text FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? AND m.ts >= ? AND m.ts < ? ORDER BY bm25(messages_fts) LIMIT ?")
        .all(fts, range.from, until, FTS_ROWS) as { id: number; text: string }[];
      lists.push(rows.filter((r) => enoughMatched(r.text, words)).slice(0, CANDIDATES).map((r) => `message:${r.id}`));
    }
    const nowIso = new Date(options.now ?? Date.now()).toISOString();
    if (fts && (kind === "all" || kind === "fact")) {
      const rows = this.db
        .prepare(`SELECT f.id, f.text FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ? AND f.created >= ? AND f.created < ? AND f.${ACTIVE_FACT} ORDER BY bm25(facts_fts) LIMIT ?`)
        .all(fts, range.from, until, nowIso, FTS_ROWS) as { id: number; text: string }[];
      lists.push(rows.filter((r) => enoughMatched(r.text, words)).slice(0, CANDIDATES).map((r) => `fact:${r.id}`));
    }
    if (fts && (kind === "all" || kind === "summary")) {
      const rows = this.db
        .prepare("SELECT s.id, s.text FROM summaries_fts JOIN summaries s ON s.id = summaries_fts.rowid WHERE summaries_fts MATCH ? AND s.end >= ? AND s.start < ? ORDER BY bm25(summaries_fts) LIMIT ?")
        .all(fts, range.from, until, FTS_ROWS) as { id: number; text: string }[];
      lists.push(rows.filter((r) => enoughMatched(r.text, words)).slice(0, CANDIDATES).map((r) => `summary:${r.id}`));
    }
    let semantic = false;
    if (query && table) {
      semantic = true;
      const filter = kind === "conversation" ? " AND v.kind = 'message'" : kind === "summary" ? " AND v.kind = 'summary'" : kind === "fact" ? " AND v.kind = 'fact'" : "";
      const rows = this.db
        .prepare(
          `SELECT e.owner_kind AS kind, e.owner_id AS id, v.distance FROM ${table} v JOIN embeddings e ON e.id = v.rowid
           WHERE v.embedding MATCH ? AND k = ? AND v.te >= ? AND v.ts < ?${filter} ORDER BY v.distance`,
        )
        .all(vectorBytes(query.vector), CANDIDATES, range.from, until) as { kind: string; id: number; distance: number }[];
      // Superseded facts keep their vectors until re-indexing: they never come back as hits
      const active = new Set((this.db.prepare(`SELECT id FROM facts WHERE ${ACTIVE_FACT}`).all(nowIso) as { id: number }[]).map((r) => r.id));
      const similar = keepSimilar(
        rows.filter((r) => r.kind !== "fact" || active.has(r.id)).map((r) => ({ ...r, similarity: 1 - r.distance })),
        query.model,
      );
      lists.push(similar.map((r) => `${r.kind}:${r.id}`));
    }

    const fused = rrf(lists);
    if (!fused.size) return { hits: [], more: 0, ...(semantic ? { semantic } : {}) };
    const best = Math.max(...fused.values());
    const now = options.now ?? Date.now();
    const weights = options.weights ?? DEFAULT_WEIGHTS;
    const message = this.db.prepare("SELECT * FROM messages WHERE id = ?");
    const summary = this.db.prepare("SELECT * FROM summaries WHERE id = ?");
    const fact = this.db.prepare("SELECT * FROM facts WHERE id = ?");
    const hits: MemoryHit[] = [];
    for (const [key, value] of fused) {
      const [ownerKind, idText] = key.split(":");
      const id = Number(idText);
      const score = (at: string, importance = 0) => memoryScore({ relevance: value / best, hoursAgo: (now - Date.parse(at)) / 3_600_000, importance }, weights);
      if (ownerKind === "fact") {
        const row = fact.get(id) as FactDbRow | undefined;
        if (row) hits.push({ kind: "fact", at: row.created, fact: toFact(row), score: score(row.created, row.importance / 10) });
      } else if (ownerKind === "message") {
        const row = message.get(id) as MessageRow | undefined;
        if (row) hits.push({ kind: "conversation", at: row.ts, lines: this.around(row), score: score(row.ts) });
      } else {
        const row = summary.get(id) as SummaryRow | undefined;
        if (row) hits.push({ kind: row.period as SummaryKind, at: row.start, end: row.end, text: row.text, score: score(row.end) });
      }
    }
    const kept = mergeOverlapping(hits.sort((a, b) => b.score - a.score)).slice(0, limit);
    return { hits: kept, more: Math.max(0, fused.size - kept.length), ...(semantic ? { semantic } : {}) };
  }

  /** No words: the period in order, summaries first ("cosa ti ho detto il 12 marzo?"). */
  private list(from: string, until: string, kind: SearchRequest["kind"], limit: number): SearchResult {
    const hits: MemoryHit[] = [];
    let total = 0;
    if (kind === "fact") {
      const rows = this.db.prepare(`SELECT * FROM facts WHERE created >= ? AND created < ? AND ${ACTIVE_FACT} ORDER BY importance DESC, id DESC`).all(from, until, new Date().toISOString()) as unknown as FactDbRow[];
      const kept = rows.slice(0, limit).map((r): MemoryHit => ({ kind: "fact", at: r.created, fact: toFact(r), score: 1 }));
      return { hits: kept, more: Math.max(0, rows.length - kept.length) };
    }
    if (kind === "all" || kind === "summary") {
      const rows = this.db.prepare("SELECT * FROM summaries WHERE end >= ? AND start < ? ORDER BY start").all(from, until) as unknown as SummaryRow[];
      total += rows.length;
      for (const r of rows) hits.push({ kind: r.period as SummaryKind, at: r.start, end: r.end, text: r.text, score: 1 });
    }
    if (kind === "all" || kind === "conversation") {
      const n = (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE ts >= ? AND ts < ?").get(from, until) as { n: number }).n;
      total += Math.ceil(n / 3);
      const rows = this.db.prepare("SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY id LIMIT ?").all(from, until, limit * 6) as unknown as MessageRow[];
      // A few lines per hit, in order
      for (let i = 0; i < rows.length; i += 3) {
        const group = rows.slice(i, i + 3).map(toLine);
        hits.push({ kind: "conversation", at: group[0].at, lines: group, score: 0 });
      }
    }
    const kept = hits.slice(0, limit);
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

  /** Forgets everything ("Dimentica tutto"): rows, indexes, vectors, and the free pages in the file. */
  clear(): void {
    const tables = this.db.prepare("SELECT name FROM vec_tables").all() as { name: string }[];
    for (const t of tables) this.db.exec(`DROP TABLE IF EXISTS ${t.name}`);
    this.db.exec("DELETE FROM vec_tables; DELETE FROM embeddings; DELETE FROM messages; DELETE FROM summaries; DELETE FROM facts;");
    this.db.exec(
      "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild'); INSERT INTO summaries_fts(summaries_fts) VALUES ('rebuild'); INSERT INTO facts_fts(facts_fts) VALUES ('rebuild');",
    );
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
