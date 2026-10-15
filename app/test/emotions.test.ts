// Emotions: the guess from the text, the parsed say call, and how long an emotion stays on the face.
import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCall } from "../src/main/brain/tools";
import { Mood } from "../src/main/mood";
import { guessEmotion, toEmotion } from "../src/shared/emotions";
import type { FaceState } from "../src/shared/types";

test("a light emotion is guessed from cue words and punctuation", () => {
  const cases: [string, string][] = [
    ["Mi dispiace, non lo sapevo.", "tristezza"],
    ["Uffa, di nuovo!", "rabbia"],
    ["Ops, ho sbagliato.", "imbarazzo"],
    ["Wow, è enorme.", "sorpresa"],
    ["Davvero? Non lo sapevo", "sorpresa"],
    ["Ma come?!", "sorpresa"],
    ["Che bello, ci vediamo domani.", "gioia"],
    ["Ahahah, buona questa.", "gioia"],
    ["Ci sentiamo dopo!", "gioia"],
    ["Mmh, vediamo un attimo.", "pensiero"],
    ["Sono le tre.", "neutra"],
    // Whole words only
    ["Una grandezza scusabile e un forsennato.", "neutra"],
  ];
  for (const [text, emotion] of cases) assert.equal(guessEmotion(text).emotion, emotion, text);
  assert.ok(guessEmotion("Ci sentiamo dopo!").intensity < 0.5, "a bare exclamation is only a hint");
});

test("a say call without a valid emotion gets the guessed one; an explicit one always wins", () => {
  assert.deepEqual(parseToolCall("say", { text: "Purtroppo è chiuso." }), { name: "say", text: "Purtroppo è chiuso.", emotion: "tristezza", intensity: 0.5 });
  assert.deepEqual(parseToolCall("say", { text: "Purtroppo è chiuso.", emotion: "boh", intensity: 0.9 }), { name: "say", text: "Purtroppo è chiuso.", emotion: "tristezza", intensity: 0.9 });
  assert.deepEqual(parseToolCall("say", { text: "Purtroppo è chiuso.", emotion: "gioia" }), { name: "say", text: "Purtroppo è chiuso.", emotion: "gioia", intensity: 0.6 });
});

test("an answer's emotion fades 1.5-3 s after Lumi stops talking; an interruption clears it at once", () => {
  let now = 0;
  const sent: FaceState[] = [];
  const mood = new Mood((s) => sent.push(s), () => now, () => 0.5);
  mood.dispose();
  mood.set({ speaking: true });
  mood.setEmotion("gioia", 0.8);
  now = 30_000;
  mood.tick();
  assert.equal(mood.state().expression, "gioia", "it stays while Lumi talks");
  mood.set({ speaking: false });
  now += 2200;
  mood.tick();
  assert.equal(mood.state().expression, "gioia");
  now += 100;
  mood.tick();
  assert.equal(mood.state().expression, "neutra", "gone after 1.5 + 0.5 * 1.5 s");

  mood.setEmotion("sorpresa", 0.7);
  mood.clearEmotion();
  assert.equal(mood.state().expression, "neutra");
  assert.equal(sent.at(-1)?.expression, "neutra");
});

test("the new emotions: synonyms small models use, and cue words", () => {
  assert.equal(toEmotion("nerd"), "saccente");
  assert.equal(toEmotion("Suspicious"), "sospetto");
  assert.equal(toEmotion("scared"), "paura");
  assert.equal(toEmotion("shocked"), "spavento");
  assert.equal(toEmotion("cringe"), "smorfia");
  assert.equal(toEmotion("sarcasmo"), "apatia");
  const cases: [string, string][] = [
    ["In realtà si dice qual è, senza apostrofo.", "saccente"],
    ["Mmh, questa storia non mi convince.", "sospetto"],
    ["Attenzione: questo comando è irreversibile.", "paura"],
    ["Oh no, si è chiuso tutto!", "spavento"],
    ["Ahia, che battuta.", "smorfia"],
    ["Che noia, ancora le slide.", "apatia"],
    ["Wow, incredibile!", "sorpresa"],
    ["Il cielo è sereno.", "neutra"],
  ];
  for (const [text, emotion] of cases) assert.equal(guessEmotion(text).emotion, emotion, text);
});
