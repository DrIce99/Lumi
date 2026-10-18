// Search by meaning: sqlite-vec vectors in memory.db, the embedding queue,
// RRF fusion with the words and the final score.
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryDb, type LineInput } from "../src/main/brain/memory/db";
import { EmbedError, OllamaEmbedder, SIDECAR_EMBED_MODEL, SidecarEmbedder, type Embedder } from "../src/main/brain/memory/embed";
import { Indexer, type Clock } from "../src/main/brain/memory/indexer";
import { embeddingInput, keepSimilar, memoryScore, recency, rrf, similarityFloor, terms } from "../src/main/brain/memory/search";

const vecPath = (require("sqlite-vec") as { getLoadablePath(): string }).getLoadablePath();

/** Words that mean the same thing share a dimension; the rest are hashed. */
const CONCEPTS: string[][] = [
  ["gatt", "mic", "animal", "pixel"],
  ["dentist", "dent"],
  ["milan", "citt"],
  ["trasloc", "cas", "trasferiment"],
];
const DIM = 24;

function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const t of terms(text)) {
    const concept = CONCEPTS.findIndex((c) => c.some((w) => t.startsWith(w)));
    if (concept >= 0) v[concept] += 1;
    else v[4 + ([...t].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % (DIM - 4))] += 0.15;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

class FakeEmbedder implements Embedder {
  readonly source = "ollama";
  calls: string[][] = [];
  failWith: EmbedError | null = null;
  constructor(readonly model = "fake-embed") {}
  async embed(texts: string[]): Promise<number[][]> {
    if (this.failWith) throw this.failWith;
    this.calls.push(texts);
    return texts.map(fakeVector);
  }
}

const manualClock = (): Clock & { t: number } => ({ t: 0, now() { return this.t; }, setTimeout: () => null, clearTimeout: () => undefined });

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const line = (when: string, who: LineInput["who"], text: string): LineInput => ({ at: when, who, text });

async function indexAll(indexer: Indexer): Promise<void> {
  while (await indexer.step());
}

// ---------------- pure ----------------

test("RRF rewards what both lists find, and the score mixes relevance and recency", () => {
  const fused = rrf([
    ["a", "b", "c"],
    ["c", "d"],
  ]);
  assert.ok(fused.get("c")! > fused.get("a")!, "found by both");
  assert.ok(fused.get("a")! > fused.get("b")!);
  assert.equal(fused.size, 4);
  assert.equal(recency(0), 1);
  assert.ok(Math.abs(recency(24) - 0.886) < 0.01, "a day ago");
  assert.ok(recency(24 * 30) < 0.03, "a month ago");
  const fresh = memoryScore({ relevance: 0.6, hoursAgo: 1 });
  const old = memoryScore({ relevance: 0.6, hoursAgo: 24 * 60 });
  assert.ok(fresh > old, "same relevance: the recent one first");
  assert.ok(memoryScore({ relevance: 1, hoursAgo: 24 * 60 }) > memoryScore({ relevance: 0.2, hoursAgo: 0 }), "relevance still matters most");
  assert.equal(memoryScore({ relevance: 1, hoursAgo: 0, importance: 1 }, { relevance: 1, recency: 0, importance: 0.5 }), 1.5);
  assert.equal(embeddingInput("nomic-embed-text:latest", "query", "gatto"), "search_query: gatto");
  assert.equal(embeddingInput("bge-m3", "document", "gatto"), "gatto");
});

test("vector hits: a floor per model, and only those close to the best one", () => {
  const sims = (...values: number[]) => values.map((similarity, i) => ({ i, similarity }));
  // bge-m3, measured: "quando ho l'appuntamento per i denti?" - the dentist 0.71, work 0.54 (noise)
  assert.deepEqual(keepSimilar(sims(0.71, 0.54, 0.45), "bge-m3:latest").map((h) => h.i), [0]);
  // "il mio animale" - the cat 0.61, everything else <= 0.51
  assert.deepEqual(keepSimilar(sims(0.51, 0.61, 0.5), "bge-m3").map((h) => h.i), [1]);
  // "quanto costa una pizza?" - nothing related: all below the floor
  assert.deepEqual(keepSimilar(sims(0.41, 0.39), "bge-m3"), []);
  assert.equal(similarityFloor("nomic-embed-text:latest"), 0.6);
  assert.equal(similarityFloor("mxbai-embed-large"), 0.55);
  assert.deepEqual(keepSimilar([], "bge-m3"), []);
});

// ---------------- the queue ----------------

test("the queue gives every line and summary a vector, newest first, with the line before as context", async () => {
  const db = new MemoryDb(":memory:", { vecExtension: vecPath });
  assert.equal(db.vectors, true);
  db.append(line(at(2026, 3, 12, 18, 0), "user", "Sai che ho preso un gatto?"));
  db.append(line(at(2026, 3, 12, 18, 1), "lumi", "Che bello! Come si chiama?"));
  db.append(line(at(2026, 3, 12, 18, 2), "user", "ok"));
  db.addSummary({ kind: "day", start: at(2026, 3, 12, 0), end: at(2026, 3, 13, 0), text: "Ha preso un gatto." });
  const embedder = new FakeEmbedder();
  const indexer = new Indexer(db, manualClock());
  indexer.configure(embedder);
  assert.deepEqual(indexer.current(), { state: "idle", model: "fake-embed", source: "ollama", done: 0, total: 3 }, '"ok" is too short for a vector');
  await indexAll(indexer);
  assert.equal(embedder.calls[0][0], "Utente: Sai che ho preso un gatto?\nLumi: Che bello! Come si chiama?", "newest first, with the line before");
  assert.equal(embedder.calls[0][2], "Ha preso un gatto.");
  assert.deepEqual(indexer.current(), { state: "idle", model: "fake-embed", source: "ollama", done: 3, total: 3 });
  assert.equal(await indexer.step(), false, "nothing left");
  assert.equal(embedder.calls.length, 1);
});

test("a new model re-indexes everything; the old vectors go only once the new ones cover it all", async () => {
  const db = new MemoryDb(":memory:", { vecExtension: vecPath });
  for (let i = 0; i < 20; i++) db.append(line(at(2026, 3, 1, 9, i), "user", `riga numero ${i} sul gatto`));
  const indexer = new Indexer(db, manualClock());
  const first = new FakeEmbedder("first");
  indexer.configure(first);
  await indexAll(indexer);
  const second = new FakeEmbedder("second");
  indexer.configure(second);
  await indexer.step();
  assert.deepEqual(db.embeddingCoverage("second"), { done: 16, total: 20 });
  assert.equal(db.embeddingCoverage("first").done, 20, "still there meanwhile");
  await indexAll(indexer);
  assert.equal(db.embeddingCoverage("first").done, 0, "dropped once the new model covers everything");
  assert.equal(db.embeddingCoverage("second").done, 20);
});

test("the queue reports a missing model, retries later, and waits while Lumi is busy", async () => {
  const db = new MemoryDb(":memory:", { vecExtension: vecPath });
  db.append(line(at(2026, 3, 1), "user", "una riga abbastanza lunga"));
  // A clock whose timers run when the test says so
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const clock: Clock = { now: () => now, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => undefined };
  const fire = async () => {
    timers.shift()!.fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const indexer = new Indexer(db, clock);
  const embedder = new FakeEmbedder("bge-m3");
  embedder.failWith = new EmbedError("Ollama 404: model not found", "missing");
  indexer.configure(embedder);
  await fire();
  assert.equal(indexer.current().state, "missing");
  assert.equal(timers[0].ms, 5 * 60_000, "a missing model is retried every 5 minutes");
  embedder.failWith = null;
  indexer.setBusy(true);
  await fire();
  assert.equal(indexer.current().state, "waiting", "Lumi is talking: no embedding now");
  indexer.setBusy(false);
  await fire();
  assert.equal(indexer.current().state, "waiting", "and a few seconds after");
  now += 6000;
  await fire();
  assert.deepEqual(indexer.current(), { state: "idle", model: "bge-m3", source: "ollama", done: 1, total: 1 });
  assert.equal(new Indexer(new MemoryDb(":memory:")).current().state, "unavailable", "without sqlite-vec");
});

// ---------------- hybrid search ----------------

function catMemory(): MemoryDb {
  const db = new MemoryDb(":memory:", { vecExtension: vecPath });
  db.append(line(at(2026, 3, 12, 18, 0), "user", "Ho preso un micio nero, si chiama Pixel"));
  db.append(line(at(2026, 3, 12, 18, 1), "lumi", "Che bello, benvenuto Pixel!"));
  db.append(line(at(2026, 4, 2, 9, 0), "user", "Domani ho il dentista alle dieci"));
  db.append(line(at(2026, 5, 2, 9, 0), "user", "Stiamo preparando il trasloco a Milano"));
  db.addSummary({ kind: "day", start: at(2026, 5, 2, 0), end: at(2026, 5, 3, 0), text: "Abbiamo parlato del trasferimento nella nuova città." });
  return db;
}

async function queryVector(text: string) {
  return { model: "fake-embed", vector: fakeVector(text) };
}

test("by meaning: a question without the same words still finds the memory", async () => {
  const db = catMemory();
  const indexer = new Indexer(db, manualClock());
  indexer.configure(new FakeEmbedder());
  await indexAll(indexer);
  const now = Date.parse(at(2026, 6, 1));
  const words = db.search({ query: "il mio animale" }, null, { now });
  assert.equal(words.hits.length, 0, "no word in common");
  const meaning = db.search({ query: "il mio animale" }, await queryVector("il mio animale"), { now });
  assert.equal(meaning.semantic, true);
  const first = meaning.hits[0];
  assert.equal(first.kind, "conversation");
  if (first.kind === "conversation") assert.match(first.lines.map((l) => l.text).join(" "), /Pixel/);
  assert.ok(!meaning.hits.some((h) => h.kind === "conversation" && h.lines.some((l) => /dentista/.test(l.text))), "unrelated lines stay out (similarity threshold)");
  // Moving house: the line (words and meaning) and the day summary (meaning only)
  const moving = db.search({ query: "trasloco" }, await queryVector("trasloco"), { now });
  assert.deepEqual(new Set(moving.hits.map((h) => h.kind)), new Set(["conversation", "day"]));
  // Filters apply to vectors too
  assert.equal(db.search({ query: "il mio animale", from: "2026-04" }, await queryVector("il mio animale"), { now }).hits.length, 0, "by date");
  assert.deepEqual(
    db.search({ query: "trasloco", kind: "summary" }, await queryVector("trasloco"), { now }).hits.map((h) => h.kind),
    ["day"],
    "by kind",
  );
  assert.equal(db.search({ query: "il mio animale", before: at(2026, 3, 1) }, await queryVector("il mio animale"), { now }).hits.length, 0, "the recent window is skipped");
});

test("vectors of another model are not searched, and forgetting everything drops them", async () => {
  const db = catMemory();
  const indexer = new Indexer(db, manualClock());
  indexer.configure(new FakeEmbedder("old"));
  await indexAll(indexer);
  const result = db.search({ query: "il mio animale" }, { model: "new", vector: fakeVector("il mio animale") });
  assert.equal(result.hits.length, 0);
  assert.equal(result.semantic, undefined);
  db.clear();
  assert.deepEqual(db.embeddingCoverage("old"), { done: 0, total: 0 });
});

test("the Ollama client: task prefixes, missing model and server down", async () => {
  const bodies: unknown[] = [];
  const ok = new OllamaEmbedder("http://127.0.0.1:11434/", "nomic-embed-text", "10m", async (url, init) => {
    assert.equal(url, "http://127.0.0.1:11434/api/embed");
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }));
  });
  assert.deepEqual(await ok.embed(["gatto"], "query", 1000), [[0.1, 0.2]]);
  assert.deepEqual(bodies[0], { model: "nomic-embed-text", input: ["search_query: gatto"], keep_alive: "10m", truncate: true });
  const missing = new OllamaEmbedder("http://x", "bge-m3", "10m", async () => new Response('{"error":"model \\"bge-m3\\" not found, try pulling it first"}', { status: 404 }));
  await assert.rejects(missing.embed(["a"], "document", 1000), (err: unknown) => err instanceof EmbedError && err.kind === "missing");
  const down = new OllamaEmbedder("http://x", "bge-m3", "10m", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(down.embed(["a"], "document", 1000), (err: unknown) => err instanceof EmbedError && err.kind === "offline");
});

