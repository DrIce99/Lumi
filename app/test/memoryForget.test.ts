// Weeks and months, daily backups (10.4) and the forget cascade (10.5).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Brain, type BrainHost } from "../src/main/brain/brain";
import { describeHit, Memory } from "../src/main/brain/memory";
import { makeBackup } from "../src/main/brain/memory/backup";
import { MemoryDb } from "../src/main/brain/memory/db";
import { backupName, backupsToDelete, duePeriods, monthSpan, weekSpan, weekStart } from "../src/main/brain/memory/periods";
import { MemoryStore } from "../src/main/brain/memory/store";
import type { ChatProvider } from "../src/main/brain/providers/types";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

const vecPath = (require("sqlite-vec") as { getLoadablePath(): string }).getLoadablePath();
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const day = (y: number, mo: number, d: number) => new Date(y, mo - 1, d).toISOString();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lumi-forget-"));
}

// ---------------- pure: periods and backup names ----------------

test("weeks run Monday to Sunday in local time; months are calendar months", () => {
  // Thursday 12 March 2026 -> Monday 9 March
  assert.equal(weekStart(new Date(2026, 2, 12, 18)).getTime(), new Date(2026, 2, 9).getTime());
  assert.equal(weekStart(new Date(2026, 2, 15, 23)).getTime(), new Date(2026, 2, 9).getTime(), "Sunday belongs to the week before");
  assert.equal(weekSpan(new Date(2026, 2, 12)).label, "la settimana dal 9 al 15 marzo 2026");
  assert.equal(weekSpan(new Date(2026, 3, 1)).label, "la settimana dal 30 marzo al 5 aprile 2026");
  assert.deepEqual(monthSpan(new Date(2026, 11, 31)), { kind: "month", start: day(2026, 12, 1), end: day(2027, 1, 1), label: "dicembre 2026" });
});

test("due periods: only weeks and months that are over, with days, not written yet", () => {
  const days = [day(2026, 2, 26), day(2026, 3, 3), day(2026, 3, 10), day(2026, 3, 18)];
  const now = new Date(2026, 2, 19, 10); // Thursday 19 March
  const due = duePeriods(days, new Set(), now, 10);
  assert.deepEqual(
    due.map((p) => `${p.kind}:${p.start.slice(0, 10)}`),
    [`week:${day(2026, 2, 23).slice(0, 10)}`, `week:${day(2026, 3, 2).slice(0, 10)}`, `week:${day(2026, 3, 9).slice(0, 10)}`, `month:${day(2026, 2, 1).slice(0, 10)}`],
    "the current week and month wait",
  );
  const written = new Set([`week:${day(2026, 2, 23)}`, `month:${day(2026, 2, 1)}`]);
  assert.equal(duePeriods(days, written, now, 10).length, 2);
  assert.equal(duePeriods(days, new Set(), now, 2).length, 2, "a few at a time");
});

test("backups: one name per local day, the newest kept", () => {
  assert.equal(backupName(new Date(2026, 9, 5, 23, 59)), "memory-2026-10-05.db");
  const names = ["memory-2026-10-01.db", "memory-2026-10-05.db", "notes.txt", "memory-2026-10-03.db", "memory-2026-10-04.db"];
  assert.deepEqual(backupsToDelete(names, 2), ["memory-2026-10-03.db", "memory-2026-10-01.db"]);
  assert.deepEqual(backupsToDelete(names, 0).length, 4, "other files are never touched");
});

