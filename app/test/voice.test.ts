// Voice output: sentences to the TTS in order, playback tracking, interruptions; the sidecar clients.
import assert from "node:assert/strict";
import test from "node:test";
import { muteConsole } from "../src/main/log";
import { restartDelay } from "../src/main/sidecar";
import type { SocketLike } from "../src/main/socket";
import { heardPart, VoiceSpeech, type VoiceOutput } from "../src/main/voice/speechOut";
import { SttClient } from "../src/main/voice/sttClient";
import { TtsClient, type SpeakRequest, type TtsHandlers } from "../src/main/voice/ttsClient";
import { sidecarConfig } from "../src/main/voice/voice";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

function fakeOutput() {
  const requests: SpeakRequest[] = [];
  const handlers = new Map<number, TtsHandlers>();
  const log: string[] = [];
  const out: VoiceOutput = {
    speak: (request, h) => {
      requests.push(request);
      handlers.set(request.id, h);
      return true;
    },
    cancel: (id) => log.push(`cancel ${id}`),
    begin: (msg) => log.push(`begin ${msg.id} ${msg.emotion}`),
    chunk: (id, pcm) => log.push(`chunk ${id} ${pcm.length}`),
    end: (id) => log.push(`end ${id}`),
    stop: (fadeMs) => log.push(`stop ${fadeMs}`),
  };
  return { out, requests, handlers, log };
}

function speech() {
  const f = fakeOutput();
  const started: string[] = [];
  const speaking: boolean[] = [];
  const fallbacks: string[] = [];
  let id = 1;
  const s = new VoiceSpeech(
    f.out,
    { sentenceStart: (x) => started.push(`${x.text}|${x.emotion}`), speaking: (a) => speaking.push(a), fallback: (t) => fallbacks.push(t) },
    () => id++,
    { volume: 0.8 },
  );
  return { s, ...f, started, speaking, fallbacks };
}

test("streamed say calls become sentences sent to the TTS as soon as they are complete", async () => {
  const t = speech();
  t.s.live([{ text: "Ciao! Oggi", emotion: "gioia", intensity: 0.8, complete: false }]);
  assert.deepEqual(
    t.requests.map((r) => [r.id, r.text, r.emotion, r.intensity]),
    [[1, "Ciao!", "gioia", 0.8]],
  );
  t.s.live([{ text: "Ciao! Oggi piove. Peccato", emotion: "gioia", intensity: 0.8, complete: false }]);
  assert.equal(t.requests.length, 2);
  t.s.final([
    { text: "Ciao! Oggi piove. Peccato.", emotion: "gioia", intensity: 0.8 },
    { text: "Usciamo domani?", emotion: "pensiero", intensity: 0.5 },
  ]);
  assert.deepEqual(
    t.requests.map((r) => `${r.text}|${r.emotion}`),
    ["Ciao!|gioia", "Oggi piove.|gioia", "Peccato.|gioia", "Usciamo domani?|pensiero"],
  );
  // Synthesis and playback complete in order
  for (const r of t.requests) {
    t.handlers.get(r.id)!.chunk(new Uint8Array(480), 24000);
    t.handlers.get(r.id)!.done({ cancelled: false, firstMs: 100, ms: 300, audioMs: 10 });
    t.s.playback({ id: r.id, type: "start" });
    t.s.playback({ id: r.id, type: "end", playedMs: 10, totalMs: 10, interrupted: false });
  }
  const heard = await t.s.done();
  assert.deepEqual(heard, { text: "Ciao! Oggi piove. Peccato. Usciamo domani?", interrupted: false });
  assert.deepEqual(t.started, ["Ciao!|gioia", "Oggi piove.|gioia", "Peccato.|gioia", "Usciamo domani?|pensiero"]);
  assert.deepEqual(t.speaking, [true, false]);
  assert.ok(t.log.includes("begin 4 pensiero") && t.log.includes("end 4"));
});

test("sentences wait for an emotion still being written", () => {
  const t = speech();
  t.s.live([{ text: "Allora. Vediamo", complete: false }]);
  assert.equal(t.requests.length, 0);
  t.s.live([{ text: "Allora. Vediamo", emotion: "pensiero", complete: false }]);
  assert.deepEqual(
    t.requests.map((r) => `${r.text}|${r.emotion}`),
    ["Allora.|pensiero"],
  );
});

test("streamed text that gets rewritten doesn't repeat or garble what was said", () => {
  const t = speech();
  t.s.live([{ text: "Ciao! Oggi", emotion: "gioia", complete: false }]);
  t.s.live([{ text: "Ciao! Domani piove", emotion: "gioia", complete: false }]);
  t.s.final([{ text: "Ciao! Domani piove.", emotion: "gioia", intensity: 0.6 }]);
  assert.deepEqual(
    t.requests.map((r) => r.text),
    ["Ciao!", "Domani piove."],
  );
});

test("an interruption keeps only what was heard", async () => {
  const t = speech();
  t.s.final([{ text: "Questa è la prima frase. Questa è la seconda frase, molto più lunga della prima.", emotion: "neutra", intensity: 0.6 }]);
  const [first, second] = t.requests;
  t.s.playback({ id: first.id, type: "start" });
  t.s.playback({ id: first.id, type: "end", playedMs: 900, totalMs: 900, interrupted: false });
  t.s.playback({ id: second.id, type: "start" });
  t.s.abort();
  assert.ok(t.log.includes("stop 80"));
  assert.ok(t.log.includes(`cancel ${second.id}`));
  t.s.playback({ id: second.id, type: "end", playedMs: 1000, totalMs: 3000, interrupted: true });
  const heard = await t.s.done();
  assert.equal(heard.interrupted, true);
  // A third of the second sentence was heard, cut at the last whole word
  assert.equal(heard.text, "Questa è la prima frase. Questa è la");
});

