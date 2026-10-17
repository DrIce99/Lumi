// Is a heard sentence meant for Lumi? The transcript rules, the model's
// question and answer, and how a turn reports the way it was opened.
import assert from "node:assert/strict";
import test from "node:test";
import { Brain, type BrainHost } from "../src/main/brain/brain";
import type { ChatProvider } from "../src/main/brain/providers/types";
import { muteConsole } from "../src/main/log";
import { addressedWithoutModel, addressingPrompt, classifyAddressing, parseAddressingReply, THREAD_SECONDS, type AddressingInput } from "../src/main/voice/addressing";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

const base: Omit<AddressingInput, "text"> = { opened: "open", wakeWord: "ehi lumi", lumiAsked: false, inCall: false };
const verdict = (text: string, extra: Partial<AddressingInput> = {}) => classifyAddressing({ ...base, text, ...extra });

test("the hotkey, the name and a barge-in are always for Lumi", () => {
  for (const opened of ["ptt", "name", "barge"] as const) assert.equal(verdict("boh, passami il sale", { opened }).verdict, "yes");
});

test("the name anywhere in the sentence, however it is written", () => {
  for (const text of ["Ehi Lumi, che ore sono?", "senti Lumi, apri discord", "dimmi una cosa, Lumi", "Lumì dimmi", "ok rumi ascolta", "Lumy?"]) {
    assert.equal(verdict(text).reason, "name", text);
  }
  // Words that only look alike
  assert.notEqual(verdict("accendi le luci del salotto").reason, "name");
  assert.notEqual(verdict("mi serve un lume").reason, "name");
  assert.notEqual(verdict("lui mi ha detto di no").reason, "name");
  assert.notEqual(verdict("luci spente in cucina").reason, "name");
  // Another name in the settings
  assert.equal(verdict("dimmi Jarvis, che ore sono", { wakeWord: "ehi jarvis" }).reason, "name");
  assert.equal(verdict("dimmi Jarvys, che ore sono", { wakeWord: "ehi jarvis" }).reason, "name", "one letter off, for a long name");
  assert.notEqual(verdict("dimmi Lumi", { wakeWord: "ehi jarvis" }).reason, "name");
});

test("requests to an assistant are for Lumi, even without the name", () => {
  for (const text of ["che ore sono?", "cerca il meteo di domani", "apri il browser", "puoi leggermi questa pagina?", "cos'è un kernel", "come stai?", "ricordati di chiamare Marco", "dimmi una barzelletta", "cosa c'è sullo schermo?", "spostati più a destra"]) {
    assert.deepEqual(verdict(text), { verdict: "yes", reason: "request" }, text);
  }
});

test("calling someone else is not for Lumi", () => {
  assert.equal(verdict("Ehi ragazzi, guardate qui").verdict, "no");
  assert.equal(verdict("mamma, hai visto le chiavi?").verdict, "no");
  assert.equal(verdict("Marco, passami il caffè", { names: ["Marco", "Giulia Rossi"] }).verdict, "no");
  assert.equal(verdict("ciao Giulia come va", { names: ["Giulia Rossi"] }).verdict, "no");
  // A name Lumi doesn't know is not a clue
  assert.equal(verdict("Marco, passami il caffè").verdict, "maybe");
});

test("fillers and answers: a reply to Lumi's question is for Lumi, a stray 'ok' is not", () => {
  assert.deepEqual(verdict("ok"), { verdict: "no", reason: "filler" });
  assert.deepEqual(verdict("ahah"), { verdict: "no", reason: "filler" });
  assert.deepEqual(verdict("sì", { lumiAsked: true }), { verdict: "yes", reason: "answer to Lumi's question" });
  assert.equal(verdict("domani alle tre", { lumiAsked: true }).verdict, "yes");
  // Thanks right after an answer
  assert.equal(verdict("grazie", { opened: "followup" }).verdict, "yes");
  assert.equal(verdict("grazie", { opened: "open" }).verdict, "no");
  assert.equal(verdict("grazie", { opened: "followup", inCall: true }).verdict, "no");
});

