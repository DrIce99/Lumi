// Screen perception: change detection, reading, grounding, the summary and the orchestrator.
import assert from "node:assert/strict";
import test from "node:test";
import { muteConsole } from "../src/main/log";
import { perceptionSummary, appName } from "../src/main/perception/context";
import { acceleratorKey, isPrivateWindow, pausedFor } from "../src/main/perception/desktop";
import { BLOCK, changedBlocks, Habituation, lumaFromBgra, mergeBlocks, type Frame } from "../src/main/perception/diff";
import { findText, similarity } from "../src/main/perception/grounding";
import { Perception, type PerceptionHost } from "../src/main/perception/perception";
import { charX, MAX_LINES, planDuration, readingPlan } from "../src/main/perception/reading";
import { DEFAULT_SETTINGS, type GazeCommand } from "../src/shared/types";
import { seeded } from "./helpers";

muteConsole();

function frame(width: number, height: number, fill = 0): Frame {
  return { width, height, luma: new Uint8Array(width * height).fill(fill) };
}

function paint(f: Frame, x0: number, y0: number, w: number, h: number, value: number): Frame {
  const out = { ...f, luma: f.luma.slice() };
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.luma[y * f.width + x] = value;
  return out;
}

test("changed blocks are found and merged into rectangles", () => {
  const a = frame(320, 160);
  const b = paint(paint(a, 10, 10, 40, 20, 200), 250, 100, 20, 20, 200);
  const grid = changedBlocks(a, b);
  assert.equal(grid.cols, 10);
  assert.equal(grid.rows, 5);
  const boxes = mergeBlocks(grid, 320, 160);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x: 0, y: 0, width: 2 * BLOCK, height: BLOCK });
  // x 250-270 straddles the block edge at 256: two blocks
  assert.deepEqual(boxes[1], { x: 7 * BLOCK, y: 3 * BLOCK, width: 2 * BLOCK, height: BLOCK });
  // Tiny noise is not a change
  const noisy = paint(a, 5, 5, 2, 2, 10);
  assert.equal(mergeBlocks(changedBlocks(a, noisy), 320, 160).length, 0);
  // A different size means everything changed
  assert.ok(changedBlocks(a, frame(64, 64)).changed.every((v) => v === 1));
  const luma = lumaFromBgra(new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255]), 2, 1);
  assert.deepEqual([...luma.luma], [76, 255]);
});

test("a region that keeps changing (a video) loses novelty", () => {
  const habit = new Habituation();
  let prev = frame(128, 64);
  const novelty: number[] = [];
  for (let i = 0; i < 12; i++) {
    const next = paint(prev, 0, 0, 32, 32, (i % 2) * 200 + 20);
    const grid = changedBlocks(prev, next);
    const boxes = mergeBlocks(grid, 128, 64);
    novelty.push(habit.update(grid, boxes)[0]);
    prev = next;
  }
  assert.equal(novelty[0], 1);
  assert.ok(novelty[11] < 0.4, `novelty ${novelty[11]}`);
});

test("reading: fixations every 7-9 characters, 200-250 ms each, at most 6 lines", () => {
  const line = (i: number) => ({ text: "Questa è una riga di testo abbastanza lunga da leggere.", rect: { x: 100, y: 100 + i * 20, width: 550, height: 16 } });
  const plan = readingPlan([0, 1, 2, 3, 4, 5, 6, 7].map(line), seeded(3));
  assert.equal(new Set(plan.map((f) => f.line)).size, MAX_LINES);
  assert.ok(plan.every((f) => f.ms >= 180 && f.ms <= 250));
  const first = plan.filter((f) => f.line === 0);
  assert.ok(first.length >= 6 && first.length <= 10, `${first.length} fixations`);
  assert.ok(first[0].x < first[first.length - 1].x, "left to right");
  assert.equal(first[0].y, 108);
  // Lines go top to bottom with a return sweep
  const starts = [0, 1, 2].map((l) => plan.find((f) => f.line === l)!);
  assert.ok(starts[1].y > starts[0].y && starts[1].x < first[first.length - 1].x);
  // Roughly 250 words per minute: ~9 words in ~2 s for a line
  const ms = planDuration(first);
  assert.ok(ms > 1200 && ms < 3000, `${ms} ms`);
  // Word boxes are used when known
  assert.equal(charX({ text: "ciao mondo", rect: { x: 0, y: 0, width: 100, height: 10 }, words: [{ text: "ciao", rect: { x: 0, y: 0, width: 20, height: 10 } }, { text: "mondo", rect: { x: 60, y: 0, width: 40, height: 10 } }] }, 7), 76);
});

