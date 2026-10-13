// The brain with Ollama and OpenAI-compatible services, with fetch replaced
// by fakes that answer like the real APIs.
import assert from "node:assert/strict";
import test from "node:test";
import { Brain, type BrainHost, type SayCall, type SpeechSink } from "../src/main/brain/brain";
import { Memory } from "../src/main/brain/memory";
import { buildContext, buildSystemPrompt } from "../src/main/brain/prompt";
import { CompatProvider } from "../src/main/brain/providers/compat";
import { OllamaTransport } from "../src/main/brain/providers/ollama";
import { OpenAITransport } from "../src/main/brain/providers/openai";
import { liveSayFrom, parseJsonReply, partialStringField, stripThinking } from "../src/main/brain/providers/text";
import { readTextCalls, stripMarkup } from "../src/main/brain/providers/textCalls";
import type { ChatProvider, LiveSay } from "../src/main/brain/providers/types";
import { muteConsole } from "../src/main/log";
import { DEFAULT_SETTINGS } from "../src/shared/types";

muteConsole();

interface Captured {
  url: string;
  body: Record<string, unknown> & { messages: Record<string, unknown>[] };
}

/** Replaces fetch for the duration of `fn`. */
async function withFetch(reply: (request: Captured, n: number) => Response | Promise<Response>, fn: (requests: Captured[]) => Promise<void>) {
  const original = globalThis.fetch;
  const requests: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : { messages: [] } };
    requests.push(request);
    return reply(request, requests.length);
  }) as typeof fetch;
  try {
    await fn(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const toolDelta = (index: number, fields: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [{ index, ...fields }] } }] });

function host(provider: ChatProvider, model: string) {
  const live: LiveSay[][] = [];
  const finals: SayCall[][] = [];
  const said: string[] = [];
  const looks: (string | undefined)[] = [];
  const lookAts: { text?: string; region?: string }[] = [];
  const quiets: (number | undefined)[] = [];
  let aborted = 0;
  const h: BrainHost = {
    settings: () => DEFAULT_SETTINGS,
    memory: new Memory(null),
    provider: () => ({ provider, model }),
    situation: () => ({
      now: new Date(),
      activity: { idleSec: 1, away: false, locked: false, sessionMinutes: 10, awayMinutes: 0 },
      voice: true,
      screen: "App: Visual Studio Code - main.ts",
      vision: "always",
    }),
    startSpeech: (): SpeechSink => {
      let final: SayCall[] = [];
      let resolve!: (v: { text: string; interrupted: boolean }) => void;
      const heard = new Promise<{ text: string; interrupted: boolean }>((r) => (resolve = r));
      return {
        live: (says) => live.push(says.map((s) => ({ ...s }))),
        final: (says) => {
          final = says;
          finals.push(says);
          resolve({ text: final.map((s) => s.text).join(" "), interrupted: false });
        },
        done: () => heard,
        abort: () => {
          aborted++;
        },
      };
    },
    say: (text) => said.push(text),
    setThinking: () => undefined,
    lookAt: (target) => {
      lookAts.push(target);
      return "Looking at it.";
    },
    lookAtScreen: async (focus) => {
      looks.push(focus);
      return { notes: [], images: [{ label: "Screen 1, 1280x720", jpegBase64: "QUJD" }] };
    },
    quiet: (minutes) => quiets.push(minutes),
    backOff: () => undefined,
  };
  return { h, live, finals, said, looks, lookAts, quiets, aborted: () => aborted };
}

