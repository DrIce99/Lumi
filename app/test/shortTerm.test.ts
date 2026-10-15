// Short-term memory and promises kept: requests to remember or to look at
// the screen read from the user's words, the screen read on demand, what
// tools found kept for the next moments, and one more round when the model
// says "te lo segno" without calling remember.
import assert from "node:assert/strict";
import test from "node:test";
import { Brain, type BrainHost, type SayCall, type SpeechSink } from "../src/main/brain/brain";
import { readIntents } from "../src/main/brain/intents";
import { Memory } from "../src/main/brain/memory";
import { buildContext } from "../src/main/brain/prompt";
import type { ChatProvider, RoundResult, ToolCallOut, ToolResultIn } from "../src/main/brain/providers/types";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

test("intents: asking to remember, mentioning the screen; asking about the past is not a request", () => {
  const cases: [string, boolean, boolean][] = [
    ["Ricordati il mio UID", true, false],
    ["Ricordate il mio UD, così se me lo dimentico lo chiedo a te.", true, false],
    ["segnati che giovedì ho il dentista", true, false],
    ["tienilo a mente", true, false],
    ["guarda lo schermo e leggilo in basso a destra", false, true],
    ["memorizza quello che c'è scritto qui sopra", true, true],
    ["ti ricordi quando siamo andati al mare?", false, false],
    ["ricordami tra 20 minuti di chiamare Marco", false, false],
    ["che tempo fa domani?", false, false],
  ];
  for (const [text, remember, screen] of cases) {
    const got = readIntents(text);
    assert.deepEqual({ remember: got.remember, screen: got.screen }, { remember, screen }, text);
  }
  const moves = ["Posso starti sull'altro schermo, quello orizzontale?", "spostati in alto a destra", "vai sull'altro monitor", "levati, mi copri", "torna al tuo posto", "basta, stai ferma"];
  for (const text of moves) assert.equal(readIntents(text).move, true, text);
  for (const text of ["vado a cena", "ricordati il mio UID", "che tempo fa?"]) assert.equal(readIntents(text).move, false, text);
});

test("findings stay for half an hour in memory only, the same question replaces its answer", () => {
  let now = new Date("2026-10-15T16:00:00");
  const memory = new Memory(null, null, () => now);
  memory.addFinding("web_search", "Torino: sole, 23°C", "meteo Torino");
  memory.addFinding("look_at_screen", "Genshin Impact, UID 710351080 in basso a destra");
  memory.addFinding("web_search", "Torino: pioggia, 18°C", "meteo Torino");
  assert.deepEqual(
    memory.recentFindings().map((f) => f.text),
    ["Genshin Impact, UID 710351080 in basso a destra", "Torino: pioggia, 18°C"],
  );
  now = new Date("2026-10-15T16:31:00");
  assert.deepEqual(memory.recentFindings(), []);
  const context = buildContext({
    situation: { now, activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 10, awayMinutes: 0 }, voice: true, screen: "", vision: "local" },
    settings: DEFAULT_SETTINGS,
    facts: [],
    reminders: [],
    diary: [],
    conversation: [],
    findings: [{ at: now.toISOString(), source: "web_search", about: "meteo Torino", text: "pioggia\n18°C" }],
    screenNow: { label: "the active window (Genshin Impact) on screen 1", text: "UID 710351080" },
    trigger: { kind: "message", text: "qual è il mio UID?", via: "voice" },
  });
  assert.match(context, /<recent_findings>\n\[\d\d:\d\d, web_search: meteo Torino\] pioggia \| 18°C\n<\/recent_findings>/);
  assert.match(context, /<screen_now>\n.*Genshin Impact.*\nUID 710351080\n<\/screen_now>/);
});

/** A provider that replays scripted rounds and records what it was sent. */
function scripted(rounds: ToolCallOut[][]) {
  const contexts: string[] = [];
  const results: ToolResultIn[][] = [];
  let round = 0;
  const provider = {
    id: "gemini",
    start: (o: { context: string }) => {
      contexts.push(o.context);
      return {
        next: async (): Promise<RoundResult> => ({ toolCalls: rounds[round++] ?? [], text: "", stop: "tools", usage: null, model: "m" }),
        addResults: (r: ToolResultIn[]) => results.push(r.map((x) => ({ ...x }))),
        abort: () => undefined,
      };
    },
    complete: async () => ({ text: "", usage: null, model: "m" }),
  } as unknown as ChatProvider;
  return { provider, contexts, results, rounds: () => round };
}

