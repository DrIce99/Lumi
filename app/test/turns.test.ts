// Turn-taking: push-to-talk, end of turn, wake word, barge-in, follow-up, echo.
import assert from "node:assert/strict";
import test from "node:test";
import { meaningless, requiredSilenceMs, trailingIncomplete, turnEnded } from "../src/main/voice/endpoint";
import { multipart, wav } from "../src/main/voice/groqStt";
import type { SttHandlers } from "../src/main/voice/sttClient";
import { isEcho, TurnManager, type Clock, type SttBackend, type TurnHost } from "../src/main/voice/turns";
import { distance, matchWakeWord } from "../src/main/voice/wakeWord";
import { DEFAULT_SETTINGS, type ListenMode, type MicControl, type Settings } from "../src/shared/types";

class FakeClock implements Clock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

class FakeStt implements SttBackend {
  partials = true;
  sessions = new Map<number, SttHandlers>();
  log: string[] = [];
  start(id: number, _o: unknown, handlers: SttHandlers) {
    this.sessions.set(id, handlers);
    this.log.push(`start ${id}`);
    return true;
  }
  audio(id: number, pcm: Uint8Array) {
    this.log.push(`audio ${id} ${pcm.byteLength}`);
  }
  end(id: number) {
    this.log.push(`end ${id}`);
  }
  cancel(id: number) {
    this.log.push(`cancel ${id}`);
    this.sessions.delete(id);
  }
  partial(id: number, text: string) {
    this.sessions.get(id)?.partial(text);
  }
  final(id: number, text: string) {
    this.sessions.get(id)?.final({ text, words: [], durationMs: 1000, ms: 50 });
  }
}

function setup(mode: ListenMode, extra: Partial<Settings["listen"]> = {}) {
  const clock = new FakeClock();
  const stt = new FakeStt();
  const settings: Settings = { ...DEFAULT_SETTINGS, listen: { ...DEFAULT_SETTINGS.listen, mode, ...extra } };
  const said: string[] = [];
  const controls: MicControl[] = [];
  const listening: boolean[] = [];
  let interrupts = 0;
  let speaking = false;
  let recent = "";
  const host: TurnHost = {
    settings: () => settings,
    stt: () => stt,
    micControl: (c) => controls.push(c),
    utterance: (text) => said.push(text),
    interrupt: () => interrupts++,
    speaking: () => speaking,
    setListening: (on) => listening.push(on),
    recentSpeech: () => recent,
  };
  const turns = new TurnManager(host, clock);
  return {
    clock,
    stt,
    turns,
    said,
    controls,
    listening,
    interrupts: () => interrupts,
    setSpeaking: (on: boolean) => {
      speaking = on;
      turns.speakingChanged(on);
    },
    setRecent: (text: string) => (recent = text),
    frame: () => turns.mic({ type: "frame", pcm: new ArrayBuffer(1024), speech: 0.9 }),
    lastControl: () => controls[controls.length - 1],
  };
}

test("push-to-talk streams while held and ends after a short tail", () => {
  const t = setup("push-to-talk");
  assert.equal(t.lastControl().enabled, false, "microphone off while idle");
  t.turns.pttDown();
  assert.deepEqual(
    [t.lastControl().enabled, t.lastControl().forceStream],
    [true, true],
  );
  assert.deepEqual(t.listening, [true]);
  t.frame();
  t.frame();
  t.turns.pttUp();
  assert.ok(!t.stt.log.includes("end 1"));
  t.clock.advance(200);
  assert.deepEqual(t.stt.log, ["start 1", "audio 1 1024", "audio 1 1024", "end 1"]);
  t.stt.final(1, "Ciao Lumi, che tempo fa?");
  assert.deepEqual(t.said, ["Ciao Lumi, che tempo fa?"]);
  assert.equal(t.listening[t.listening.length - 1], false);
  assert.equal(t.lastControl().enabled, false);
});

test("pressing push-to-talk while Lumi talks interrupts it", () => {
  const t = setup("push-to-talk");
  t.setSpeaking(true);
  assert.equal(t.lastControl().strict, true, "barge-in listening is strict while Lumi talks");
  t.turns.pttDown();
  assert.equal(t.interrupts(), 1);
});