test("OpenAI-compatible: say streams emotion before text, then the screenshot follow-up", async () => {
  const provider = new CompatProvider("groq", new OpenAITransport("https://api.example/v1", "gsk-test", "Groq"));
  const t = host(provider, "llama-test");
  await withFetch(
    (_request, n) =>
      n === 1
        ? sse([
            toolDelta(0, { id: "call_a", function: { name: "look_at_screen", arguments: "" } }),
            toolDelta(0, { function: { arguments: '{"focus": "errore"}' } }),
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        : sse([
            toolDelta(0, { id: "call_b", function: { name: "say", arguments: '{"emotion": "sorpresa", "intensity": 0.8, "look": "riga 3", "text": "Vedo' } }),
            toolDelta(0, { function: { arguments: " un errore" } }),
            toolDelta(0, { function: { arguments: ' alla riga 3!"}' } }),
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 40 } },
          ]),
    async (requests) => {
      await new Brain(t.h).handle({ kind: "message", text: "guarda qui", via: "voice" });
      assert.equal(requests.length, 2);
      assert.equal(requests[0].url, "https://api.example/v1/chat/completions");
      const tools = requests[0].body.tools as { function: { name: string; parameters: Record<string, unknown> } }[];
      assert.equal(tools[0].function.name, "say");
      assert.ok(tools.every((tool) => !JSON.stringify(tool.function.parameters).includes("additionalProperties")));
      const sayProps = Object.keys((tools[0].function.parameters as { properties: Record<string, unknown> }).properties);
      assert.ok(sayProps.indexOf("emotion") < sayProps.indexOf("text"), "emotion is asked before text");
      const second = requests[1].body.messages;
      assert.equal(second[2].role, "assistant");
      assert.deepEqual(second[3], { role: "tool", tool_call_id: "call_a", content: "Done." });
      const image = (second[4].content as { type: string; image_url?: { url: string } }[]).find((c) => c.type === "image_url");
      assert.equal(image?.image_url?.url, "data:image/jpeg;base64,QUJD");
    },
  );
  assert.deepEqual(t.looks, ["errore"]);
  // The emotion is known before the first words, and the text grows
  const firstLive = t.live.find((says) => says[0]?.text);
  assert.equal(firstLive?.[0].emotion, "sorpresa");
  assert.equal(firstLive?.[0].look, "riga 3");
  assert.ok(t.live.filter((s) => s.length).length >= 3, "speech arrives progressively");
  assert.deepEqual(t.finals, [[{ text: "Vedo un errore alla riga 3!", emotion: "sorpresa", intensity: 0.8, look: "riga 3" }]]);
  assert.deepEqual(
    t.h.memory.recentConversation(5).map((e) => [e.who, e.text]),
    [
      ["user", "guarda qui"],
      ["lumi", "Vedo un errore alla riga 3!"],
    ],
  );
});

test("Gemini: whole tool calls without index, thought signatures echoed back", async () => {
  const provider = new CompatProvider("gemini", new OpenAITransport("https://gemini.example/openai", "key", "Gemini"));
  const t = host(provider, "gemini-flash-latest");
  const call = (id: string, name: string, args: unknown, extra?: unknown) => ({
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) }, ...(extra ? { extra_content: extra } : {}) }] } }],
  });
  const signature = { google: { thought_signature: "c2lnbmF0dXJl" } };
  await withFetch(
    (_request, n) =>
      n === 1
        ? sse([
            call("call_1", "say", { emotion: "gioia", text: "Ciao Diego!" }, signature),
            call("call_2", "look_at", { text: "main.ts" }),
            call("call_3", "look_at_screen", {}),
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ])
        : sse([call("call_4", "say", { emotion: "gioia", text: "Che bel codice!" }), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
    async (requests) => {
      await new Brain(t.h).handle({ kind: "message", text: "ciao", via: "text" });
      assert.equal(requests.length, 2);
      const reply = requests[1].body.messages[2] as { tool_calls: { id: string; function: { name: string }; extra_content?: unknown }[] };
      assert.deepEqual(
        reply.tool_calls.map((c) => [c.id, c.function.name]),
        [
          ["call_1", "say"],
          ["call_2", "look_at"],
          ["call_3", "look_at_screen"],
        ],
      );
      assert.deepEqual(reply.tool_calls[0].extra_content, signature, "the thought signature goes back to Gemini");
    },
  );
  assert.deepEqual(
    t.finals[0].map((s) => s.text),
    ["Ciao Diego!", "Che bel codice!"],
  );
  assert.deepEqual(t.lookAts, [{ text: "main.ts", region: undefined }]);
  // The second round's live speech keeps the first round's sentence in front
  const last = t.live[t.live.length - 1];
  assert.equal(last[0].text, "Ciao Diego!");
});

