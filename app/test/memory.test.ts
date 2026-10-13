// Long-term memory: the archive on disk, episodes with facts, search and the context.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Brain, parseEpisodeReply, type BrainHost } from "../src/main/brain/brain";
import { Memory } from "../src/main/brain/memory";
import { buildContext } from "../src/main/brain/prompt";
import type { ChatProvider } from "../src/main/brain/providers/types";
import { search, terms } from "../src/main/brain/recall";
import { parseToolCall } from "../src/main/brain/tools";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

/** A clock that moves one minute per call, from a fixed morning. */
function ticking(start = "2026-10-12T08:00:00") {
  let t = new Date(start).getTime();
  return () => new Date((t += 60_000));
}

test("terms: accents, stopwords and plural or gender endings don't matter", () => {
  assert.deepEqual(terms("Il dentista è alle 10, poi i gatti"), ["dentist", "10", "gatt"]);
  assert.deepEqual(terms("gatto"), terms("gatti"));
  assert.deepEqual(terms("perché città"), ["citt"]);
});

test("search ranks real matches and ignores the rest", () => {
  const docs = [
    { id: "1", at: "2026-10-01T10:00:00Z", kind: "conversation" as const, text: "Utente: domani vado dal dentista alle dieci" },
    { id: "2", at: "2026-10-02T10:00:00Z", kind: "conversation" as const, text: "Utente: ho comprato un gatto nero" },
    { id: "3", at: "2026-10-03T10:00:00Z", kind: "episode" as const, text: "Abbiamo parlato del suo progetto Electron e di un bug nel gatto" },
  ];
  assert.equal(search(docs, "ti ricordi il dentista?")[0].doc.id, "1");
  assert.deepEqual(
    search(docs, "i gatti").map((h) => h.doc.id),
    ["2", "3"],
  );
  assert.deepEqual(search(docs, "ciao come va"), [], "only stopwords and unknown words: nothing");
});

test("every line goes to the archive on disk, and a new Memory reads it back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-memory-"));
  try {
    const file = join(dir, "memory.json");
    const memory = new Memory(file, ticking());
    memory.addMessage("user", "Il mio gatto si chiama Pixel");
    memory.addMessage("other", "Ciao a tutti", false, { name: "Marco", via: "Discord" });
    memory.flush();
    await memory.archived();
    const lines = readFileSync(join(dir, "archive.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), { at: JSON.parse(lines[1]).at, who: "other", text: "Ciao a tutti", name: "Marco", via: "Discord" });
    // Push the cat out of the recent window: it is still found
    const again = new Memory(file, ticking("2026-10-12T09:00:00"));
    for (let i = 0; i < 20; i++) again.addMessage(i % 2 ? "lumi" : "user", `riga ${i} sul lavoro`);
    assert.match(again.search("come si chiama il gatto?")[0].doc.text, /Pixel/);
    again.clear();
    await again.archived();
    assert.equal(readFileSync(join(dir, "archive.jsonl"), "utf8"), "", "forgetting everything empties the archive too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("older lines become an episode, with the new facts saved; the recent window stays verbatim", async () => {
  const memory = new Memory(null, ticking());
  for (let i = 0; i < 40; i++) memory.addMessage(i % 2 ? "lumi" : "user", i === 2 ? "Venerdì vado a Milano da mia sorella Giulia" : `chiacchiera ${i}`);
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
  // The episode and the recent window go into the context; the search finds the episode
  const context = buildContext({
    situation: { now: new Date("2026-10-12T09:00:00"), activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 10, awayMinutes: 0 }, voice: true, screen: "", vision: "ask" },
    settings: DEFAULT_SETTINGS,
    facts: memory.facts(),
    reminders: [],
    diary: [],
    episodes: memory.recentEpisodes(),
    recalled: memory.search("quando vado a Milano?"),
    conversation: memory.recentConversation(16),
    trigger: { kind: "message", text: "quando vado a Milano?", via: "voice" },
  });
  assert.match(context, /<earlier>\n\[08:\d\d-08:\d\d\] Mi ha detto che venerdì va a Milano/);
  assert.match(context, /<recalled>\n.*Milano/);
  assert.match(context, /chiacchiera 39/);
});

test("the episode reply is read leniently", () => {
  assert.deepEqual(parseEpisodeReply("Abbiamo parlato di musica."), { summary: "Abbiamo parlato di musica.", facts: [] });
  assert.deepEqual(parseEpisodeReply('{"summary": "Ok.", "facts": ["Ama il jazz", {"fact": "Lavora a Torino", "kind": "work"}, {"fact": "Nota", "kind": "note"}]}').facts, [
    { fact: "Ama il jazz", kind: "user" },
    { fact: "Lavora a Torino", kind: "work" },
    { fact: "Nota", kind: "user" },
  ]);
});

test("the diary uses the archive and the day's episodes, not only the lines still in the window", () => {
  let now = new Date("2026-10-11T08:00:00");
  const memory = new Memory(null, () => now);
  for (let i = 0; i < 140; i++) {
    now = new Date(now.getTime() + 60_000);
    memory.addMessage("user", `ieri ${i}`);
  }
  now = new Date("2026-10-12T08:00:00");
  memory.addEpisode(memory.recentConversation(140).slice(0, 10), "Prima parte della giornata.");
  const [day] = memory.pendingDiaryDays();
  assert.equal(day.date, "2026-10-11");
  assert.equal(day.episodes.length, 1);
  // 140 lines, the first 30 covered by the episode (which ends at the 30th): the 20 that left the window are not lost
  assert.equal(day.entries.length, 110);
  assert.equal(day.entries[0].text, "ieri 30");
});

test("recall is a valid tool", () => {
  assert.deepEqual(parseToolCall("recall", { query: "dentista" }), { name: "recall", query: "dentista" });
  assert.equal(parseToolCall("recall", {}), null);
});