test("a sentence that can't be synthesized is shown as text", async () => {
  const t = speech();
  t.s.final([{ text: "Ciao.", emotion: "neutra", intensity: 0.6 }]);
  t.handlers.get(1)!.done({ cancelled: false, firstMs: null, ms: 0, audioMs: 0, error: "CUDA out of memory" });
  assert.deepEqual(t.fallbacks, ["Ciao."]);
  assert.deepEqual(await t.s.done(), { text: "Ciao.", interrupted: false });
});

test("heardPart cuts at a word boundary", () => {
  assert.equal(heardPart("uno due tre quattro", 500, 1000), "uno due");
  assert.equal(heardPart("uno due", 0, 1000), "");
  assert.equal(heardPart("uno due", 2000, 1000), "uno due");
  assert.equal(heardPart("unaparola", 500, 1000), "");
});

/** A WebSocket that records what is sent and lets the test answer. */
class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  text(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  frame(id: number, bytes: number[]) {
    const buf = new ArrayBuffer(4 + bytes.length);
    new DataView(buf).setUint32(0, id, true);
    new Uint8Array(buf, 4).set(bytes);
    this.onmessage?.({ data: buf });
  }
}

test("TtsClient: queues while connecting, routes frames by id, fails pending on disconnect", () => {
  let socket!: FakeSocket;
  const urls: string[] = [];
  const client = new TtsClient(
    () => "ws://127.0.0.1:1/tts?token=x",
    (url) => {
      urls.push(url);
      return (socket = new FakeSocket());
    },
  );
  const chunks: number[][] = [];
  const done: unknown[] = [];
  assert.equal(client.speak({ id: 3, text: "Ciao", emotion: "gioia", intensity: 0.73456 }, { chunk: (pcm, rate) => chunks.push([pcm.length, rate]), done: (d) => done.push(d) }), true);
  assert.equal(socket.sent.length, 0, "queued until open");
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0] as string), { type: "speak", id: 3, text: "Ciao", emotion: "gioia", intensity: 0.73 });
  assert.equal(socket.binaryType, "arraybuffer");
  socket.text({ id: 3, start: true, sampleRate: 22050 });
  socket.frame(3, [1, 2, 3, 4]);
  socket.frame(99, [1, 2]);
  socket.text({ id: 3, done: true, cancelled: false, firstMs: 120, ms: 500, audioMs: 900 });
  assert.deepEqual(chunks, [[4, 22050]]);
  assert.deepEqual(done, [{ cancelled: false, firstMs: 120, ms: 500, audioMs: 900 }]);
  const failed: { error?: string }[] = [];
  client.speak({ id: 4, text: "Di nuovo", emotion: "neutra", intensity: 0.5 }, { chunk: () => undefined, done: (d) => failed.push(d) });
  client.cancel("all");
  assert.deepEqual(JSON.parse(socket.sent[socket.sent.length - 1] as string), { cancel: "all" });
  socket.close();
  assert.equal(failed[0].error, "i motori della voce si sono fermati");
  assert.equal(urls.length, 1);
  // Without a sidecar nothing is sent
  const offline = new TtsClient(() => null);
  assert.equal(offline.speak({ id: 1, text: "x", emotion: "neutra", intensity: 0.5 }, { chunk: () => undefined, done: () => undefined }), false);
});

test("SttClient: frames carry the session id; partial and final results", () => {
  let socket!: FakeSocket;
  const client = new SttClient(() => "ws://x", () => (socket = new FakeSocket()));
  const events: string[] = [];
  client.start(7, { vocabulary: ["Lumi"], partials: true }, { partial: (t) => events.push(`p:${t}`), final: (r) => events.push(`f:${r.text}:${r.durationMs}`) });
  socket.open();
  client.audio(7, new Uint8Array([1, 0, 2, 0]));
  client.audio(8, new Uint8Array([9, 9]));
  client.end(7);
  assert.deepEqual(JSON.parse(socket.sent[0] as string), { type: "start", id: 7, vocabulary: ["Lumi"], partials: true });
  assert.deepEqual([...(socket.sent[1] as Uint8Array)], [7, 0, 0, 0, 1, 0, 2, 0]);
  assert.equal(socket.sent.length, 3, "no frame for an unknown session");
  socket.text({ id: 7, partial: "ciao" });
  socket.text({ id: 7, final: "ciao Lumi", words: [], durationMs: 1200, ms: 90 });
  assert.deepEqual(events, ["p:ciao", "f:ciao Lumi:1200"]);
});

test("restart delays grow and the sidecar gets the engines from the settings", () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(restartDelay), [1000, 2000, 4000, 8000, 60_000]);
  const config = sidecarConfig(DEFAULT_SETTINGS, true) as { tts: { engine: string; model: string }; stt: { engine: string }; uia: { enabled: boolean }; preload: boolean };
  assert.equal(config.tts.engine, "qwen3");
  assert.equal(config.tts.model, "1.7B-CustomVoice");
  assert.equal(config.stt.engine, "faster-whisper");
  assert.equal(config.uia.enabled, true);
  assert.equal(config.preload, true);
});
