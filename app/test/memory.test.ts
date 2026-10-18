// Long-term memory: memory.db (raw log, FTS5, summaries), the search
// terms and dates, episodes with facts, the diary and the context.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consolidationReport } from "../src/main/brain/consolidate";
import { Brain, parseEpisodeReply, type BrainHost } from "../src/main/brain/brain";
import { describeHit, Memory } from "../src/main/brain/memory";
import { MemoryDb, SESSION_GAP_MS, type LineInput } from "../src/main/brain/memory/db";
import { dateRange, enoughMatched, ftsQuery, parseMoment, queryTerms, terms } from "../src/main/brain/memory/search";
import { MemoryStore } from "../src/main/brain/memory/store";
import { buildContext } from "../src/main/brain/prompt";
import type { ChatProvider } from "../src/main/brain/providers/types";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

/** A clock that moves one minute per call, from a fixed morning. */
function ticking(start = "2026-10-12T08:00:00") {
  let t = new Date(start).getTime();
  return () => new Date((t += 60_000));
}

/** An ISO time from a local date and time. */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

const line = (when: string, who: LineInput["who"], text: string, extra: Partial<LineInput> = {}): LineInput => ({ at: when, who, text, ...extra });

// ---------------- pure: terms and dates ----------------

test("terms: accents, stopwords and plural or gender endings don't matter", () => {
  assert.deepEqual(terms("Il dentista è alle 10, poi i gatti"), ["dentist", "10", "gatt"]);
  assert.deepEqual(terms("gatto"), terms("gatti"));
  assert.deepEqual(terms("perché città"), ["citt"]);
  assert.equal(ftsQuery("ti ricordi i gatti del dentista?"), '"gatt"* OR "dentist"*');
  assert.equal(ftsQuery("ciao, come va?"), null, "only stopwords: no query");
  const q = queryTerms("gatto nero Milano");
  assert.equal(enoughMatched("Ho un gatto bianco a Milano", q), true, "two of three words");
  assert.equal(enoughMatched("Il gatto dorme", q), false, "one of three is not enough");
});

test("dates as the model writes them become local ranges", () => {
  assert.equal(parseMoment("2026-03", "start")?.getTime(), new Date(2026, 2, 1).getTime());
  assert.equal(parseMoment("2026-03", "end")?.getTime(), new Date(2026, 3, 1).getTime());
  assert.equal(parseMoment("2026-12-31", "end")?.getTime(), new Date(2027, 0, 1).getTime());
  assert.equal(parseMoment("2026-03-12 18:30", "start")?.getTime(), new Date(2026, 2, 12, 18, 30).getTime());
  assert.equal(parseMoment("marzo", "start"), null);
  assert.equal(parseMoment("2026-13", "start"), null);
  // A month alone covers the whole month; from and to make a range with "to" included
  assert.deepEqual(dateRange("2026-03", undefined), { from: new Date(2026, 2, 1).toISOString(), to: new Date(2026, 3, 1).toISOString() });
  assert.deepEqual(dateRange("2026-03-10", "2026-03-12"), { from: new Date(2026, 2, 10).toISOString(), to: new Date(2026, 2, 13).toISOString() });
  assert.equal(dateRange(undefined, undefined)?.from, "");
  assert.equal(dateRange("ieri", undefined), null);
  assert.equal(dateRange("2026-03-12", "2026-03-01"), null, "an empty range");
});

// ---------------- memory.db ----------------

test("the raw log keeps every line, in sessions split by long pauses", () => {
  const db = new MemoryDb(":memory:");
  const first = db.append(line(at(2026, 3, 12, 18, 0), "user", "ciao"), "voice");
  db.append(line(at(2026, 3, 12, 18, 1), "lumi", "Ciao!", { interrupted: true }));
  db.append(line(new Date(Date.parse(at(2026, 3, 12, 18, 1)) + SESSION_GAP_MS + 1000).toISOString(), "other", "eccomi", { name: "Marco", via: "Discord" }), "Discord");
  const lines = db.between("", "￿");
  assert.equal(first, 1);
  assert.deepEqual(
    lines.map((l) => [l.who, l.session, l.channel ?? null, l.interrupted ?? false, l.name ?? null]),
    [
      ["user", 1, "voice", false, null],
      ["lumi", 1, null, true, null],
      ["other", 2, "Discord", false, "Marco"],
    ],
  );
  assert.deepEqual(db.count(), { messages: 3, summaries: 0 });
});

