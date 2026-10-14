// Local vision: the reply format, regions on screen, the clients, and the look_at_screen chain.
import assert from "node:assert/strict";
import test from "node:test";
import type { Display } from "electron";
import { muteConsole } from "../src/main/log";
import { askVision, describeForBrain, listVisionModels, parseVisionReply, regionRect, visionPrompt, type VisionClientOptions } from "../src/main/perception/vision";
import { lookArea, Screenshots, type ScreenshotHost } from "../src/main/screenshots";
import type { Vision } from "../src/main/vision";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";

muteConsole();

test("the vision reply is read from JSON, even fenced or with text around; plain text becomes the description", () => {
  const reply = parseVisionReply(
    'Ecco:\n```json\n{"description": "Un editor con un errore.", "texts": ["TypeError", 3, ""], "regions": [{"label": "errore", "box": [100, 200, 600, 260]}, {"label": "storta", "box": [500, 10, 400, 20]}, {"label": "", "box": [1, 2, 3, 4]}, {"label": "grafico", "bbox_2d": [0, 0, 1200, 500]}]}\n```',
  );
  assert.equal(reply.description, "Un editor con un errore.");
  assert.deepEqual(reply.texts, ["TypeError"]);
  assert.deepEqual(reply.regions, [
    { label: "errore", box: [100, 200, 600, 260] },
    { label: "grafico", box: [0, 0, 1000, 500] },
  ]);
  assert.deepEqual(parseVisionReply("Vedo una pagina bianca."), { description: "Vedo una pagina bianca.", texts: [], regions: [] });
});

test("regions map from 0-1000 to the captured rectangle; the brain reads text only", () => {
  const area = { x: 1920, y: 100, width: 1000, height: 500 };
  assert.deepEqual(regionRect({ label: "x", box: [100, 200, 600, 260] }, area), { x: 2020, y: 200, width: 500, height: 30 });
  const text = describeForBrain({ description: "Un editor.", texts: ["TypeError"], regions: [{ label: "errore", box: [0, 0, 10, 10] }] }, "screen 1");
  assert.equal(text, "What you see on screen 1: Un editor.\nText there: «TypeError»\nThings you can look at (look_at with their name): errore");
  assert.match(visionPrompt("cosa c'è?", ["riga 1", "riga 2"]), /Request: cosa c'è\?\n\nText read by OCR[^\n]*\nriga 1\nriga 2/);
});

test("a small active window is captured alone, a big one with its whole display", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(lookArea({ x: 100, y: 100, width: 800, height: 600 }, display), { x: 100, y: 100, width: 800, height: 600 });
  assert.equal(lookArea({ x: -8, y: -8, width: 1936, height: 1056 }, display), null, "maximized");
  assert.deepEqual(lookArea({ x: 1500, y: 900, width: 800, height: 600 }, display), { x: 1500, y: 900, width: 420, height: 180 }, "clipped to the display");
  assert.equal(lookArea({ x: 1800, y: 1000, width: 800, height: 600 }, display), null, "too little of it on screen");
});

