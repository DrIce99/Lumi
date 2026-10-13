// Searching Lumi's past: older conversation, episode summaries and diary
// days, ranked with BM25 on lightly stemmed Italian words. Everything stays
// on this computer; no embeddings service needed. Pure, tested.

export interface RecallDoc {
  id: string;
  /** ISO date-time (or YYYY-MM-DD for diary days). */
  at: string;
  kind: "conversation" | "episode" | "diary";
  text: string;
}

export interface RecallHit {
  doc: RecallDoc;
  score: number;
}

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
    .map((w) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")),
);

/** Lowercase words without accents and stopwords, with a light Italian stem (plural and gender endings). */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function stem(word: string): string {
  if (word.length <= 4 || /^\d+$/.test(word)) return word;
  // gatto/gatti/gatta/gatte -> gatt; lavorare/lavorato/lavoro -> lavor
  return word.replace(/(?:are|ere|ire|ato|ata|ati|ate|uto|uta|iti|ite|ando|endo|zione|zioni|mente|issimo|issima)$/, "").replace(/[aeio]$/, "") || word;
}

const K1 = 1.2;
const B = 0.75;

/**
 * The best `limit` documents for `query`, most relevant first. A document
 * counts only if it contains at least half of the query's words: one
 * common word in common is not a memory worth bringing up.
 */
export function search(docs: RecallDoc[], query: string, limit = 3): RecallHit[] {
  const q = [...new Set(terms(query))];
  if (!q.length || !docs.length) return [];
  const tokenized = docs.map((d) => terms(d.text));
  const avgLength = tokenized.reduce((sum, t) => sum + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of tokenized) for (const term of new Set(t)) if (q.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
  const hits: RecallHit[] = [];
  tokenized.forEach((t, i) => {
    let score = 0;
    let matched = 0;
    for (const term of q) {
      const n = df.get(term);
      if (!n) continue;
      let tf = 0;
      for (const x of t) if (x === term) tf++;
      if (!tf) continue;
      matched++;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * t.length) / avgLength));
    }
    if (matched > 0 && matched >= Math.ceil(q.length / 2)) hits.push({ doc: docs[i], score });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