test("search: words as prefixes, half of them at least, with the lines around a hit", () => {
  const db = new MemoryDb(":memory:");
  db.append(line(at(2026, 3, 12, 18, 0), "user", "Sai che ho preso due gatti neri?"));
  db.append(line(at(2026, 3, 12, 18, 1), "lumi", "Che bello! Come si chiamano?"));
  db.append(line(at(2026, 3, 12, 18, 2), "user", "Pixel e Byte"));
  db.append(line(at(2026, 4, 2, 9, 0), "user", "Domani vado dal dentista alle dieci"));
  db.append(line(at(2026, 4, 2, 9, 1), "user", "Il gatto del vicino è scappato"));

  const cat = db.search({ query: "come si chiama il gatto nero?" });
  assert.equal(cat.hits.length, 1, "the neighbor's cat has only one word of two");
  const hit = cat.hits[0];
  assert.equal(hit.kind, "conversation");
  if (hit.kind === "conversation") assert.deepEqual(hit.lines.map((l) => l.text), ["Sai che ho preso due gatti neri?", "Che bello! Come si chiamano?"], "the hit and the next line");

  assert.equal(db.search({ query: "dentista" }).hits.length, 1);
  assert.equal(db.search({ query: "dentista", from: "2026-03" }).hits.length, 0, "filtered by month");
  assert.equal(db.search({ query: "dentista", from: "2026-04-02" }).hits.length, 1);
  assert.equal(db.search({ query: "dentista", before: at(2026, 4, 2, 8, 0) }).hits.length, 0, "the recent window is skipped");
  assert.equal(db.search({ query: "dentista", kind: "summary" }).hits.length, 0);
  assert.deepEqual(db.search({ query: "boh" }), { hits: [], more: 0 });
  assert.equal(db.search({ query: "gatto", from: "ieri" }).badRange, true);
});

test("search: summaries by words, and a period listed without words", () => {
  const db = new MemoryDb(":memory:");
  db.addSummary({ kind: "day", start: at(2026, 3, 12, 0), end: at(2026, 3, 13, 0), text: "Abbiamo parlato del trasloco a Torino." });
  db.addSummary({ kind: "episode", start: at(2026, 5, 1, 10), end: at(2026, 5, 1, 11), text: "Mi ha raccontato del concerto." });
  for (let i = 0; i < 10; i++) db.append(line(at(2026, 3, 12, 9, i), i % 2 ? "lumi" : "user", `riga ${i}`));

  const moving = db.search({ query: "trasloco Torino" });
  assert.deepEqual(
    moving.hits.map((h) => h.kind),
    ["day"],
  );
  // "Cosa ti ho detto il 12 marzo?": the day's summary first, then the lines in order
  const day = db.search({ from: "2026-03-12", limit: 3 });
  assert.equal(day.hits[0].kind, "day");
  assert.deepEqual(
    day.hits.slice(1).map((h) => (h.kind === "conversation" ? h.lines.map((l) => l.text).join("|") : h.kind)),
    ["riga 0|riga 1|riga 2", "riga 3|riga 4|riga 5"],
  );
  assert.ok(day.more > 0, "the rest is counted, not dropped silently");
  assert.deepEqual(
    db.search({ from: "2026-05", kind: "summary" }).hits.map((h) => h.kind),
    ["episode"],
  );
});

test("the old archive is imported once, and forgetting everything empties the database", () => {
  const db = new MemoryDb(":memory:");
  const data = {
    lines: [line(at(2026, 1, 2), "user", "seconda"), line(at(2026, 1, 1), "user", "prima")],
    summaries: [{ kind: "episode" as const, start: at(2026, 1, 1), end: at(2026, 1, 2), text: "Un episodio." }],
  };
  assert.equal(db.importLegacy(data), 2);
  assert.equal(db.importLegacy(data), 0, "never twice");
  assert.deepEqual(
    db.between("", "￿").map((l) => l.text),
    ["prima", "seconda"],
    "in time order",
  );
  db.clear();
  assert.deepEqual(db.count(), { messages: 0, summaries: 0 });
  assert.equal(db.search({ query: "prima" }).hits.length, 0, "the full-text index is empty too");
});

// ---------------- Memory on memory.db ----------------