test("makeBackup copies the database once a day and rotates; reset starts over", () => {
  const dir = tempDir();
  try {
    const db = new MemoryDb(join(dir, "memory.db"));
    db.append({ at: at(2026, 3, 1), who: "user", text: "ciao" });
    const backups = join(dir, "backups");
    mkdirSync(backups);
    for (const d of ["2026-09-01", "2026-09-02", "2026-09-03"]) writeFileSync(join(backups, `memory-${d}.db`), "old");
    const file = makeBackup(db, backups, 3, false, new Date(2026, 9, 15));
    assert.ok(file?.endsWith("memory-2026-10-15.db"));
    assert.equal(makeBackup(db, backups, 3, false, new Date(2026, 9, 15, 20)), null, "once a day");
    assert.deepEqual(readdirSync(backups).sort(), ["memory-2026-09-02.db", "memory-2026-09-03.db", "memory-2026-10-15.db"]);
    const copy = new MemoryDb(file!);
    assert.equal(copy.count().messages, 1, "a working copy");
    copy.close();
    makeBackup(db, backups, 3, true, new Date(2026, 9, 15));
    assert.deepEqual(readdirSync(backups), ["memory-2026-10-15.db"], "reset: only a fresh one");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- weeks and months written by the brain ----------------

test("the brain writes the summary of a finished week from its days", async () => {
  const db = new MemoryDb(":memory:");
  let now = new Date(2026, 2, 18, 9);
  const memory = new Memory(null, MemoryStore.local(db), () => now);
  memory.addDiary("2026-03-10", "Martedì abbiamo parlato del trasloco.");
  memory.addDiary("2026-03-12", "Giovedì ha finito il progetto RPG.");
  await memory.archived();
  const prompts: string[] = [];
  const provider = {
    id: "ollama",
    complete: async (o: { prompt: string }) => {
      prompts.push(o.prompt);
      return { text: "Una settimana di trasloco e lavoro.", usage: null, model: "m" };
    },
  } as unknown as ChatProvider;
  const brain = new Brain({ settings: () => DEFAULT_SETTINGS, memory, provider: () => ({ provider, model: "m" }) } as unknown as BrainHost);
  await brain.writePeriods();
  await memory.archived();
  assert.match(prompts[0], /^Diary of la settimana dal 9 al 15 marzo 2026:\n.*trasloco[\s\S]*RPG/);
  const [week] = db.summariesIn(["week"], "", "￿");
  assert.equal(week.text, "Una settimana di trasloco e lavoro.");
  assert.match(describeHit({ kind: "week", at: week.start, end: week.end, text: week.text, score: 1 }, "Diego"), /^\[settimana 2026-03-09 - 2026-03-15\]/);
  await brain.writePeriods();
  assert.equal(prompts.length, 1, "written once");
  // The month waits until it is over
  now = new Date(2026, 3, 2, 9);
  await brain.writePeriods();
  await memory.archived();
  assert.equal(db.summariesIn(["month"], "", "￿").length, 1);
});

// ---------------- the forget cascade ----------------

function marcoMemory(): MemoryDb {
  const db = new MemoryDb(":memory:", { vecExtension: vecPath });
  db.append({ at: at(2026, 3, 12, 18, 0), who: "user", text: "Marco mi ha prestato la sua bici rossa" });
  db.append({ at: at(2026, 3, 12, 18, 1), who: "lumi", text: "Gentile da parte sua!" });
  db.append({ at: at(2026, 3, 12, 18, 2), who: "user", text: "Domani vado in montagna" });
  db.addSummary({ kind: "day", start: day(2026, 3, 12), end: day(2026, 3, 13), text: "Marco gli ha prestato la bici; domani montagna." });
  db.addSummary({ kind: "week", start: day(2026, 3, 9), end: day(2026, 3, 16), text: "Settimana con la bici di Marco." });
  db.putFact({ id: 20, kind: "user", text: "Il suo amico Marco ha una bici rossa.", importance: 6, created: at(2026, 3, 12, 18, 3), source: { from: at(2026, 3, 12, 18, 0), to: at(2026, 3, 12, 18, 0) } });
  db.putFact({ id: 21, kind: "preference", text: "Ama la montagna.", importance: 5, created: at(2026, 3, 12, 18, 3), source: { from: at(2026, 3, 12, 18, 0), to: at(2026, 3, 12, 18, 2) } });
  return db;
}

test("find for forget: every layer, clear matches selected, a wide net for the rest", () => {
  const db = marcoMemory();
  const items = db.findForForget("la bici di Marco", null);
  const kinds = new Set(items.map((i) => i.type));
  assert.deepEqual(kinds, new Set(["message", "summary", "fact"]));
  const line = items.find((i) => i.type === "message")!;
  assert.equal(line.text, "Marco mi ha prestato la sua bici rossa");
  assert.equal(line.strong, true);
  assert.equal(line.label, "tu");
  assert.deepEqual(db.findForForget("ciao come va", null), []);
});

test("forget: lines go with their index and vectors, derived-only facts go, citing summaries turn stale", () => {
  const db = marcoMemory();
  const result = db.forget({ messages: [1], summaries: [], facts: [] });
  assert.deepEqual(result.messages.map((m) => m.text), ["Marco mi ha prestato la sua bici rossa"]);
  assert.deepEqual(result.facts, [20], "the fact only from that line goes; the one with other sources stays");
  assert.deepEqual(
    result.stale.map((s) => s.kind),
    ["day", "week"],
    "the day that covered the line, then its week",
  );
  assert.equal(db.search({ query: "bici rossa", kind: "conversation" }).hits.length, 0);
  assert.deepEqual(
    db.listFacts(at(2026, 4, 1)).map((f) => f.id),
    [21],
  );
  // Rewriting a stale summary updates its index too
  db.replaceSummary(result.stale[0].id, "Domani va in montagna.");
  assert.equal(db.search({ query: "Marco", kind: "summary" }).hits.length, 1, "only the week still says it");
  db.deleteSummary(result.stale[1].id);
  assert.equal(db.search({ query: "Marco" }).hits.length, 0);
  // A chosen summary goes directly; bad ids are ignored
  const again = db.forget({ messages: [999, -1], summaries: [result.stale[0].id], facts: [21] });
  assert.deepEqual(again.summaries.map((s) => s.kind), ["day"]);
  assert.deepEqual(again.facts, [21]);
  assert.equal(db.count().summaries, 0);
});

test("after forget and compact, nothing forgotten stays in the file: words, index terms, vector bytes", () => {
  const dir = tempDir();
  const file = join(dir, "memory.db");
  const db = new MemoryDb(file, { vecExtension: vecPath });
  try {
    const secret = "zanzibarqwx";
    db.append({ at: at(2026, 3, 1, 9, 0), who: "user", text: `La password del wifi è ${secret}, non dirla` });
    db.append({ at: at(2026, 3, 1, 9, 1), who: "user", text: "Questa frase invece resta nel ricordo" });
    // A vector with a pattern easy to find in the file's bytes
    const marker = [1234.5678, -8765.4321, 4242.4242, 1.5];
    const items = db.pendingEmbeddings("fake", 10);
    // The second line is embedded with the first as context: its vector also carries the secret
    db.storeEmbeddings("fake", items, items.map(() => marker));
    const markerBytes = Buffer.from(new Float32Array(marker).buffer);
    const contains = (needle: Buffer) => [file, `${file}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(needle));
    db.compact();
    assert.ok(contains(Buffer.from(secret)), "the secret is there before");
    db.forget({ messages: [1], summaries: [], facts: [] });
    db.compact();
    assert.equal(contains(Buffer.from(secret)), false, "no trace of the words");
    assert.equal(contains(markerBytes), false, "no trace of the vector");
    assert.equal(db.search({ query: "frase ricordo" }).hits.length, 1, "the rest still works");
    assert.deepEqual(db.embeddingCoverage("fake"), { done: 0, total: 1 }, "the next line's vector went too: the queue embeds it again");
    assert.deepEqual(
      db.pendingEmbeddings("fake", 10).map((i) => i.text),
      ["Utente: Questa frase invece resta nel ricordo"],
      "now without the forgotten line as context",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Memory.forgetItems: memory.json follows, summaries are rewritten or deleted, archive and backups go", async () => {
  const dir = tempDir();
  try {
    const db = new MemoryDb(join(dir, "memory.db"), { vecExtension: vecPath });
    let clock = new Date(2026, 2, 12, 18, 0);
    const memory = new Memory(join(dir, "memory.json"), MemoryStore.local(db), () => (clock = new Date(clock.getTime() + 60_000)));
    memory.setBackups(join(dir, "backups"), () => 7);
    memory.addMessage("user", "Marco mi ha prestato la sua bici rossa");
    memory.addMessage("lumi", "Gentile!");
    memory.addMessage("user", "Domani vado in montagna");
    const lines = memory.recentConversation(3);
    memory.addEpisode(lines, "Marco gli ha prestato la bici; domani va in montagna.");
    memory.addDiary("2026-03-12", "Giornata con la bici di Marco.");
    memory.remember("Il suo amico Marco ha una bici rossa.", "user", { source: { from: lines[0].at, to: lines[0].at } });
    writeFileSync(join(dir, "archive.jsonl.imported"), "old archive with Marco");
    await memory.archived();
    await memory.backup();
    const items = await memory.findForForget("bici Marco");
    const line = items.find((i) => i.type === "message" && /bici/.test(i.text))!;
    const rewrites: string[] = [];
    const report = await memory.forgetItems({ messages: [line.id], summaries: [], facts: [] }, async (summary, material) => {
      rewrites.push(summary.kind);
      return summary.kind === "episode" ? `Riscritto da ${material.lines.length} righe: domani montagna.` : null;
    });
    assert.deepEqual(report, { lines: 1, facts: 1, summaries: 0, rewritten: 1, removed: 1 });
    assert.deepEqual(rewrites, ["episode", "day"]);
    assert.ok(!memory.recentConversation(10).some((e) => /bici/.test(e.text)), "out of the recent window");
    assert.equal(memory.facts().length, 0, "the derived fact is gone from memory.json too");
    assert.equal(memory.episodes()[0].summary, "Riscritto da 2 righe: domani montagna.");
    assert.equal(memory.diary().length, 0, "the day without a rewrite is deleted");
    assert.equal(existsSync(join(dir, "archive.jsonl.imported")), false);
    const saved = readFileSync(join(dir, "memory.json"), "utf8");
    assert.ok(!/bici/.test(saved), "memory.json on disk says nothing about it");
    const backups = readdirSync(join(dir, "backups"));
    assert.equal(backups.length, 1);
    assert.ok(!readFileSync(join(dir, "backups", backups[0])).includes(Buffer.from("bici rossa")), "the fresh backup doesn't hold it");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the forget tool: an id deletes a fact, a query opens the list", () => {
  assert.deepEqual(parseToolCall("forget", { id: "f12" }), { name: "forget", id: "f12" });
  assert.deepEqual(parseToolCall("forget", { query: "Marco" }), { name: "forget", query: "Marco" });
  assert.equal(parseToolCall("forget", {}), null);
});
