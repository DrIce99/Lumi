// Turn-taking: push-to-talk, end of turn, wake word, barge-in, follow-up, echo.
import assert from "node:assert/strict";
import test from "node:test";
import { meaningless, requiredSilenceMs, trailingIncomplete, turnEnded } from "../src/main/voice/endpoint";
import { multipart, wav } from "../src/main/voice/groqStt";
import type { SttHandlers } from "../src/main/voice/sttClient";
import { cleanTranscript, isSilence } from "../src/main/voice/sttFilter";
import { isEcho, TurnManager, type Clock, type SttBackend, type TurnHost, type WakeBackend } from "../src/main/voice/turns";
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

function setup(mode: ListenMode, extra: Partial<Settings["listen"]> = {}, inCall = () => false, wake?: { backend: WakeBackend | null; allowed?: () => boolean }) {
  const clock = new FakeClock();
  const stt = new FakeStt();
  const settings: Settings = { ...DEFAULT_SETTINGS, listen: { ...DEFAULT_SETTINGS.listen, mode, ...extra } };
  const said: string[] = [];
  const opened: (string | undefined)[] = [];
  const controls: MicControl[] = [];
  const listening: boolean[] = [];
  let interrupts = 0;
  let speaking = false;
  let recent = "";
  const host: TurnHost = {
    settings: () => settings,
    stt: () => stt,
    micControl: (c) => controls.push(c),
    utterance: (text, _print, how) => {
      said.push(text);
      opened.push(how);
    },
    interrupt: () => interrupts++,
    speaking: () => speaking,
    setListening: (on) => listening.push(on),
    recentSpeech: () => recent,
    inCall,
    ...(wake ? { wake: () => wake.backend, wakeAllowed: wake.allowed ?? (() => true) } : {}),
  };
  const turns = new TurnManager(host, clock);
  return {
    clock,
    stt,
    turns,
    said,
    opened,
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

test("continuous listening: the turn ends after the pause (here 500 ms) when the sentence is complete", () => {
  const t = setup("continuous", { pauseMs: 500 });
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

test("by default Lumi waits a full second of silence before answering", () => {
  const t = setup("continuous");
  t.turns.mic({ type: "speech-start" });
  t.turns.mic({ type: "speech-confirmed" });
  t.frame();
  t.stt.partial(1, "Apri il file di configurazione.");
  t.turns.mic({ type: "speech-end", durationMs: 1800 });
  // The VAD already waited 300 ms: 700 ms more
  t.clock.advance(650);
  assert.ok(!t.stt.log.includes("end 1"));
  t.clock.advance(100);
  assert.ok(t.stt.log.includes("end 1"));
});

test("an unfinished sentence waits longer (1.2 s for a 500 ms pause), and resumed speech continues the same turn", () => {
  const t = setup("continuous", { pauseMs: 500 });
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
  assert.equal(requiredSilenceMs("Che ore sono?", null, 500), 500);
  assert.equal(requiredSilenceMs("Che ore sono e", null, 500), 1200);
  assert.equal(requiredSilenceMs("Che ore sono", 0.9, 500), 500);
  assert.equal(requiredSilenceMs("Che ore sono", 0.1, 500), 1200);
  assert.equal(requiredSilenceMs("Che ore sono", 0.5, 500), 850);
  assert.equal(requiredSilenceMs("Che ore sono?", 0.03, 500), 850, "final punctuation tempers a pessimistic model");
  assert.equal(requiredSilenceMs("Aspetta...", 0.9, 500), 1200);
  assert.equal(requiredSilenceMs("Che ore sono e", 0.95, 500), 1200, "an unfinished last word wins over the model");
  assert.equal(turnEnded(600, "Ok.", null, 500), true);
  assert.equal(turnEnded(600, "Ok ma", null, 500), false);
  // The default pause is longer, and grows the same way when the sentence sounds unfinished
  assert.equal(requiredSilenceMs("Che ore sono?", null), 1000);
  assert.equal(requiredSilenceMs("Che ore sono e", null), 2400);
  assert.equal(requiredSilenceMs("Che ore sono e", null, 2500), 4000, "never more than 4 s");
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

test("during a call, continuous listening waits for the wake word (the user is talking to friends)", () => {
  let call = true;
  const t = setup("continuous", { pauseMs: 500 }, () => call);
  const say = (id: number, text: string) => {
    t.turns.mic({ type: "speech-start" });
    t.turns.mic({ type: "speech-confirmed" });
    t.frame();
    t.stt.partial(id, text);
    t.turns.mic({ type: "speech-end", durationMs: 1500 });
    t.clock.advance(2000);
    t.stt.final(id, text);
  };
  say(1, "Dai ragazzi, entriamo nella partita.");
  assert.deepEqual(t.said, [], "said to the friends");
  say(2, "Ehi Lumi, che ore sono?");
  assert.deepEqual(t.said, ["che ore sono?"]);
  call = false;
  say(3, "Apri il file di configurazione.");
  assert.equal(t.said[t.said.length - 1], "Apri il file di configurazione.", "after the call, continuous again");
});

function fakeWake() {
  const log: string[] = [];
  const backend: WakeBackend = {
    reset: () => log.push("reset"),
    audio: (pcm) => log.push(`audio ${pcm.byteLength}`),
  };
  return { backend, log };
}

test("wake word detector: nothing is transcribed until the name; then the last 1.5 s and the rest go to the recognizer", () => {
  const w = fakeWake();
  const t = setup("wake-word", {}, () => false, { backend: w.backend });
  assert.equal(t.lastControl().autoStream, true, "speech is streamed, for the detector");
  t.turns.mic({ type: "speech-start" });
  for (let i = 0; i < 3; i++) t.frame();
  assert.deepEqual(t.stt.log, [], "no speech recognition before the name");
  assert.deepEqual(w.log, ["reset", "audio 1024", "audio 1024", "audio 1024"]);
  // One frame above the threshold is not enough
  t.turns.wakeScores([0.1, 0.7, 0.2]);
  assert.deepEqual(t.stt.log, []);
  t.turns.wakeScores([0.6, 0.8]);
  assert.deepEqual(t.stt.log, ["start 1", "audio 1 1024", "audio 1 1024", "audio 1 1024"], "the buffered speech comes first");
  assert.deepEqual(t.listening, [true]);
  t.frame();
  assert.equal(t.stt.log.at(-1), "audio 1 1024", "then the live speech");
  t.turns.mic({ type: "speech-end", durationMs: 2000 });
  t.clock.advance(1500);
  t.stt.final(1, "Ehi Lumi, che ore sono?");
  assert.deepEqual(t.said, ["che ore sono?"]);
});

test("wake word detector: speech without the name is dropped; the name alone waits 5 s for the request", () => {
  const w = fakeWake();
  const t = setup("wake-word", {}, () => false, { backend: w.backend });
  t.turns.mic({ type: "speech-start" });
  t.frame();
  t.turns.wakeScores([0.1, 0.2]);
  t.turns.mic({ type: "speech-end", durationMs: 800 });
  t.clock.advance(1000);
  t.turns.wakeScores([0.9, 0.9]);
  assert.deepEqual(t.stt.log, [], "a late score after the segment was dropped doesn't open anything");

  t.turns.mic({ type: "speech-start" });
  t.frame();
  t.turns.mic({ type: "speech-end", durationMs: 600 });
  // The scores of the last frames arrive just after the end of the segment
  t.turns.wakeScores([0.9, 0.95]);
  assert.equal(t.stt.log[0], "start 1");
  t.clock.advance(1500);
  assert.ok(t.stt.log.join("|").includes("end 1"), "the turn ends after the pause");
  t.stt.final(1, "Lumi");
  assert.deepEqual(t.said, []);
  t.turns.mic({ type: "speech-start" });
  t.frame();
  assert.ok(t.stt.log.join("|").includes("start 2"), "within the window the request is transcribed without the name");
  t.clock.advance(6000);
});

test("wake word detector: a higher threshold while Lumi talks, which the name interrupts; asleep when locked or in another app's call", () => {
  const w = fakeWake();
  let allowed = true;
  const t = setup("wake-word", { bargeIn: false }, () => false, { backend: w.backend, allowed: () => allowed });
  t.setSpeaking(true);
  t.turns.mic({ type: "speech-start" });
  t.frame();
  t.turns.wakeScores([0.6, 0.6]);
  assert.deepEqual(t.stt.log, [], "0.6 is below 0.5 x 1.3");
  t.turns.wakeScores([0.7, 0.7]);
  assert.equal(t.interrupts(), 1);
  assert.equal(t.stt.log[0], "start 1");

  const u = setup("wake-word", {}, () => false, { backend: fakeWake().backend, allowed: () => allowed });
  allowed = false;
  u.turns.refresh();
  assert.equal(u.lastControl().enabled, false, "the microphone closes");
  u.turns.mic({ type: "speech-start" });
  u.frame();
  u.turns.wakeScores([0.9, 0.9]);
  assert.deepEqual(u.stt.log, []);
});

test("without the wake word detector the name is still spotted in transcripts", () => {
  const t = setup("wake-word", {}, () => false, { backend: null });
  t.turns.mic({ type: "speech-start" });
  assert.equal(t.stt.log[0], "start 1", "every utterance is transcribed");
});

test("remote speech recognition drops silence and Whisper's hallucinations", () => {
  const tone = (amplitude: number) => {
    const pcm = new Uint8Array(3200);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round(amplitude * 32767 * Math.sin(i / 5)), true);
    return pcm;
  };
  assert.equal(isSilence(new Uint8Array(0)), true);
  assert.equal(isSilence(tone(0.001)), true);
  assert.equal(isSilence(tone(0.1)), false);
  assert.equal(cleanTranscript("Sottotitoli creati dalla comunità Amara.org", 3), "");
  assert.equal(cleanTranscript(" Grazie a tutti! ", 2), "");
  assert.equal(cleanTranscript("Grazie.", 0.4), "");
  assert.equal(cleanTranscript("Grazie.", 1.2), "Grazie.", "a real thank-you is long enough");
  assert.equal(cleanTranscript("Che  ore sono?", 1.5), "Che ore sono?");
});

test("every utterance says how its turn was opened: the key, the name, open listening, the window after an answer", () => {
  // Open listening: nobody invited this sentence
  const open = setup("continuous", { pauseMs: 500 });
  open.turns.mic({ type: "speech-start" });
  open.turns.mic({ type: "speech-confirmed" });
  open.turns.mic({ type: "speech-end", durationMs: 600 });
  open.clock.advance(300);
  open.stt.final(1, "Passami il caffè");
  assert.deepEqual(open.opened, ["open"]);

  // Right after Lumi spoke: a follow-up
  const follow = setup("continuous", { pauseMs: 500, followUpSeconds: 8 });
  follow.setSpeaking(true);
  follow.setSpeaking(false);
  follow.clock.advance(2000);
  follow.turns.mic({ type: "speech-start" });
  follow.turns.mic({ type: "speech-confirmed" });
  follow.turns.mic({ type: "speech-end", durationMs: 600 });
  follow.clock.advance(300);
  follow.stt.final(1, "E domani?");
  assert.deepEqual(follow.opened, ["followup"]);

  // The key
  const ptt = setup("continuous");
  ptt.turns.pttDown();
  ptt.frame();
  ptt.turns.pttUp();
  ptt.clock.advance(200);
  ptt.stt.final(1, "Che ore sono?");
  assert.deepEqual(ptt.opened, ["ptt"]);

  // The name in the transcript (no detector): the request after it is the name's
  const named = setup("wake-word");
  named.turns.mic({ type: "speech-start" });
  named.turns.mic({ type: "speech-confirmed" });
  named.turns.mic({ type: "speech-end", durationMs: 800 });
  named.clock.advance(300);
  named.stt.final(1, "Ehi Lumi, che ore sono?");
  assert.deepEqual(named.said, ["che ore sono?"]);
  assert.deepEqual(named.opened, ["name"]);

  // The name alone, then the request: an invitation
  named.turns.mic({ type: "speech-start" });
  named.turns.mic({ type: "speech-confirmed" });
  named.turns.mic({ type: "speech-end", durationMs: 500 });
  named.clock.advance(300);
  named.stt.final(2, "Ehi Lumi.");
  named.clock.advance(1000);
  named.turns.mic({ type: "speech-start" });
  named.turns.mic({ type: "speech-confirmed" });
  named.turns.mic({ type: "speech-end", durationMs: 700 });
  named.clock.advance(300);
  named.stt.final(3, "quanto fa due più due");
  assert.deepEqual(named.opened, ["name", "name"]);
});