test("in a call with friends nothing is for Lumi without its name or a question to answer", () => {
  assert.equal(verdict("hai visto quel tipo", { inCall: true }).verdict, "no");
  assert.equal(verdict("che ore sono", { inCall: true }).verdict, "no", "even a request: they ask each other too");
  assert.equal(verdict("Lumi, che ore sono", { inCall: true }).verdict, "yes");
  assert.equal(verdict("no, a sinistra", { inCall: true, lumiAsked: true }).verdict, "yes");
  // Right after an answer Lumi can't tell: the model reads the sentence
  assert.equal(verdict("e domani invece?", { inCall: true, opened: "followup" }).verdict, "maybe");
});

test("what the rules can't tell goes to the model", () => {
  assert.deepEqual(verdict("il volume è troppo alto"), { verdict: "maybe", reason: "unclear" });
  const long = Array.from({ length: 30 }, () => "parola").join(" ");
  assert.deepEqual(verdict(long), { verdict: "maybe", reason: "long talk" });
  assert.equal(verdict("   ").verdict, "no");
});

test("a sentence that picks up the exchange with Lumi is for her, even a minute after her answer, while nobody else joins in", () => {
  for (const text of ["e domani invece?", "quello che hai detto prima, me lo ripeti", "ma perché lo dici", "dopodomani?", "anche a Milano?", "aspetta, spiega meglio"]) {
    assert.deepEqual(verdict(text, { threadAgo: 60 }), { verdict: "yes", reason: "continues the exchange" }, text);
  }
  // Not for a sentence of the same shape out of the blue
  assert.equal(verdict("e domani invece?").verdict, "maybe");
  // Too long after her answer: a new subject, the model decides
  assert.equal(verdict("e domani invece?", { threadAgo: THREAD_SECONDS + 30 }).verdict, "maybe");
  // Voices not recognized (null) or only the user heard (false): nobody answers them
  assert.equal(verdict("e domani invece?", { threadAgo: 30, othersHeard: null }).verdict, "yes");
  assert.equal(verdict("e domani invece?", { threadAgo: 30, othersHeard: false }).verdict, "yes");
  // Something that doesn't clearly continue it is read in context by the model
  assert.deepEqual(verdict("va bene, lo faccio stasera", { threadAgo: 20 }), { verdict: "maybe", reason: "during an exchange" });
});

test("two voices answering each other are talking to each other", () => {
  // A second voice was heard: no exchange, nothing for Lumi
  assert.deepEqual(verdict("il volume è troppo alto", { othersHeard: true }), { verdict: "no", reason: "others are talking nearby" });
  assert.equal(verdict("passami il sale", { othersHeard: true }).verdict, "no");
  // Even a request, or a sentence in the middle of an exchange with her, is only a maybe: the model reads who talks to whom
  assert.equal(verdict("che ore sono", { othersHeard: true }).verdict, "maybe");
  assert.equal(verdict("e domani invece?", { othersHeard: true, threadAgo: 20 }).verdict, "maybe");
  // The name, or an answer to her question, still wins
  assert.equal(verdict("Lumi, che ore sono", { othersHeard: true }).verdict, "yes");
  assert.equal(verdict("sì, grazie", { othersHeard: true, lumiAsked: true }).verdict, "yes");
});

test("a sentence in another voice than the user's is only for Lumi when it names her or answers her", () => {
  assert.deepEqual(verdict("che ore sono", { otherVoice: true }), { verdict: "no", reason: "another voice" });
  assert.equal(verdict("Lumi, che ore sono", { otherVoice: true }).verdict, "yes");
  assert.equal(verdict("domani alle tre", { otherVoice: true, lumiAsked: true }).verdict, "yes");
  assert.equal(verdict("e domani invece?", { otherVoice: true, threadAgo: 10 }).verdict, "no");
});

