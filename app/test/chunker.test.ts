// The sentence chunker: punctuation, commas after 60 characters, abbreviations, streaming.
import assert from "node:assert/strict";
import test from "node:test";
import { SentenceChunker, splitSentences } from "../src/main/voice/chunker";

test("sentences end at . ! ? and line breaks", () => {
  assert.deepEqual(splitSentences("Ciao! Come stai? Io bene. A presto"), ["Ciao!", "Come stai?", "Io bene.", "A presto"]);
  assert.deepEqual(splitSentences("Riga uno\nRiga due"), ["Riga uno", "Riga due"]);
  assert.deepEqual(splitSentences("Davvero?! Wow... ok."), ["Davvero?!", "Wow...", "ok."]);
  assert.deepEqual(splitSentences("  "), []);
  assert.deepEqual(splitSentences("..."), []);
});

test("abbreviations, decimals and initials don't end a sentence", () => {
  assert.deepEqual(splitSentences("Usa es. questo. Fine."), ["Usa es. questo.", "Fine."]);
  assert.deepEqual(splitSentences("Costa 3.50 euro. Ok."), ["Costa 3.50 euro.", "Ok."]);
  assert.deepEqual(splitSentences("Ne parla G. Verdi qui. Sì."), ["Ne parla G. Verdi qui.", "Sì."]);
  assert.deepEqual(splitSentences("Vai su lumi.it per info. Grazie."), ["Vai su lumi.it per info.", "Grazie."]);
});

test("a long sentence is cut at a comma after 60 characters; the first piece sooner", () => {
  const long = "Questa è una frase abbastanza lunga che continua per un bel pezzo, e poi va avanti ancora con altre parole.";
  const [first, second] = new SentenceChunker({ commaAfter: 60, firstCommaAfter: 60, maxChars: 220 }).push(long + " Fine.");
  assert.equal(first, "Questa è una frase abbastanza lunga che continua per un bel pezzo,");
  assert.equal(second, "e poi va avanti ancora con altre parole.");
  // Short commas don't cut later sentences...
  assert.deepEqual(splitSentences("Ok. Allora, vediamo. Fine."), ["Ok.", "Allora, vediamo.", "Fine."]);
  // ...but the very first piece is cut early to start speaking sooner
  assert.deepEqual(splitSentences("Allora, guardando il tuo codice con attenzione, vedo un problema."), [
    "Allora, guardando il tuo codice con attenzione,",
    "vedo un problema.",
  ]);
});

test("text without punctuation is cut at a space before the hard limit", () => {
  const words = Array.from({ length: 80 }, (_, i) => `parola${i}`).join(" ");
  const pieces = splitSentences(words, { commaAfter: 60, firstCommaAfter: 28, maxChars: 100 });
  assert.ok(pieces.length >= 6);
  assert.ok(pieces.every((p) => p.length <= 101), JSON.stringify(pieces.map((p) => p.length)));
  assert.equal(pieces.join(" "), words);
});

test("streamed deltas give the same sentences, each as soon as it is complete", () => {
  const chunker = new SentenceChunker();
  const out: string[][] = [];
  for (const delta of ["Cia", "o! Sono ", "Lumi.", " Costa 3", ".", "50 euro", ". Tu", " come stai?"]) out.push(chunker.push(delta));
  // Each sentence comes out with the delta that brings the space after its punctuation
  assert.deepEqual(out, [[], ["Ciao!"], [], ["Sono Lumi."], [], [], ["Costa 3.50 euro."], []]);
  assert.deepEqual(chunker.flush(), ["Tu come stai?"]);
  // A dot at the very end waits for the next character
  const waiting = new SentenceChunker();
  assert.deepEqual(waiting.push("Vale 3."), []);
  assert.deepEqual(waiting.push("14 circa."), []);
  assert.deepEqual(waiting.flush(), ["Vale 3.14 circa."]);
});
