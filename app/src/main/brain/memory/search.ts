// The pure side of searching Lumi's memory: Italian query terms (lightly
// stemmed, matched as prefixes in SQLite FTS5), date ranges written by the
// model ("2026-03", "2026-03-12", "2026-03-12 18:00") and how the results
// read for the model. Tested; the queries themselves run in db.ts.

const STOPWORDS = new Set(
  (
    "a ad al alla alle allo ai agli anche ancora che chi ci come con cosa cui da dal dalla dei del della delle dello degli di dove e ed " +
    "è era essere fa fare gli ha hai ho i il in io la le lei li lo loro lui ma me mi mia mie mio miei ne nei nel nella no noi non " +
    "o per perché più poi però qua quale quali quando quanto quella quelle quello questi questo qui se sei si sia sono su sua sue " +
    "suo sul sulla ti tra tu tua tue tuo un una uno vi voi già molto tutto tutti tutta poco solo sempre allora quindi ok ciao lumi " +
    "eh ah oh beh dunque cioè tipo sì si va bene grazie prego " +
    // Words of asking about the past, not of what it was about
    "ricordi ricordo ricorda ricordare ricordarti ricordati detto dissi dicevo dici dire sai sapere parlato parlavamo parlare " +
    "avevo avevi avevamo abbiamo hai ho volta quella quel quella cosa cose fatto successo"
  )
    .split(" ")
    .map((w) => w.normalize("NFD").replace(/[̀-ͯ]/g, "")),
);

/** Lowercase words without accents and stopwords, with a light Italian stem (plural and gender endings). */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function stem(word: string): string {
  if (word.length <= 3 || /^\d+$/.test(word)) return word;
  // nero/neri -> ner, casa/case -> cas
  if (word.length === 4) return word.replace(/[aeio]$/, "");
  // gatto/gatti/gatta/gatte -> gatt; lavorare/lavorato/lavoro -> lavor
  return word.replace(/(?:are|ere|ire|ato|ata|ati|ate|uto|uta|iti|ite|ando|endo|zione|zioni|mente|issimo|issima)$/, "").replace(/[aeio]$/, "") || word;
}

/** The distinct terms of a query, at most 12 (a long message is not a better query). */
export function queryTerms(query: string): string[] {
  return [...new Set(terms(query))].slice(0, 12);
}

/** An FTS5 query: any of the terms, each as a prefix ("gatt"* finds gatto and gatti); null when nothing is left. */
export function ftsQuery(query: string): string | null {
  const q = queryTerms(query);
  return q.length ? q.map((t) => `"${t}"*`).join(" OR ") : null;
}

/** How many of the query terms a text contains (as word prefixes). */
export function matchedTerms(text: string, query: string[]): number {
  const words = terms(text);
  return query.filter((q) => words.some((w) => w.startsWith(q))).length;
}

/** A hit counts only with at least half of the query's words: one common word in common is not a memory. */
export function enoughMatched(text: string, query: string[]): boolean {
  return query.length > 0 && matchedTerms(text, query) >= Math.ceil(query.length / 2);
}

/** ISO bounds [from, to) of a range written as dates, local time; null when unreadable. */
export function dateRange(from: string | undefined, to: string | undefined): { from: string; to: string } | null {
  const start = from ? parseMoment(from, "start") : null;
  const end = to ? parseMoment(to, "end") : null;
  if ((from && !start) || (to && !end)) return null;
  // A single month or day given as "from" alone covers that month or day
  const until = end ?? (from && !to ? parseMoment(from, "end") : null);
  const range = { from: start ? start.toISOString() : "", to: until ? until.toISOString() : "￿" };
  return range.from < range.to ? range : null;
}

/**
 * "2026", "2026-03", "2026-03-12" or "2026-03-12 18:30" (local time): its
 * first instant ("start") or the first instant after it ("end").
 */
export function parseMoment(text: string, edge: "start" | "end"): Date | null {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[ t](\d{1,2}):(\d{2}))?)?)?$/i.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null, m[4] ? Number(m[4]) : null, m[5] ? Number(m[5]) : null];
  if ((mo !== null && (mo < 1 || mo > 12)) || (d !== null && (d < 1 || d > 31)) || (h !== null && h > 23) || (mi !== null && mi > 59)) return null;
  const step = edge === "end" ? 1 : 0;
  if (mo === null) return new Date(y + step, 0, 1);
  if (d === null) return new Date(y, mo - 1 + step, 1);
  if (h === null) return new Date(y, mo - 1, d + step);
  return new Date(y, mo - 1, d, h, mi! + step);
}

/** A moment as the model reads it: "2026-03-12 18:40" in local time. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------- hybrid search: fusion and score ----------------

/** Reciprocal Rank Fusion constant (the usual 60: a rank-1 hit is not worth everything). */
export const RRF_K = 60;

/** Fuses ranked lists of ids: each id scores the sum of 1 / (k + rank) over the lists it appears in. */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1)));
  return out;
}

export interface ScoreWeights {
  relevance: number;
  recency: number;
  importance: number;
}

/** Generative Agents (Park et al., 2023) weights, to tune. */
export const DEFAULT_WEIGHTS: ScoreWeights = { relevance: 1, recency: 0.5, importance: 0.5 };

/** Recency 0..1: decays by 0.5% per hour since the memory (a day: 0.89, a week: 0.43, a month: 0.03). */
export function recency(hoursAgo: number, base = 0.995): number {
  return Math.pow(base, Math.max(0, hoursAgo));
}

/**
 * The final order of a memory: relevance (fused, normalized 0..1),
 * recency and importance (0..1; facts only, later) weighted. It only
 * orders: nothing is dropped because of it.
 */
export function memoryScore(m: { relevance: number; hoursAgo: number; importance?: number }, w: ScoreWeights = DEFAULT_WEIGHTS): number {
  return w.relevance * m.relevance + w.recency * recency(m.hoursAgo) + w.importance * (m.importance ?? 0);
}

/**
 * Below this cosine similarity a vector hit is noise, not a memory.
 * Measured on Italian questions vs. lines (scripts in the 10.2 notes):
 * bge-m3 puts unrelated lines at 0.31-0.51 and right answers at 0.54-0.71;
 * nomic-embed-text (English) packs everything in 0.43-0.66.
 */
const SIMILARITY_FLOOR: [RegExp, number][] = [
  [/^bge-m3/i, 0.5],
  [/^nomic-embed-text/i, 0.6],
];
const DEFAULT_FLOOR = 0.55;

export function similarityFloor(model: string): number {
  return SIMILARITY_FLOOR.find(([re]) => re.test(model))?.[1] ?? DEFAULT_FLOOR;
}

/** Vector hits further than this below the best one are dropped: the best match stands out, the rest is noise. */
export const RELATIVE_MARGIN = 0.06;

/** The vector hits worth keeping (cosine similarities, any order). */
export function keepSimilar<T extends { similarity: number }>(hits: T[], model: string): T[] {
  const floor = similarityFloor(model);
  const best = Math.max(-1, ...hits.map((h) => h.similarity));
  return hits.filter((h) => h.similarity >= floor && h.similarity >= best - RELATIVE_MARGIN);
}

/** Some embedding models want a task prefix (nomic-embed-text); bge-m3 doesn't. */
export function embeddingInput(model: string, kind: "query" | "document", text: string): string {
  if (/^nomic-embed-text/i.test(model)) return `${kind === "query" ? "search_query" : "search_document"}: ${text}`;
  return text;
}