test("every line goes to memory.db, and recall finds what left the recent window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-memory-"));
  const db = new MemoryDb(":memory:");
  try {
    const file = join(dir, "memory.json");
    // An archive from before memory.db
    writeFileSync(join(dir, "archive.jsonl"), `${JSON.stringify({ at: "2026-10-11T08:00:00.000Z", who: "user", text: "Il mio gatto si chiama Pixel" })}\n{"torn`);
    const memory = new Memory(file, MemoryStore.local(db), ticking());
    await memory.importLegacy();
    assert.ok(existsSync(join(dir, "archive.jsonl.imported")), "renamed, not deleted");
    assert.equal(existsSync(join(dir, "archive.jsonl")), false);
    memory.addMessage("other", "Ciao a tutti", false, { name: "Marco", via: "Discord" });
    memory.addMessage("user", "lavoro", false, { channel: "voice" });
    await memory.archived();
    assert.deepEqual(
      db.between("", "￿").map((l) => [l.who, l.text, l.channel ?? null]),
      [
        ["user", "Il mio gatto si chiama Pixel", null],
        ["other", "Ciao a tutti", "Discord"],
        ["user", "lavoro", "voice"],
      ],
    );
    assert.deepEqual(await memory.recall("lavoro"), [], "the recent window is already in the prompt");
    for (let i = 0; i < 20; i++) memory.addMessage(i % 2 ? "lumi" : "user", `riga ${i} sul lavoro`);
    const [hit] = await memory.recall("come si chiama il gatto?");
    assert.match(describeHit(hit, "Diego"), /^\[2026-10-11 \d\d:00\] Diego: Il mio gatto si chiama Pixel/);
    // search_memory with a date lists the period, the recent window included
    const listed = await memory.searchMemory({ from: "2026-10-12" });
    assert.ok(listed && listed.hits.length > 0);
    memory.clear();
    await memory.archived();
    assert.deepEqual(db.count(), { messages: 0, summaries: 0 });
    assert.equal(existsSync(join(dir, "archive.jsonl.imported")), false, "the old archive goes too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consolidating by hand summarizes the whole backlog at once and says what it did", async () => {
  const db = new MemoryDb(":memory:");
  const memory = new Memory(null, MemoryStore.local(db), ticking());
  for (let i = 0; i < 96; i++) memory.addMessage(i % 2 ? "lumi" : "user", `chiacchiera numero ${i}`);
  let n = 0;
  const provider = {
    id: "ollama",
    start: () => {
      throw new Error("not used");
    },
    complete: async () => ({ text: JSON.stringify({ summary: `Episodio ${++n}.`, facts: n === 1 ? [{ fact: "Gli piace il caffè amaro.", kind: "preference" }] : [] }), usage: null, model: "m" }),
  } as unknown as ChatProvider;
  const host = { settings: () => DEFAULT_SETTINGS, memory, provider: () => ({ provider, model: "m" }) } as unknown as BrainHost;
  const done = await new Brain(host).consolidate();
  assert.equal(done.episodes, 1, "the 72 lines older than the recent window, in one episode");
  assert.equal(done.facts, 1);
  assert.equal(memory.pendingEpisode(), null);
  assert.equal(consolidationReport(done, { added: 1, faded: 0 }, true), "Fatto: 1 episodio riassunto (1 fatto nuovo), abitudini: 1 nuove, 0 meno sicure. Backup di oggi aggiornato.");
  assert.equal(consolidationReport({ episodes: 0, facts: 0, days: 0, periods: 0 }, null, false), "Era già tutto in ordine: niente di nuovo da riassumere. Senza un modello per i momenti autonomi (scheda Cervello) i riassunti sono solo le frasi dette. Backup di oggi aggiornato.");
});

test("older lines become an episode, with the new facts saved; the recent window stays verbatim", async () => {
  const db = new MemoryDb(":memory:");
  const memory = new Memory(null, MemoryStore.local(db), ticking());
  for (let i = 0; i < 48; i++) memory.addMessage(i % 2 ? "lumi" : "user", i === 2 ? "Venerdì vado a Milano da mia sorella Giulia" : `chiacchiera ${i}`);
  assert.equal(memory.pendingEpisode()?.length, 24);
  const prompts: string[] = [];
  const provider = {
    id: "ollama",
    start: () => {
      throw new Error("not used");
    },
    complete: async (o: { prompt: string }) => {
      prompts.push(o.prompt);
      return {
        text: '```json\n{"summary": "Mi ha detto che venerdì va a Milano dalla sorella Giulia.", "facts": [{"fact": "Ha una sorella, Giulia, che vive a Milano.", "kind": "user"}, {"fact": "x", "kind": "user"}]}\n```',
        usage: null,
        model: "m",
      };
    },
  } as unknown as ChatProvider;
  const host = { settings: () => DEFAULT_SETTINGS, memory, provider: () => ({ provider, model: "m" }) } as unknown as BrainHost;
  await new Brain(host).writeEpisode();
  assert.match(prompts[0], /Venerdì vado a Milano/);
  assert.equal(memory.episodes().length, 1);
  assert.equal(memory.episodes()[0].summary, "Mi ha detto che venerdì va a Milano dalla sorella Giulia.");
  assert.deepEqual(
    memory.facts().map((f) => f.text),
    ["Ha una sorella, Giulia, che vive a Milano."],
    "too short facts are dropped",
  );
  assert.equal(memory.pendingEpisode(), null, "nothing left to summarize");
  assert.equal(db.count().summaries, 1, "the episode is in memory.db too");
  // The episode and the recent window go into the context; recall finds the episode and the line
  const context = buildContext({
    situation: { now: new Date("2026-10-12T09:00:00"), activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 10, awayMinutes: 0 }, voice: true, screen: "", vision: "ask" },
    settings: DEFAULT_SETTINGS,
    facts: memory.facts(),
    reminders: [],
    diary: [],
    episodes: memory.recentEpisodes(),
    recalled: await memory.recall("quando vado a Milano?"),
    conversation: memory.recentConversation(16),
    trigger: { kind: "message", text: "quando vado a Milano?", via: "voice" },
  });
  assert.match(context, /<earlier>\n\[08:\d\d-08:\d\d\] Mi ha detto che venerdì va a Milano/);
  assert.match(context, /<recalled>\n.*Milano/);
  assert.match(context, /chiacchiera 47/);
});