test("a message that gets no speech is answered in one more round; autonomous moments may stay quiet", async () => {
  const provider = new CompatProvider("groq", new OpenAITransport("https://api.example/v1", "key", "Groq"));
  const lookOnly = () => sse([toolDelta(0, { id: "call_a", function: { name: "look_at", arguments: '{"region": "caret"}' } })]);
  const chat = host(provider, "small");
  await withFetch(
    (_request, n) => (n === 1 ? lookOnly() : sse([toolDelta(0, { id: "call_b", function: { name: "say", arguments: '{"emotion": "neutra", "text": "Ci sono!"}' } })])),
    async (requests) => {
      await new Brain(chat.h).handle({ kind: "message", text: "ci sei?", via: "voice" });
      assert.equal(requests.length, 2);
      assert.match(String(requests[1].body.messages[3].content), /still waiting for an answer/);
    },
  );
  assert.equal(chat.finals[0][0].text, "Ci sono!");

  const quiet = host(provider, "small");
  await withFetch(
    () => sse([toolDelta(0, { id: "q", function: { name: "stay_quiet", arguments: '{"minutes": 30}' } })]),
    async (requests) => {
      await new Brain(quiet.h).handle({ kind: "tick" });
      assert.equal(requests.length, 1);
    },
  );
  assert.deepEqual(quiet.quiets, [30]);
  assert.deepEqual(quiet.finals, [[]]);
  assert.equal(quiet.h.memory.recentConversation(5).length, 0);
});

test("plain text answers to messages are spoken; invalid emotions become neutral", async () => {
  const provider = new CompatProvider("custom", new OpenAITransport("http://localhost:1234/v1", null, "LM Studio"));
  const t = host(provider, "local");
  await withFetch(
    (_request, n) =>
      n === 1
        ? sse([{ choices: [{ delta: { content: "<think>hmm</think>Sono qui." }, finish_reason: "stop" }] }])
        : sse([toolDelta(0, { id: "x", function: { name: "say", arguments: '{"emotion": "furious", "text": "Ok."}' } })]),
    async () => {
      const brain = new Brain(t.h);
      await brain.handle({ kind: "message", text: "ehi", via: "text" });
      await brain.handle({ kind: "message", text: "ehi", via: "text" });
    },
  );
  assert.deepEqual(t.finals[0], [{ text: "Sono qui.", emotion: "neutra", intensity: 0.6 }]);
  assert.equal(t.finals[1][0].emotion, "neutra");
});

test("a model without tool support switches to JSON replies, streams them and stays there", async () => {
  const provider = new CompatProvider("openrouter", new OpenAITransport("https://api.example/v1", "key", "OpenRouter"));
  const t = host(provider, "tiny-model:free");
  await withFetch(
    (request) =>
      request.body.tools
        ? new Response(JSON.stringify({ error: { message: "This model does not support tools" } }), { status: 400 })
        : sse([
            { choices: [{ delta: { content: '{"emotion": "gioia", "say": "Ciao! Pausa caff' } }] },
            { choices: [{ delta: { content: 'è?", "remember": [{"fact": "Ama il caffè", "kind": "preference"}], "reminder": {"when": "+20", "text": "Chiamare Marco"}}' } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
          ]),
    async (requests) => {
      const brain = new Brain(t.h);
      await brain.handle({ kind: "message", text: "ciao", via: "voice" });
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.tools, undefined);
      assert.deepEqual(requests[1].body.response_format, { type: "json_object" });
      assert.match(String(requests[1].body.messages[0].content), /Reply format/);
      await brain.handle({ kind: "message", text: "come va?", via: "voice" });
      assert.equal(requests.length, 3, "the next moment goes straight to JSON mode");
    },
  );
  assert.equal(t.finals[0][0].text, "Ciao! Pausa caffè?");
  assert.equal(t.finals[0][0].emotion, "gioia");
  assert.ok(t.live.some((says) => says[0]?.text === "Ciao! Pausa caff" && says[0].emotion === "gioia"), "JSON replies stream too");
  assert.deepEqual(
    t.h.memory.facts().map((f) => [f.text, f.kind]),
    [["Ama il caffè", "preference"]],
  );
  assert.equal(t.h.memory.reminders()[0].text, "Chiamare Marco");
});

test("Ollama: native API with a larger context, no thinking, keep-alive and images", async () => {
  const provider = new CompatProvider("ollama", new OllamaTransport("http://localhost:11434"));
  const t = host(provider, "qwen3");
  await withFetch(
    (_request, n) =>
      n === 1
        ? ndjson([
            { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "look_at_screen", arguments: {} } }] }, done: false },
            { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 1500, eval_count: 20 },
          ])
        : ndjson([
            { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "say", arguments: { emotion: "gioia", text: "Che bel codice!" } } }] }, done: false },
            { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
          ]),
    async (requests) => {
      await new Brain(t.h).handle({ kind: "message", text: "che ne pensi?", via: "voice" });
      assert.equal(requests[0].url, "http://localhost:11434/api/chat");
      assert.deepEqual(requests[0].body.options, { num_ctx: 8192, num_predict: 2048 });
      assert.equal(requests[0].body.think, false);
      assert.equal(requests[0].body.keep_alive, "15m");
      const second = requests[1].body.messages;
      assert.deepEqual(second[3], { role: "tool", content: "Done.", tool_name: "look_at_screen" });
      assert.deepEqual(second[4].images, ["QUJD"]);
    },
  );
  assert.equal(t.finals[0][0].text, "Che bel codice!");
});