test("grounding finds visible text, also with OCR mistakes", () => {
  const items = [
    { text: "File Modifica Visualizza", rect: { x: 0, y: 0, width: 300, height: 20 } },
    {
      text: "Error: Cannot find module 'koffi'",
      rect: { x: 10, y: 500, width: 400, height: 20 },
      words: ["Error:", "Cannot", "find", "module", "'koffi'"].map((w, i) => ({ text: w, rect: { x: 10 + i * 80, y: 500, width: 70, height: 20 } })),
    },
  ];
  const exact = findText("find module", items);
  assert.equal(exact?.score, 1);
  assert.deepEqual(exact?.rect, { x: 170, y: 500, width: 150, height: 20 });
  const fuzzy = findText("Visualiza", items);
  assert.ok(fuzzy && fuzzy.score > 0.8 && fuzzy.rect.y === 0);
  assert.equal(findText("banana", items), null);
  assert.equal(similarity("ciao", "ciao"), 1);
  assert.ok(similarity("lumi", "lume") === 0.75);
});

test("the summary is compact, private and says when perception is paused", () => {
  const now = 1_000_000;
  const summary = perceptionSummary({
    now,
    paused: null,
    app: { process: "Code.exe", title: "main.ts - Lumi - Visual Studio Code" },
    focus: { controlType: "Edit", name: "main.ts", line: "const face = new FaceWindow(", selection: null, isPassword: false },
    read: Array.from({ length: 30 }, (_, i) => ({ text: `Riga di testo numero ${i} `.repeat(6), at: now - i * 10_000, where: "terminale" })),
  });
  assert.ok(summary.length <= 1500);
  assert.match(summary, /^Active app: Visual Studio Code - window "main.ts - Lumi/);
  assert.match(summary, /Line where the user is typing: "const face = new FaceWindow\("/);
  assert.match(summary, /\[0 s ago, terminale\]/);
  const secret = perceptionSummary({ now, paused: null, app: null, focus: { controlType: "Edit", name: "", line: "hunter2", selection: "x", isPassword: true }, read: [] });
  assert.doesNotMatch(secret, /hunter2/);
  assert.match(secret, /password field/);
  assert.equal(perceptionSummary({ now, paused: "the screen is locked", app: null, focus: null, read: [] }), "(screen perception paused: the screen is locked)");
  assert.equal(appName("WINWORD.EXE"), "Word");
  assert.equal(appName("MyTool.exe"), "MyTool");
});

test("privacy pauses and push-to-talk keys", () => {
  const window = (process: string, title: string) => ({ handle: "1", process, title, pid: 1, rect: null });
  assert.equal(pausedFor(window("KeePass.exe", "Database.kdbx - KeePass"), DEFAULT_SETTINGS.perception.pauseInApps), true);
  assert.equal(pausedFor(window("msedge.exe", "Nuova scheda - [InPrivate] - Microsoft Edge"), []), true);
  assert.equal(pausedFor(window("Code.exe", "main.ts"), DEFAULT_SETTINGS.perception.pauseInApps), false);
  assert.equal(isPrivateWindow("Mozilla Firefox Private Browsing"), true);
  assert.equal(acceleratorKey("Control+Alt+Space"), 0x20);
  assert.equal(acceleratorKey("Alt+F9"), 0x78);
  assert.equal(acceleratorKey("Ctrl+Shift+K"), 0x4b);
  assert.equal(acceleratorKey("Control+Alt"), null);
});

function fakeHost(overrides: Partial<PerceptionHost> = {}) {
  const gazes: GazeCommand[] = [];
  const identity = (r: { x: number; y: number; width: number; height: number }) => r;
  const host: PerceptionHost = {
    settings: () => DEFAULT_SETTINGS,
    faceCenter: () => ({ x: 1000, y: 1000 }),
    cursor: () => ({ x: 0, y: 0 }),
    userPoint: () => ({ x: 960, y: 1080 }),
    context: () => ({ listening: false, speaking: false }),
    active: () => true,
    sendGaze: (g) => gazes.push(g),
    globalPause: () => null,
    foreground: () => ({ handle: "1", process: "WindowsTerminal.exe", title: "PowerShell", pid: 1, rect: { x: 0, y: 0, width: 800, height: 600 } }),
    systemCaret: () => null,
    toDip: identity,
    toPhysical: identity,
    ocr: async () => [],
    notificationArea: () => ({ x: 1500, y: 760, width: 420, height: 320 }),
    screenBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    ...overrides,
  };
  return { host, gazes };
}

test("new text is read, then summarized for the brain; known text is not news", () => {
  let now = 5_000_000;
  const { host, gazes } = fakeHost({ now: () => now });
  const p = new Perception(host);
  (p as unknown as { slowTick(): void }).slowTick();
  const line = (text: string, y: number) => ({ text, rect: { x: 100, y, width: 300, height: 18 }, words: [] });
  p.onText([line("npm ERR! Cannot find module koffi", 300), line("at require (node:internal)", 320)], "terminale");
  p.tick(now);
  assert.equal(gazes[gazes.length - 1].kind, "text");
  // The reading takes over, fixation by fixation, moving right
  const xs: number[] = [];
  for (let i = 0; i < 12; i++) {
    now += 260;
    p.tick(now);
    const g = gazes[gazes.length - 1];
    if (g.kind === "reading" && g.target) xs.push(g.target.dx);
  }
  assert.ok(xs.length >= 3, `reading fixations: ${xs.length}`);
  assert.ok(xs[1] > xs[0]);
  const summary = p.summary();
  assert.match(summary, /Active app: Windows Terminal - window "PowerShell"/);
  assert.match(summary, /terminale\] "npm ERR! Cannot find module koffi at require/);
  // The same text again is not new
  p.onText([line("npm ERR! Cannot find module koffi", 300)]);
  assert.equal((summary.match(/npm ERR/g) ?? []).length, 1);
  // look_at finds it
  assert.match(p.lookAtText("module koffi"), /Looking at "npm ERR!/);
  p.tick(now + 10);
  assert.equal(gazes[gazes.length - 1].kind, "speaking");
  assert.match(p.lookAtText("qualcosa che non c'è"), /not among the text/);
});

test("perception pauses and forgets in private apps", () => {
  let fg = { handle: "1", process: "Code.exe", title: "main.ts", pid: 1, rect: null };
  const { host } = fakeHost({ foreground: () => fg });
  const p = new Perception(host);
  const slow = () => (p as unknown as { slowTick(): void }).slowTick();
  slow();
  p.onText([{ text: "testo visibile qui", rect: { x: 0, y: 0, width: 10, height: 10 }, words: [] }]);
  assert.match(p.summary(), /testo visibile/);
  fg = { handle: "2", process: "Bitwarden.exe", title: "Bitwarden", pid: 2, rect: null };
  slow();
  assert.equal(p.watching(), false);
  assert.match(p.summary(), /paused/);
  fg = { handle: "1", process: "Code.exe", title: "main.ts", pid: 1, rect: null };
  slow();
  assert.doesNotMatch(p.summary(), /testo visibile/, "what was read before the pause is forgotten");
});
