// The command bar: placement, prompt history, attachments and how a bar message reaches the brain.
import assert from "node:assert/strict";
import test from "node:test";
import { classify, clipText, MAX_FILES, MAX_TOTAL_CHARS, readAttachments, type AttachmentIo } from "../src/main/attachments";
import { buildContext, messageForHistory, type Trigger } from "../src/main/brain/prompt";
import { BAR_WIDTH, barPosition, HISTORY_SIZE, pushHistory, supportsAcrylic } from "../src/main/commandbar";
import { PromptHistory } from "../src/renderer/commandbar/history";
import { DEFAULT_SETTINGS } from "../src/shared/types";

test("the bar is centered on the work area, its top at 30% of the height", () => {
  assert.deepEqual(barPosition({ x: 0, y: 0, width: 1920, height: 1040 }), { x: (1920 - BAR_WIDTH) / 2, y: 312 });
  // A second monitor on the left
  assert.deepEqual(barPosition({ x: -2560, y: 100, width: 2560, height: 1400 }), { x: -2560 + (2560 - BAR_WIDTH) / 2, y: 520 });
});

test("the prompt history has no duplicates, keeps the newest last and at most 50", () => {
  assert.deepEqual(pushHistory(["a", "b", "c"], " b "), ["a", "c", "b"]);
  assert.deepEqual(pushHistory(["a"], "   "), ["a"]);
  const long = Array.from({ length: HISTORY_SIZE }, (_, i) => `p${i}`);
  const next = pushHistory(long, "nuovo");
  assert.equal(next.length, HISTORY_SIZE);
  assert.equal(next[0], "p1");
  assert.equal(next.at(-1), "nuovo");
});

test("acrylic only on Windows 11 22H2 or later", () => {
  assert.equal(supportsAcrylic("10.0.22631", "win32"), true);
  assert.equal(supportsAcrylic("10.0.22621", "win32"), true);
  assert.equal(supportsAcrylic("10.0.22000", "win32"), false, "Windows 11 21H2");
  assert.equal(supportsAcrylic("10.0.19045", "win32"), false, "Windows 10");
  assert.equal(supportsAcrylic("23.1.0", "darwin"), false);
});

test("the arrows walk through earlier prompts and come back to the draft", () => {
  const h = new PromptHistory(["primo", "secondo"]);
  assert.equal(h.down(), null, "already on the draft");
  assert.equal(h.up("bozza"), "secondo");
  assert.equal(h.up("secondo"), "primo");
  assert.equal(h.up("primo"), null, "oldest reached");
  assert.equal(h.down(), "secondo");
  assert.equal(h.down(), "bozza", "what was being typed comes back");
  assert.equal(h.down(), null);
  assert.equal(new PromptHistory([]).up("x"), null);
});

test("files are classified as image, text or binary", () => {
  const text = new TextEncoder().encode("ciao è così\nseconda riga");
  assert.equal(classify("foto.JPG", text), "image");
  assert.equal(classify("note.md", text), "text");
  assert.equal(classify("senza-estensione", text), "text");
  assert.equal(classify("app.exe", new Uint8Array([77, 90, 0, 0, 3])), "binary");
});

test("long text is clipped at a line end with a marker", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `riga ${i}`).join("\n");
  const clipped = clipText(lines, 200);
  assert.ok(clipped.length < 260);
  assert.match(clipped, /\nriga \d+\n\[… file troncato: \d+ caratteri non letti\]$/);
  assert.equal(clipText("corto", 200), "corto");
});

test("attachments: text read within a shared budget, images described, the rest named", async () => {
  const files: Record<string, Uint8Array | number> = {
    "C:\\a\\uno.txt": new TextEncoder().encode("x".repeat(30_000)),
    "C:\\a\\due.log": new TextEncoder().encode("errore alla riga 3"),
    "C:\\a\\foto.png": new Uint8Array([137, 80, 78, 71]),
    "C:\\a\\app.exe": new Uint8Array([77, 90, 0, 0]),
    "C:\\a\\enorme.iso": 9_000_000,
  };
  const described: string[] = [];
  const io: AttachmentIo = {
    size: async (p) => (typeof files[p] === "number" ? (files[p] as number) : (files[p] as Uint8Array).length),
    read: async (p) => files[p] as Uint8Array,
    describeImage: async (_p, name) => {
      described.push(name);
      return "What the image shows: un gatto";
    },
  };
  const out = await readAttachments(Object.keys(files), io);
  assert.deepEqual(
    out.map((a) => a.name),
    ["uno.txt", "due.log", "foto.png", "app.exe", "enorme.iso"],
  );
  assert.ok(out[0].content.length <= MAX_TOTAL_CHARS / 2 + 80, "two text files share the budget");
  assert.equal(out[1].content, "errore alla riga 3");
  assert.equal(out[2].content, "What the image shows: un gatto");
  assert.match(out[3].content, /binary/);
  assert.match(out[4].content, /too big/);
  assert.deepEqual(described, ["foto.png"]);

  const many = await readAttachments(
    Array.from({ length: MAX_FILES + 2 }, (_, i) => `C:\\a\\f${i}.txt`),
    { ...io, size: async () => 1, read: async () => new TextEncoder().encode("y") },
  );
  assert.equal(many.length, MAX_FILES + 1);
  assert.match(many.at(-1)!.content, /at most 5 files/);
});

test("a bar message carries the selection and the files to the brain, and a short note to the history", () => {
  const trigger: Extract<Trigger, { kind: "message" }> = {
    kind: "message",
    text: "cosa vuol dire?",
    via: "bar",
    context: { app: "Visual Studio Code", text: "TypeError: x is undefined" },
    attachments: [{ name: "log.txt", content: "riga 1" }],
  };
  const context = buildContext({
    situation: {
      now: new Date(2026, 9, 14, 11, 0),
      activity: { idleSec: 2, away: false, locked: false, sessionMinutes: 70, awayMinutes: 0 },
      voice: true,
      screen: "",
      vision: "ask",
    },
    settings: DEFAULT_SETTINGS,
    facts: [],
    reminders: [],
    diary: [],
    conversation: [],
    trigger,
  });
  assert.match(context, /typed to you in the command bar: «cosa vuol dire\?»/);
  assert.match(context, /selected in Visual Studio Code[^\n]*\n<selection>\nTypeError: x is undefined\n<\/selection>/);
  assert.match(context, /Attached file «log\.txt»:\n<file>\nriga 1\n<\/file>/);
  assert.equal(messageForHistory(trigger), "cosa vuol dire? [testo selezionato: «TypeError: x is undefined»; allegato: log.txt]");
  assert.equal(messageForHistory({ kind: "message", text: "ciao", via: "bar" }), "ciao");
});