test("the sidecar client (no Ollama): token, kind, errors, and bge-m3's floor", async () => {
  const bodies: unknown[] = [];
  const ok = new SidecarEmbedder("http://127.0.0.1:5000/", "tok", SIDECAR_EMBED_MODEL, async (url, init) => {
    assert.equal(url, "http://127.0.0.1:5000/embed");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tok");
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: SIDECAR_EMBED_MODEL, vectors: [[0.6, 0.8]] }));
  });
  assert.equal(ok.source, "sidecar");
  assert.deepEqual(await ok.embed(["gatto"], "query", 1000), [[0.6, 0.8]]);
  assert.deepEqual(bodies[0], { texts: ["gatto"], kind: "query", model: SIDECAR_EMBED_MODEL });
  // Same model as Ollama's default, int8: the floor measured for bge-m3 applies
  assert.equal(similarityFloor(SIDECAR_EMBED_MODEL), similarityFloor("bge-m3"));
  await assert.rejects(new SidecarEmbedder(null, "").embed(["a"], "document", 1000), (err: unknown) => err instanceof EmbedError && err.kind === "offline");
  const loading = new SidecarEmbedder("http://x", "t", SIDECAR_EMBED_MODEL, async () => new Response("download failed", { status: 503 }));
  await assert.rejects(loading.embed(["a"], "document", 1000), (err: unknown) => err instanceof EmbedError && err.kind === "failed");
  const stale = new SidecarEmbedder("http://x", "old", SIDECAR_EMBED_MODEL, async () => new Response("token", { status: 401 }));
  await assert.rejects(stale.embed(["a"], "document", 1000), (err: unknown) => err instanceof EmbedError && err.kind === "offline");
});