test("errors become clear spoken messages", async () => {
  const provider = new CompatProvider("ollama", new OllamaTransport("http://localhost:11434"));
  const offline = host(provider, "qwen3");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await new Brain(offline.h).handle({ kind: "message", text: "ciao", via: "voice" });
  } finally {
    globalThis.fetch = original;
  }
  assert.match(offline.said[0], /Ollama: è avviato/);

  const missing = host(provider, "llama9");
  await withFetch(
    () => new Response(JSON.stringify({ error: "model 'llama9' not found, try pulling it first" }), { status: 404 }),
    async () => {
      await new Brain(missing.h).handle({ kind: "message", text: "ciao", via: "voice" });
    },
  );
  assert.match(missing.said[0], /ollama pull/);

  const groq = new CompatProvider("groq", new OpenAITransport("https://api.example/v1", "bad", "Groq"));
  const auth = host(groq, "m");
  await withFetch(
    () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }),
    async () => {
      const brain = new Brain(auth.h);
      await brain.handle({ kind: "message", text: "ciao", via: "voice" });
      assert.equal(brain.isAvailable("chat"), false, "a refused key stops further requests");
      brain.credentialsChanged();
      assert.equal(brain.isAvailable("chat"), true);
    },
  );
  assert.match(auth.said[0], /chiave di Groq/);
});

