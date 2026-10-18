// Facts in memory.db (layer 3): importance, sources, supersession, the
// import from memory.json, search, and which facts reach the prompt.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Brain, parseEpisodeReply, type BrainHost } from "../src/main/brain/brain";
import { describeHit, factNumber, Memory, selectFacts } from "../src/main/brain/memory";
import { MemoryDb } from "../src/main/brain/memory/db";
import { Indexer, type Clock } from "../src/main/brain/memory/indexer";
import { MemoryStore } from "../src/main/brain/memory/store";
import { buildContext } from "../src/main/brain/prompt";
import type { ChatProvider } from "../src/main/brain/providers/types";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS, type Fact } from "../src/shared/types";

muteConsole();

const vecPath = (require("sqlite-vec") as { getLoadablePath(): string }).getLoadablePath();
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const manualClock: Clock = { now: () => 0, setTimeout: () => null, clearTimeout: () => undefined };

/** Every fact shares one dimension with "lavoro" queries, nothing else: enough to check vectors are filtered. */
const embedder = {
  source: "ollama" as const,
  model: "fake",
  embed: async (texts: string[]) => texts.map((t) => (/lavor|ufficio|Torino|Milano/i.test(t) ? [1, 0, 0] : [0, 1, 0])),
};

test("facts in memory.db: sources, supersession, notes that expire, deletion with their vectors", async () => {
  const db = new MemoryDb(":memory:", { vecExtension: vecPath });
  db.append({ at: at(2026, 3, 1, 9, 0), who: "user", text: "Lavoro a Torino in un ufficio" });
  db.append({ at: at(2026, 3, 1, 9, 1), who: "lumi", text: "Bello!" });
  db.putFact({ id: 12, kind: "work", text: "Lavora a Torino.", importance: 7, created: at(2026, 3, 1, 9, 2), source: { from: at(2026, 3, 1, 9, 0), to: at(2026, 3, 1, 9, 1) } });
  db.putFact({ id: 13, kind: "note", text: "Oggi è stanco.", importance: 3, created: at(2026, 3, 1, 9, 2), expires: at(2026, 3, 1, 21, 0) });
  assert.deepEqual(
    db.listFacts(at(2026, 3, 1, 10)).map((f) => f.id),
    [12, 13],
  );
  assert.deepEqual(
    db.listFacts(at(2026, 3, 2)).map((f) => f.id),
    [12],
    "the note expired",
  );
  // Words find the fact, with its importance
  const found = db.search({ query: "dove lavora?", kind: "fact" }, null, { now: Date.parse(at(2026, 3, 2)) });
  assert.equal(found.hits[0].kind, "fact");
  assert.match(describeHit(found.hits[0], "Diego"), /^\[f12, 2026-03-01, work, importanza 7\] Lavora a Torino\.$/);
  // Indexing: the durable fact gets a vector, the note doesn't
  const indexer = new Indexer(db, manualClock);
  indexer.configure(embedder);
  while (await indexer.step());
  assert.deepEqual(db.embeddingCoverage("fake"), { done: 2, total: 2 }, 'one line ("Bello!" is too short) and one fact');
  // They moved: the new fact supersedes the old one, which stays as history but never comes back
  db.putFact({ id: 20, kind: "work", text: "Lavora a Milano.", importance: 7, created: at(2026, 4, 1) });
  db.supersedeFact(12, 20);
  assert.deepEqual(
    db.listFacts(at(2026, 4, 2)).map((f) => f.text),
    ["Lavora a Milano."],
  );
  const after = db.search({ query: "ufficio lavoro Torino", kind: "fact" }, { model: "fake", vector: [1, 0, 0] }, { now: Date.parse(at(2026, 4, 2)) });
  assert.ok(after.hits.every((h) => h.kind === "fact" && h.fact.id !== 12), "neither words nor vectors bring the old fact back");
  // Deleting a fact takes its vectors too
  while (await indexer.step());
  assert.equal(db.deleteFact(20), true);
  assert.equal(db.deleteFact(20), false);
  assert.deepEqual(db.embeddingCoverage("fake"), { done: 1, total: 1 }, "only the line is left");
});

test("importance moves a fact up, but relevance still decides", () => {
  const db = new MemoryDb(":memory:");
  const created = at(2026, 3, 1);
  db.putFact({ id: 1, kind: "preference", text: "Gli piace il caffè al mattino.", importance: 3, created });
  db.putFact({ id: 2, kind: "user", text: "Il caffè lo prende sempre dalla sorella Giulia.", importance: 9, created });
  const hits = db.search({ query: "caffè" }, null, { now: Date.parse(created) });
  assert.deepEqual(
    hits.hits.map((h) => (h.kind === "fact" ? h.fact.id : 0)),
    [2, 1],
  );
});