test("the episode reply is read leniently", () => {
  assert.deepEqual(parseEpisodeReply("Abbiamo parlato di musica."), { summary: "Abbiamo parlato di musica.", facts: [] });
  assert.deepEqual(parseEpisodeReply('{"summary": "Ok.", "facts": ["Ama il jazz", {"fact": "Lavora a Torino", "kind": "work"}, {"fact": "Nota", "kind": "note"}]}').facts, [
    { fact: "Ama il jazz", kind: "user" },
    { fact: "Lavora a Torino", kind: "work" },
    { fact: "Nota", kind: "user" },
  ]);
});

test("the diary uses memory.db and the day's episodes, not only the lines still in the window", async () => {
  let now = new Date("2026-10-11T08:00:00");
  const db = new MemoryDb(":memory:");
  const memory = new Memory(null, MemoryStore.local(db), () => now);
  for (let i = 0; i < 140; i++) {
    now = new Date(now.getTime() + 60_000);
    memory.addMessage("user", `ieri ${i}`);
  }
  now = new Date("2026-10-12T08:00:00");
  memory.addEpisode(memory.recentConversation(140).slice(0, 10), "Prima parte della giornata.");
  const [day] = await memory.pendingDiaryDays();
  assert.equal(day.date, "2026-10-11");
  assert.equal(day.episodes.length, 1);
  // 140 lines, the first 30 covered by the episode (which ends at the 30th): the 20 that left the window are not lost
  assert.equal(day.entries.length, 110);
  assert.equal(day.entries[0].text, "ieri 30");
  memory.addDiary(day.date, "Una giornata di prove.");
  assert.equal(db.search({ query: "prove", kind: "summary" }).hits[0].kind, "day");
});

test("search_memory is a valid tool, and the old recall name still works", () => {
  assert.deepEqual(parseToolCall("search_memory", { query: "dentista", from: "2026-03", kind: "summary" }), { name: "search_memory", query: "dentista", from: "2026-03", kind: "summary" });
  assert.deepEqual(parseToolCall("search_memory", { from: "2026-03-12", kind: "boh" }), { name: "search_memory", from: "2026-03-12" });
  assert.deepEqual(parseToolCall("recall", { query: "dentista" }), { name: "search_memory", query: "dentista" });
  assert.equal(parseToolCall("search_memory", {}), null, "words or dates are needed");
});

test("a memory reads with its date: lines, interruptions, other voices, diary days", () => {
  const lines = [
    { id: 1, session: 1, at: at(2026, 3, 12, 18, 40), who: "user" as const, text: "Ho finito il progetto" },
    { id: 2, session: 1, at: at(2026, 3, 12, 18, 41), who: "lumi" as const, text: "Brava!", interrupted: true },
    { id: 3, session: 1, at: at(2026, 3, 12, 18, 42), who: "other" as const, text: "Complimenti", name: "Marco", via: "Discord" },
  ];
  assert.equal(
    describeHit({ kind: "conversation", at: lines[0].at, lines, score: 1 }, "Diego"),
    "[2026-03-12 18:40] Diego: Ho finito il progetto\nLumi: Brava! [interrotto]\nMarco (Discord): Complimenti",
  );
  assert.equal(describeHit({ kind: "day", at: at(2026, 3, 12, 0), end: at(2026, 3, 13, 0), text: "Giornata piena.", score: 1 }, "Diego"), "[diario 2026-03-12] Giornata piena.");
  assert.equal(describeHit({ kind: "day", at: at(2026, 3, 12, 0), end: at(2026, 3, 13, 0), text: "x".repeat(50), score: 1 }, "Diego", 10), `[diario 2026-03-12] ${"x".repeat(9)}…`);
});