test("continuous listening: the turn ends after 500 ms of silence when the sentence is complete", () => {
  const t = setup("continuous");
  assert.deepEqual([t.lastControl().enabled, t.lastControl().autoStream], [true, true]);
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.frame();
  t.stt.partial(1, "Apri il file di configurazione.");
  t.turns.mic({ type: "speech-end", durationMs: 1800 });
  // The VAD reports the end after 300 ms of silence: 200 ms more are needed
  t.clock.advance(150);
  assert.ok(!t.stt.log.includes("end 1"));
  t.clock.advance(100);
  assert.ok(t.stt.log.includes("end 1"));
  t.stt.final(1, "Apri il file di configurazione.");
  assert.deepEqual(t.said, ["Apri il file di configurazione."]);
});

test("an unfinished sentence waits up to 1.2 s, and resumed speech continues the same turn", () => {
  const t = setup("continuous");
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.stt.partial(1, "Volevo chiederti se");
  t.turns.mic({ type: "speech-end", durationMs: 1500 });
  t.clock.advance(400);
  assert.ok(!t.stt.log.includes("end 1"), "not after 700 ms of silence");
  // The user goes on: same session
  t.turns.mic({ type: "speech-start" });
  t.frame();
  t.clock.advance(2000);
  assert.ok(!t.stt.log.includes("end 1"), "never while speaking");
  t.stt.partial(1, "Volevo chiederti se domani piove");
  t.turns.mic({ type: "speech-end", durationMs: 900 });
  t.clock.advance(250);
  assert.ok(t.stt.log.includes("end 1"));
  assert.equal(t.stt.log.filter((l) => l.startsWith("start")).length, 1);
});

test("wake word: only addressed utterances reach Lumi; the name alone opens a short window", () => {
  const t = setup("wake-word");
  // Not for Lumi
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.turns.mic({ type: "speech-end", durationMs: 800 });
  t.clock.advance(300);
  t.stt.final(1, "Passami il caffè.");
  assert.deepEqual(t.said, []);
  assert.deepEqual(t.listening, [], "the face doesn't listen to others");
  // Name and request together
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.stt.partial(2, "Ehi Lumi, che ore");
  assert.deepEqual(t.listening, [true], "listening as soon as the name is heard");
  t.turns.mic({ type: "speech-end", durationMs: 1200 });
  t.clock.advance(300);
  t.stt.final(2, "Ehi Lumi, che ore sono?");
  assert.deepEqual(t.said, ["che ore sono?"]);
  // The name alone, then the request without the name
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.turns.mic({ type: "speech-end", durationMs: 500 });
  t.clock.advance(300);
  t.stt.final(3, "Ehi Lumi.");
  t.clock.advance(1000);
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.turns.mic({ type: "speech-end", durationMs: 900 });
  t.clock.advance(300);
  t.stt.final(4, "Metti un timer.");
  assert.deepEqual(t.said, ["che ore sono?", "Metti un timer."]);
});

test("barge-in: confirmed speech over Lumi stops it, a misfire doesn't", () => {
  const t = setup("push-to-talk");
  t.setSpeaking(true);
  assert.deepEqual([t.lastControl().enabled, t.lastControl().autoStream, t.lastControl().strict], [true, true, true]);
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "misfire" });
  assert.equal(t.interrupts(), 0);
  assert.ok(t.stt.log.includes("cancel 1"));
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  assert.equal(t.interrupts(), 1);
  t.setSpeaking(false);
  t.turns.mic({ type: "speech-end", durationMs: 700 });
  t.clock.advance(300);
  t.stt.final(2, "Aspetta, intendevo un'altra cosa.");
  assert.deepEqual(t.said, ["Aspetta, intendevo un'altra cosa."]);
});

test("after an answer Lumi keeps listening for the follow-up seconds", () => {
  const t = setup("push-to-talk", { followUpSeconds: 8 });
  t.setSpeaking(true);
  t.setSpeaking(false);
  assert.deepEqual([t.lastControl().enabled, t.lastControl().autoStream, t.lastControl().strict], [true, true, false]);
  t.clock.advance(9000);
  assert.equal(t.lastControl().enabled, false, "window over");
  t.setSpeaking(true);
  t.setSpeaking(false);
  t.clock.advance(2000);
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.turns.mic({ type: "speech-end", durationMs: 600 });
  t.clock.advance(300);
  t.stt.final(1, "E domani?");
  assert.deepEqual(t.said, ["E domani?"]);
});