function host(provider: ChatProvider, memory: Memory, screen: { label: string; text: string } | null) {
  const finals: SayCall[][] = [];
  const h = {
    settings: () => DEFAULT_SETTINGS,
    memory,
    provider: () => ({ provider, model: "m" }),
    situation: () => ({ now: new Date(), activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 1, awayMinutes: 0 }, voice: true, screen: "", vision: "never" as const }),
    startSpeech: (): SpeechSink => {
      let resolve!: (v: { text: string; interrupted: boolean }) => void;
      const heard = new Promise<{ text: string; interrupted: boolean }>((r) => (resolve = r));
      return {
        live: () => undefined,
        final: (says) => {
          finals.push(says);
          resolve({ text: says.map((s) => s.text).join(" "), interrupted: false });
        },
        done: () => heard,
        abort: () => undefined,
      };
    },
    say: () => undefined,
    setThinking: () => undefined,
    lookAt: () => "",
    lookAtScreen: async () => ({ notes: [], images: [] }),
    quiet: () => undefined,
    backOff: () => undefined,
    readScreen: async () => screen,
  } satisfies BrainHost;
  return { h, finals };
}

test("the UID case: the screen is read for the message, and \"te lo segno\" without remember gets one more round", async () => {
  const memory = new Memory(null);
  const say = (id: string, text: string): ToolCallOut => ({ id, name: "say", input: { emotion: "gioia", text } });
  const { provider, contexts, results, rounds } = scripted([
    [say("a", "Eccolo, te lo segno subito!")],
    [{ id: "b", name: "remember", input: { fact: "Il suo UID in Genshin Impact è 710351080.", kind: "user", importance: 6 } }, say("c", "Fatto, segnato.")],
  ]);
  const { h, finals } = host(provider, memory, { label: "the active window (Genshin Impact) on screen 1", text: "Paimon\nUID 710351080" });
  await new Brain(h).handle({ kind: "message", text: "Ricordati il mio UID, guarda lo schermo in basso a destra", via: "voice" });
  assert.match(contexts[0], /<screen_now>[\s\S]*UID 710351080/, "the screen read before the model answers");
  assert.equal(rounds(), 2, "one more round");
  assert.match(results[0].at(-1)!.text, /you have not called remember/);
  assert.deepEqual(
    memory.facts().map((f) => f.text),
    ["Il suo UID in Genshin Impact è 710351080."],
  );
  assert.deepEqual(
    finals[0].map((s) => s.text),
    ["Eccolo, te lo segno subito!", "Fatto, segnato."],
  );
  assert.equal(memory.recentFindings()[0].source, "screen_now", "what was read stays for the follow-up questions");
});

test("no extra round when remember was called, or when nothing was asked to remember", async () => {
  const memory = new Memory(null);
  const a = scripted([[{ id: "r", name: "remember", input: { fact: "Ha un gatto." } }, { id: "s", name: "say", input: { emotion: "gioia", text: "Segnato!" } }]]);
  await new Brain(host(a.provider, memory, null).h).handle({ kind: "message", text: "ricordati che ho un gatto", via: "voice" });
  assert.equal(a.rounds(), 1);
  const b = scripted([[{ id: "s", name: "say", input: { emotion: "gioia", text: "Ciao!" } }]]);
  await new Brain(host(b.provider, memory, null).h).handle({ kind: "message", text: "ciao Lumi", via: "voice" });
  assert.equal(b.rounds(), 1);
  assert.doesNotMatch(b.contexts[0], /<screen_now>/, "the screen is read only when mentioned");
});

test("asked to move and only said \"arrivo\": one more round, and a refused move goes back to the model", async () => {
  const say = (id: string, text: string): ToolCallOut => ({ id, name: "say", input: { emotion: "gioia", text } });
  const a = scripted([[say("a", "Trasloco subito di là!")], [{ id: "m", name: "move_to", input: { where: "other_screen" } }], [say("b", "Eccomi.")]]);
  const moves: string[] = [];
  const h = { ...host(a.provider, new Memory(null), null).h, moveTo: (call: { where: string }) => (moves.push(call.where), "You did NOT move: the user turned movement off in the settings. If you already said you moved, correct yourself now in one short sentence.") };
  await new Brain(h).handle({ kind: "message", text: "Posso starti sull'altro schermo?", via: "voice" });
  assert.deepEqual(moves, ["other_screen"], "the nudge made it call move_to");
  assert.match(a.results[0].at(-1)!.text, /you have not called move_to/);
  assert.equal(a.rounds(), 3, "the refusal came back to the model");
  assert.match(a.results[1][0].text, /You did NOT move/);
});