test("interrupt stops the stream and a new message goes next", async () => {
  const provider = new CompatProvider("groq", new OpenAITransport("https://api.example/v1", "key", "Groq"));
  const t = host(provider, "m");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await withFetch(
    async (_request, n) => {
      if (n === 1) {
        // A slow stream: aborted by the interruption
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(toolDelta(0, { id: "a", function: { name: "say", arguments: '{"emotion": "neutra", "text": "Allora, ' } }))}\n\n`));
              await gate;
              controller.close();
            },
          }),
        );
      }
      return sse([toolDelta(0, { id: "b", function: { name: "say", arguments: '{"emotion": "gioia", "text": "Dimmi pure!"}' } })]);
    },
    async (requests) => {
      const brain = new Brain(t.h);
      const first = brain.handle({ kind: "message", text: "spiegami tutto", via: "voice" });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(brain.answering());
      void brain.handle({ kind: "message", text: "aspetta", via: "voice" });
      release();
      await first;
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(requests.length, 2);
    },
  );
  assert.ok(t.aborted() >= 1, "the voice was stopped");
  assert.equal(t.finals[t.finals.length - 1][0].text, "Dimmi pure!");
  const users = t.h.memory.recentConversation(10).filter((e) => e.who === "user").map((e) => e.text);
  assert.deepEqual(users, ["spiegami tutto", "aspetta"]);
});

test("partial JSON and replies are parsed robustly", () => {
  assert.equal(stripThinking("<think>devo salutare</think>Ciao!"), "Ciao!");
  assert.equal(stripThinking("<think>ragiono ancora"), "");
  assert.equal(partialStringField('{"text": "Ciao! Co', "text"), "Ciao! Co");
  assert.equal(partialStringField('{"text": "a\\', "text"), "a");
  assert.deepEqual(liveSayFrom('{"emotion": "gioia", "intensity": 0.9, "text": "Evv', "text", false), {
    text: "Evv",
    emotion: "gioia",
    intensity: 0.9,
    look: undefined,
    complete: false,
  });
  // An emotion still being written is not used yet
  assert.equal(liveSayFrom('{"text": "x", "emotion": "gio', "text", false)?.emotion, undefined);
  assert.deepEqual(
    parseJsonReply('```json\n{"emotion": "pensiero", "say": "Ehi!", "look_at_screen": "il terminale", "quiet_minutes": 15}\n```').map((c) => [c.name, c.input]),
    [
      ["say", { text: "Ehi!", emotion: "pensiero" }],
      ["look_at_screen", { focus: "il terminale" }],
      ["stay_quiet", { minutes: 15 }],
    ],
  );
  assert.deepEqual(
    parseJsonReply("Ciao, come stai?").map((c) => c.input),
    [{ text: "Ciao, come stai?", emotion: "neutra" }],
  );
  assert.deepEqual(parseJsonReply("{}"), []);
});

/** The tool shapes the provider uses, for calls written as text. */
const SHAPES = new Map([
  ["say", ["emotion", "text", "intensity", "look"]],
  ["look_at", ["text", "region"]],
  ["stay_quiet", ["minutes"]],
]);

/** Replies Gemma 4 (through Ollama) gave instead of calling say. */
const WRITTEN_CALLS = {
  gemma: 'say{emotion:<|"|>gioia<|"|>,text:<|"|>Certo! Posso ascoltarti, e vedo lo schermo (quando serve).<|"|>}',
  quoted: 'say(emotion:gioia,text: "Ciao! Sono qui come tuo assistente.")\nsay(emotion:gioia,text: "C\'è qualcosa su cui stai lavorando?")',
  bare: "say(emotion:gioia,text: Ciao! Certo che ti racconto, sono qui per te (davvero).)\nsay(emotion: pensiero, intensity: 0.4, text: Come posso esserti utile oggi?)",
};

test("tool calls written as text are read back, in Gemma's syntax and as function calls", () => {
  const read = (text: string) => readTextCalls(text, SHAPES, true)?.calls.map((c) => [c.name, JSON.parse(c.args), c.complete]);
  assert.deepEqual(read(WRITTEN_CALLS.gemma), [["say", { emotion: "gioia", text: "Certo! Posso ascoltarti, e vedo lo schermo (quando serve)." }, true]]);
  assert.deepEqual(read(WRITTEN_CALLS.quoted), [
    ["say", { emotion: "gioia", text: "Ciao! Sono qui come tuo assistente." }, true],
    ["say", { emotion: "gioia", text: "C'è qualcosa su cui stai lavorando?" }, true],
  ]);
  assert.deepEqual(read(WRITTEN_CALLS.bare), [
    ["say", { emotion: "gioia", text: "Ciao! Certo che ti racconto, sono qui per te (davvero)." }, true],
    ["say", { emotion: "pensiero", intensity: 0.4, text: "Come posso esserti utile oggi?" }, true],
  ]);
  // Template tokens, prefixes and fences around calls; single quotes with apostrophes
  assert.deepEqual(read("```tool_code\n<|tool_call>call:stay_quiet{minutes:30}<tool_call|>\n```"), [["stay_quiet", { minutes: 30 }, true]]);
  assert.deepEqual(read("say(emotion='gioia', text='C'è il sole, dai!')"), [["say", { emotion: "gioia", text: "C'è il sole, dai!" }, true]]);
  // Text after the calls is kept apart
  assert.equal(readTextCalls('say{emotion:<|"|>gioia<|"|>,text:<|"|>Ciao!<|"|>} E poi?', SHAPES, true)?.rest, "E poi?");
  // Ordinary answers and unknown functions are not calls
  assert.equal(readTextCalls("Ciao! Sono qui (come sempre).", SHAPES, true), null);
  assert.equal(readTextCalls("print(ciao)", SHAPES, true), null);
  assert.equal(stripMarkup('Ciao<|"|> come va?<tool_call|>'), "Ciao come va?");
});

test("tool calls written as text stream: the spoken text only grows, the emotion comes once complete", () => {
  for (const [form, reply] of Object.entries(WRITTEN_CALLS)) {
    const first = JSON.parse(readTextCalls(reply, SHAPES, true)!.calls[0].args) as { text: string; emotion: string };
    let previous = "";
    let sawEmotion = false;
    for (let n = 1; n <= reply.length; n++) {
      const call = readTextCalls(reply.slice(0, n), SHAPES, false)?.calls[0];
      const say = call ? liveSayFrom(call.args, "text", false) : null;
      if (!say) continue;
      assert.ok(say.text.startsWith(previous), `${form}: "${say.text}" after "${previous}"`);
      assert.ok(first.text.startsWith(say.text), `${form}: "${say.text}" is not part of the final text`);
      if (say.emotion) {
        assert.equal(say.emotion, first.emotion, form);
        sawEmotion = true;
      }
      previous = say.text;
    }
    assert.equal(previous, first.text, form);
    assert.ok(sawEmotion, form);
  }
});

test("Ollama: calls written as text run as real ones: speech live with its emotion, history with real calls", async () => {
  const provider = new CompatProvider("ollama", new OllamaTransport("http://localhost:11434"));
  const t = host(provider, "gemma4:e4b");
  const pieces = ["say{emotion:<|", '"|>gioia<|"|>,text:<|"|>Ciao! Posso ', "aiutarti con il codice.<|", '"|>}<tool_call|>', "<|tool_call>call:look_at_screen{}"];
  await withFetch(
    (_request, n) =>
      n === 1
        ? ndjson([...pieces.map((content) => ({ message: { role: "assistant", content }, done: false })), { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }])
        : ndjson([{ message: { role: "assistant", content: 'Bel codice<|"|>.' }, done: true, done_reason: "stop" }]),
    async (requests) => {
      await new Brain(t.h).handle({ kind: "message", text: "che sai fare?", via: "voice" });
      const reply = requests[1].body.messages.find((m) => m.role === "assistant");
      assert.equal(reply?.content, "");
      assert.deepEqual(reply?.tool_calls, [
        { function: { name: "say", arguments: { emotion: "gioia", text: "Ciao! Posso aiutarti con il codice." } } },
        { function: { name: "look_at_screen", arguments: {} } },
      ]);
    },
  );
  assert.deepEqual(t.looks, [undefined]);
  assert.ok(t.live.some((says) => says[0]?.text === "Ciao! Posso" && says[0].emotion === "gioia"), "spoken while it streams");
  // A plain text answer loses leaked template tokens
  assert.deepEqual(
    t.finals[0].map((s) => [s.text, s.emotion]),
    [
      ["Ciao! Posso aiutarti con il codice.", "gioia"],
      ["Bel codice.", "neutra"],
    ],
  );
});

test("the prompt asks for spoken style and carries the screen and interruptions", () => {
  const system = buildSystemPrompt(DEFAULT_SETTINGS);
  assert.match(system, /No lists, no markdown/);
  assert.match(system, /At most one question at a time/);
  assert.match(system, /Certo!/);
  const memory = new Memory(null);
  memory.addMessage("user", "Spiegami le closure");
  memory.addMessage("lumi", "Una closure è una funzione che", true);
  const context = buildContext({
    situation: {
      now: new Date(2026, 9, 13, 11, 0),
      activity: { idleSec: 2, away: false, locked: false, sessionMinutes: 70, awayMinutes: 0 },
      voice: true,
      screen: "App: Code - closure.js",
      vision: "ask",
    },
    settings: DEFAULT_SETTINGS,
    facts: [],
    reminders: [],
    diary: [],
    conversation: memory.recentConversation(5),
    trigger: { kind: "message", text: "aspetta", via: "voice" },
  });
  assert.match(context, /<screen>\nApp: Code - closure.js\n<\/screen>/);
  assert.match(context, /Una closure è una funzione che \[interrotto\]/);
  assert.match(context, /speech recognition/);
  assert.match(context, /the user is asked first/);
});