test("Lumi's own voice coming back is ignored, and so are noises", () => {
  const t = setup("continuous");
  t.setRecent("Oggi a Milano ci sono ventidue gradi e un bel sole.");
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.turns.mic({ type: "speech-end", durationMs: 2000 });
  t.clock.advance(300);
  t.stt.final(1, "ci sono ventidue gradi e un bel sole");
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.turns.mic({ type: "speech-end", durationMs: 300 });
  t.clock.advance(300);
  t.stt.final(2, "Mmh.");
  assert.deepEqual(t.said, []);
  assert.equal(isEcho("Che ore sono adesso?", "Sono le tre."), false);
});

test("end-of-turn heuristics and Smart Turn probabilities", () => {
  assert.equal(trailingIncomplete("Apri il file."), false);
  assert.equal(trailingIncomplete("Apri il file e"), true);
  assert.equal(trailingIncomplete("Volevo chiederti, ehm"), true);
  assert.equal(trailingIncomplete("Allora,"), true);
  assert.equal(trailingIncomplete("Aspetta..."), true);
  assert.equal(trailingIncomplete(null), false);
  assert.equal(requiredSilenceMs("Che ore sono?", null), 500);
  assert.equal(requiredSilenceMs("Che ore sono e", null), 1200);
  assert.equal(requiredSilenceMs("Che ore sono", 0.9), 500);
  assert.equal(requiredSilenceMs("Che ore sono", 0.1), 1200);
  assert.equal(requiredSilenceMs("Che ore sono", 0.5), 850);
  assert.equal(requiredSilenceMs("Che ore sono?", 0.03), 850, "final punctuation tempers a pessimistic model");
  assert.equal(requiredSilenceMs("Aspetta...", 0.9), 1200);
  assert.equal(requiredSilenceMs("Che ore sono e", 0.95), 1200, "an unfinished last word wins over the model");
  assert.equal(turnEnded(600, "Ok.", null), true);
  assert.equal(turnEnded(600, "Ok ma", null), false);
  assert.equal(meaningless("Mmh."), true);
  assert.equal(meaningless("Eh, ok"), true);
  assert.equal(meaningless("Ok, apri il file"), false);
});

test("wake word matching is fuzzy but anchored at the start", () => {
  assert.equal(distance("lumi", "lume"), 1);
  assert.deepEqual(matchWakeWord("Ehi Lumi, che ore sono?", "ehi lumi"), { matched: true, rest: "che ore sono?" });
  assert.deepEqual(matchWakeWord("Hey Lumì apri la posta", "ehi lumi"), { matched: true, rest: "apri la posta" });
  assert.deepEqual(matchWakeWord("Lume, accendi", "ehi lumi"), { matched: true, rest: "accendi" });
  assert.deepEqual(matchWakeWord("Ok Lumi.", "ehi lumi"), { matched: true, rest: "" });
  assert.equal(matchWakeWord("Il lume della candela", "ehi lumi").matched, false, "not after other words");
  assert.equal(matchWakeWord("Passami il caffè", "ehi lumi").matched, false);
});

test("Groq gets a WAV file in a multipart body", () => {
  const pcm = new Uint8Array([1, 0, 2, 0]);
  const file = wav(pcm);
  assert.equal(file.byteLength, 48);
  assert.equal(new TextDecoder().decode(file.slice(0, 4)), "RIFF");
  assert.equal(new DataView(file.buffer).getUint32(24, true), 16000);
  const { body, contentType } = multipart({ model: "whisper-large-v3-turbo", language: "it" }, { name: "audio.wav", type: "audio/wav", data: file });
  const text = new TextDecoder("latin1").decode(body);
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.match(text, /name="model"\r\n\r\nwhisper-large-v3-turbo/);
  assert.match(text, /filename="audio.wav"\r\nContent-Type: audio\/wav/);
});