function fakeFetch(handler: (url: string, body: Record<string, unknown> | null) => { status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const r = handler(url, body);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  return { fetch, calls };
}

test("Ollama gets the image, JSON format and the short keep-alive; OpenAI-compatible servers get a data URL", async () => {
  const ollama = fakeFetch(() => ({ json: { message: { content: '{"description":"ok","texts":[],"regions":[]}' } } }));
  const options: VisionClientOptions = { provider: "ollama", url: "http://127.0.0.1:11434/", model: "qwen3-vl:8b", keepAlive: "2m", fetch: ollama.fetch };
  assert.equal((await askVision(options, "QUJD", "Request: x")).description, "ok");
  const sent = ollama.calls[0];
  assert.equal(sent.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(sent.body?.keep_alive, "2m");
  assert.equal(sent.body?.format, "json");
  assert.deepEqual((sent.body?.messages as { images?: string[] }[])[1].images, ["QUJD"]);

  const lm = fakeFetch(() => ({ json: { choices: [{ message: { content: '{"description":"lm"}' } }] } }));
  const result = await askVision({ ...options, provider: "custom", url: "http://localhost:1234/v1", fetch: lm.fetch }, "QUJD", "x");
  assert.equal(result.description, "lm");
  assert.equal(lm.calls[0].url, "http://localhost:1234/v1/chat/completions");
  assert.match(JSON.stringify(lm.calls[0].body), /data:image\/jpeg;base64,QUJD/);

  const missing = fakeFetch(() => ({ status: 404, text: '{"error":"model \\"qwen3-vl:8b\\" not found, try pulling it first"}' }));
  await assert.rejects(askVision({ ...options, fetch: missing.fetch }, "QUJD", "x"), (err: { kind?: string }) => err.kind === "missing");
});

test("only Ollama models with the vision capability are listed", async () => {
  const f = fakeFetch((url, body) => {
    if (url.endsWith("/api/tags")) return { json: { models: [{ name: "qwen3:8b" }, { name: "qwen3-vl:8b" }, { name: "gemma3:4b" }] } };
    const vision = body?.model === "qwen3-vl:8b" || body?.model === "gemma3:4b";
    return { json: { capabilities: vision ? ["completion", "vision"] : ["completion", "tools"] } };
  });
  assert.deepEqual(await listVisionModels("http://127.0.0.1:11434", f.fetch), ["qwen3-vl:8b", "gemma3:4b"]);
});

function chain(options: { local?: boolean; localReply?: () => Promise<Response>; policy?: Settings["perception"]["sendScreenshots"]; remote?: boolean; paused?: string }) {
  const settings: Settings = { ...DEFAULT_SETTINGS, perception: { ...DEFAULT_SETTINGS.perception, sendScreenshots: options.policy ?? "never" } };
  const log: string[] = [];
  const seen: string[] = [];
  const problems: string[] = [];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } } as Display;
  const host: ScreenshotHost = {
    settings: () => settings,
    paused: () => options.paused ?? null,
    localVision: () =>
      options.local
        ? { provider: "ollama", url: "http://ollama", model: "qwen3-vl:8b", keepAlive: "2m", fetch: async () => (options.localReply ? options.localReply() : new Response("{}")) }
        : null,
    remoteModel: () =>
      options.remote
        ? {
            provider: {
              id: "gemini",
              complete: async () => {
                log.push("remote complete");
                return { text: "descritto online", usage: null, model: "m" };
              },
            } as unknown as NonNullable<ReturnType<ScreenshotHost["remoteModel"]>>["provider"],
            model: "m",
            separate: true,
          }
        : null,
    ask: async () => {
      log.push("asked");
      return true;
    },
    area: () => ({ display, rect: display.bounds, label: "screen 1" }),
    ocr: async () => ["riga letta"],
    seen: (regions) => seen.push(...regions.map((r) => `${r.label}@${r.rect.x},${r.rect.y}`)),
    visionProblem: (m) => problems.push(m),
    setLooking: () => undefined,
  };
  const vision = { sinceLastLook: () => null, capture: async () => [{ label: "screen 1", jpegBase64: "QUJD", width: 1344, height: 756, unchanged: false }] } as unknown as Vision;
  return { s: new Screenshots(host, vision), log, seen, problems };
}

test("look_at_screen: the local model's description and regions, nothing sent online", async () => {
  const t = chain({ local: true, remote: true, policy: "always", localReply: async () => Response.json({ message: { content: '{"description":"Un grafico.","regions":[{"label":"picco","box":[500,500,600,600]}]}' } }) });
  const result = await t.s.look(undefined, true);
  assert.deepEqual(result.images, []);
  assert.match(result.notes[0], /^What you see on screen 1: Un grafico\./);
  assert.deepEqual(t.seen, ["picco@960,540"]);
  assert.deepEqual(t.log, [], "the online model is not used");
});

test("look_at_screen without a working local model: never = OCR text only, ask = a question first; paused = nothing", async () => {
  const missing = chain({ local: true, remote: true, policy: "never", localReply: async () => new Response("model not found", { status: 404 }) });
  const result = await missing.s.look(undefined, true);
  assert.match(result.notes[0], /doesn't allow screenshots online\. Text the local OCR reads on screen 1:\nriga letta/);
  assert.equal(missing.problems.length, 1);
  assert.match(missing.problems[0], /ollama pull qwen3-vl:8b/);
  assert.deepEqual(missing.log, []);

  const ask = chain({ remote: true, policy: "ask" });
  assert.match((await ask.s.look(undefined, true)).notes[0], /descritto online/);
  assert.deepEqual(ask.log, ["asked", "remote complete"]);

  const paused = chain({ local: true, paused: "the screen is locked" });
  assert.match((await paused.s.look(undefined, true)).notes[0], /can't look at the screen now: the screen is locked/);
});

test("an attached image is described locally first", async () => {
  const t = chain({ local: true, remote: true, policy: "always", localReply: async () => Response.json({ message: { content: '{"description":"Un gatto.","texts":["MIAO"]}' } }) });
  assert.equal(await t.s.describeImage("gatto.png", "QUJD", "cos'è?"), "What you see on the attached image: Un gatto.\nText there: «MIAO»");
  const off = chain({ remote: true, policy: "never" });
  assert.match(await off.s.describeImage("gatto.png", "QUJD", ""), /no local vision model/);
});