test("when the model can't answer: right after her answer, or an exchange still open with nobody else talking", () => {
  const input = (extra: Partial<AddressingInput>): AddressingInput => ({ ...base, text: "boh", ...extra });
  assert.equal(addressedWithoutModel(input({ opened: "followup" })), true);
  assert.equal(addressedWithoutModel(input({ threadAgo: 45 })), true);
  assert.equal(addressedWithoutModel(input({ threadAgo: THREAD_SECONDS + 1 })), false);
  assert.equal(addressedWithoutModel(input({})), false);
  assert.equal(addressedWithoutModel(input({ opened: "followup", othersHeard: true })), false);
  assert.equal(addressedWithoutModel(input({ threadAgo: 10, otherVoice: true })), false);
  assert.equal(addressedWithoutModel(input({ opened: "followup", inCall: true })), false);
});

test("the model's question carries the recent lines, and its answer is read", () => {
  const prompt = addressingPrompt({ text: 'ho detto "no"', conversation: ["Diego: che ore sono", "Lumi: Sono le nove. Altro?"], lumiAgo: 4.2, inCall: false, opened: "followup" });
  assert.match(prompt, /Lumi: Sono le nove/);
  assert.match(prompt, /Lumi spoke 4 seconds ago/);
  assert.match(prompt, /not in a call/);
  assert.match(prompt, /Other voices nearby: unknown/);
  assert.match(addressingPrompt({ text: "x", conversation: [], lumiAgo: null, inCall: false, othersHeard: true, opened: "open" }), /Another voice \(not the user's\) was heard nearby/);
  assert.match(addressingPrompt({ text: "x", conversation: [], lumiAgo: null, inCall: false, othersHeard: false, opened: "open" }), /Only the user's voice was heard/);
  assert.match(prompt, /Sentence heard: "ho detto 'no'"/, "quotes can't break out of the sentence");
  assert.match(addressingPrompt({ text: "x", conversation: [], lumiAgo: null, inCall: true, opened: "open" }), /has not spoken recently[\s\S]*in a call with friends/);

  assert.equal(parseAddressingReply('{"to_lumi": true}'), true);
  assert.equal(parseAddressingReply('```json\n{"to_lumi": false}\n```'), false);
  assert.equal(parseAddressingReply("false"), false);
  assert.equal(parseAddressingReply("Yes"), true);
  assert.equal(parseAddressingReply("forse"), null);
  assert.equal(parseAddressingReply('{"to_lumi": "maybe"}'), null);
  assert.equal(parseAddressingReply("yes and no"), null);
});

function brainWith(complete: ChatProvider["complete"], lines: { who: "user" | "lumi"; text: string; at: string }[] = []): Brain {
  const provider = { id: "ollama", complete } as unknown as ChatProvider;
  const host = {
    settings: () => DEFAULT_SETTINGS,
    memory: { recentConversation: () => lines },
    provider: () => ({ provider, model: "tiny" }),
  } as unknown as BrainHost;
  return new Brain(host);
}

test("Brain.isAddressed: reads the model's answer, gives up on slow or failing models", async () => {
  const asked: string[] = [];
  const yes = brainWith(async (o) => {
    asked.push(o.prompt);
    return { text: '{"to_lumi": true}', usage: null, model: "tiny" };
  }, [{ who: "lumi", text: "Vuoi che cerchi?", at: new Date(Date.now() - 3000).toISOString() }]);
  assert.equal(await yes.isAddressed("sì grazie", { inCall: false, opened: "followup", othersHeard: false }), true);
  assert.match(asked[0], /Lumi \(3 s ago\): Vuoi che cerchi\?/);
  assert.match(asked[0], /Only the user's voice was heard/);
  assert.match(asked[0], /Sentence heard: "sì grazie"/);

  const no = brainWith(async () => ({ text: '{"to_lumi": false}', usage: null, model: "tiny" }));
  assert.equal(await no.isAddressed("ho fame", { inCall: false, opened: "open" }), false);

  const slow = brainWith(() => new Promise(() => undefined));
  assert.equal(await slow.isAddressed("ciao", { inCall: false, opened: "open" }, 30), null);

  const broken = brainWith(async () => {
    throw new Error("rate limit");
  });
  assert.equal(await broken.isAddressed("ciao", { inCall: false, opened: "open" }), null);
});