test("the facts of memory.json are imported once, keeping their ids; the database's list then wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-facts-"));
  try {
    const file = join(dir, "memory.json");
    const old: Fact[] = [
      { id: "f4", text: "Si chiama Diego.", kind: "user", createdAt: at(2026, 1, 1) },
      { id: "f9", text: "Ama il jazz.", kind: "preference", createdAt: at(2026, 1, 2) },
    ];
    writeFileSync(file, JSON.stringify({ version: 1, nextId: 10, facts: old, reminders: [], diary: [], conversation: [], stats: { bornAt: at(2026, 1, 1), lastSeenAt: at(2026, 1, 1), chats: 0 } }));
    const db = new MemoryDb(":memory:");
    const memory = new Memory(file, MemoryStore.local(db), () => new Date(at(2026, 3, 1)));
    await memory.loadFacts();
    assert.deepEqual(
      db.listFacts().map((f) => [f.id, f.importance]),
      [
        [4, 7],
        [9, 5],
      ],
      "ids kept, importance from the kind",
    );
    const fact = memory.remember("Ha un gatto, Pixel.", "user", { importance: 8 });
    assert.equal(fact.id, "f10", "numbering goes on");
    await memory.archived();
    const again = new Memory(file, MemoryStore.local(db), () => new Date(at(2026, 3, 2)));
    await again.loadFacts();
    assert.deepEqual(
      again.facts().map((f) => f.id),
      ["f4", "f9", "f10"],
      "imported only once, then read from memory.db",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remember with replaces: the old fact leaves the prompt and memory.db marks it", async () => {
  const db = new MemoryDb(":memory:");
  const memory = new Memory(null, MemoryStore.local(db), () => new Date(at(2026, 3, 1)));
  const torino = memory.remember("Vive a Torino.", "user", { importance: 9 });
  const milano = memory.remember("Vive a Milano.", "user", { importance: 9, replaces: torino.id });
  assert.deepEqual(
    memory.facts().map((f) => f.id),
    [milano.id],
  );
  await memory.archived();
  assert.deepEqual(
    db.listFacts(at(2026, 3, 2)).map((f) => f.text),
    ["Vive a Milano."],
  );
  assert.equal(memory.remember("vive a milano.", "user").id, milano.id, "no duplicates");
  assert.equal(memory.forget(milano.id), true);
  await memory.archived();
  assert.deepEqual(db.listFacts(at(2026, 3, 2)), []);
  assert.equal(factNumber("f12"), 12);
  assert.equal(factNumber("r3"), null);
});

test("the prompt gets notes, important facts, related ones and recent ones, within a budget", () => {
  const now = Date.parse(at(2026, 3, 10));
  const fact = (id: string, importance: number, created: string, kind: Fact["kind"] = "preference", text = `fatto ${id}`): Fact => ({ id, text, kind, createdAt: created, importance });
  const all = [
    fact("f1", 9, at(2026, 1, 1), "user"),
    fact("f2", 4, at(2026, 1, 2)),
    fact("f3", 4, at(2026, 1, 3)),
    fact("f4", 5, at(2026, 3, 9)),
    fact("n5", 3, at(2026, 3, 10), "note"),
  ];
  assert.deepEqual(
    selectFacts(all, ["f3"], now).map((f) => f.id),
    ["n5", "f1", "f3", "f4"],
    "f2: not important, not related, not recent",
  );
  assert.deepEqual(
    selectFacts(all, ["f3"], now, 70).map((f) => f.id),
    ["n5", "f1"],
    "the budget keeps the first groups",
  );
  const context = buildContext({
    situation: { now: new Date(now), activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 1, awayMinutes: 0 }, voice: true, screen: "", vision: "never" },
    settings: DEFAULT_SETTINGS,
    facts: selectFacts(all, [], now),
    factsTotal: all.length,
    reminders: [],
    diary: [],
    conversation: [],
    trigger: { kind: "tick" },
  });
  assert.match(context, /\(2 more facts are not shown here: .* search_memory with kind "fact" finds the rest\.\)/);
});

test("episodes: facts come with importance and corrections name the fact they replace", async () => {
  assert.deepEqual(
    parseEpisodeReply('{"summary": "Si è trasferito.", "facts": [{"fact": "Vive a Milano.", "kind": "user", "importance": 9.4, "replaces": "f3"}, {"fact": "Ama il tè.", "kind": "preference", "importance": 40, "replaces": "boh"}]}').facts,
    [
      { fact: "Vive a Milano.", kind: "user", importance: 9, replaces: "f3" },
      { fact: "Ama il tè.", kind: "preference", importance: 10 },
    ],
  );
  const db = new MemoryDb(":memory:");
  let t = Date.parse(at(2026, 3, 1, 8));
  const memory = new Memory(null, MemoryStore.local(db), () => new Date((t += 60_000)));
  const torino = memory.remember("Vive a Torino.", "user", { importance: 9 });
  for (let i = 0; i < 48; i++) memory.addMessage(i % 2 ? "lumi" : "user", i === 3 ? "Mi sono trasferito a Milano la settimana scorsa" : `chiacchiera ${i}`);
  const prompts: string[] = [];
  const provider = {
    id: "ollama",
    complete: async (o: { prompt: string }) => {
      prompts.push(o.prompt);
      return { text: `{"summary": "Si è trasferito a Milano.", "facts": [{"fact": "Vive a Milano.", "kind": "user", "importance": 9, "replaces": "${torino.id}"}]}`, usage: null, model: "m" };
    },
  } as unknown as ChatProvider;
  await new Brain({ settings: () => DEFAULT_SETTINGS, memory, provider: () => ({ provider, model: "m" }) } as unknown as BrainHost).writeEpisode();
  assert.match(prompts[0], new RegExp(`\\[${torino.id}\\] \\(user, 9\\) Vive a Torino\\.`), "the writer sees known facts with their ids");
  assert.deepEqual(
    memory.facts().map((f) => f.text),
    ["Vive a Milano."],
  );
  await memory.archived();
  const stored = db.listFacts(at(2026, 4, 1));
  assert.equal(stored[0].text, "Vive a Milano.");
  assert.equal(stored.length, 1, "Torino is history now");
});

test("remember validates importance and replaces", () => {
  assert.deepEqual(parseToolCall("remember", { fact: "Vive a Milano.", kind: "user", importance: 12, replaces: "f3" }), { name: "remember", fact: "Vive a Milano.", kind: "user", importance: 10, replaces: "f3" });
  assert.deepEqual(parseToolCall("remember", { fact: "Ama il tè.", importance: "tanto", replaces: "Torino" }), { name: "remember", fact: "Ama il tè.", kind: "user" });
});
