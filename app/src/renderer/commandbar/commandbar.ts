// The command bar page: one text field that grows up to 6 lines, the text
// selected in another app as a removable "context" chip, dropped files as
// chips. Enter sends, Shift+Enter starts a new line, Esc closes, the arrows
// recall earlier prompts.
import type { BarBridge, BarOpen } from "../../shared/types";
import { PromptHistory } from "./history";

declare global {
  interface Window {
    lumiBar: BarBridge;
  }
}

const api = window.lumiBar;
const MAX_LINES = 6;
const MAX_FILES = 5;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = $<HTMLDivElement>("panel");
const input = $<HTMLTextAreaElement>("input");
const contextChip = $<HTMLDivElement>("context");
const contextText = $<HTMLSpanElement>("contextText");
const filesRow = $<HTMLDivElement>("files");
const drop = $<HTMLDivElement>("drop");

if (new URLSearchParams(location.search).has("acrylic")) document.documentElement.classList.add("acrylic");

let history = new PromptHistory([]);
let useContext = false;
let files: string[] = [];
let lastTyping = 0;

function grow(): void {
  const line = parseFloat(getComputedStyle(input).lineHeight) || 26;
  input.style.height = "auto";
  const lines = Math.min(MAX_LINES, Math.max(1, Math.round(input.scrollHeight / line)));
  input.style.height = `${lines * line}px`;
  input.style.overflowY = input.scrollHeight > lines * line + 1 ? "auto" : "hidden";
}

function renderFiles(): void {
  filesRow.replaceChildren(
    ...files.map((path, i) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      const name = document.createElement("span");
      name.className = "chip-text";
      name.textContent = path.split(/[\\/]/).pop() ?? path;
      name.title = path;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip-x";
      x.textContent = "×";
      x.title = "Togli l'allegato";
      x.addEventListener("click", () => {
        files.splice(i, 1);
        renderFiles();
        input.focus();
      });
      chip.append(name, x);
      return chip;
    }),
  );
  filesRow.hidden = files.length === 0;
}

function reset(msg: BarOpen): void {
  history = new PromptHistory(msg.history);
  files = [];
  renderFiles();
  input.value = "";
  grow();
  useContext = msg.context !== null;
  contextChip.hidden = !useContext;
  if (msg.context) {
    const text = msg.context.text.replace(/\s+/g, " ").trim();
    contextText.textContent = msg.context.app ? `${msg.context.app}: «${text}»` : `«${text}»`;
    contextText.title = msg.context.text.slice(0, 1000);
  }
  // Replay the entrance: fade and scale from 0.96 to 1
  panel.classList.remove("open");
  void panel.offsetWidth;
  panel.classList.add("open");
  input.focus();
}

function send(): void {
  const text = input.value.trim();
  if (!text && !files.length) return;
  api.submit({ text, useContext, files: [...files] });
}

api.onOpen(reset);
api.onClose(() => panel.classList.remove("open"));
window.addEventListener("focus", () => input.focus());

$<HTMLButtonElement>("contextRemove").addEventListener("click", () => {
  useContext = false;
  contextChip.hidden = true;
  input.focus();
});

input.addEventListener("input", () => {
  grow();
  const now = Date.now();
  if (now - lastTyping > 300) {
    lastTyping = now;
    api.typing();
  }
});

input.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape") {
    e.preventDefault();
    api.cancel();
  } else if (e.key === "ArrowUp" && !input.value.slice(0, input.selectionStart).includes("\n")) {
    // Only from the first line: elsewhere the arrow moves the cursor
    const previous = history.up(input.value);
    if (previous === null) return;
    e.preventDefault();
    input.value = previous;
    grow();
    input.setSelectionRange(previous.length, previous.length);
  } else if (e.key === "ArrowDown" && !input.value.slice(input.selectionEnd).includes("\n")) {
    const next = history.down();
    if (next === null) return;
    e.preventDefault();
    input.value = next;
    grow();
    input.setSelectionRange(next.length, next.length);
  }
});

// Esc also works when the focus is on a chip's button
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target !== input) api.cancel();
});

// ---- dropped files ----
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  drop.hidden = false;
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.hidden = true;
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? "copy" : "none";
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  for (const file of Array.from(e.dataTransfer?.files ?? [])) {
    const path = api.pathFor(file);
    if (path && !files.includes(path) && files.length < MAX_FILES) files.push(path);
  }
  renderFiles();
  input.focus();
});

// The window follows the panel's height (more lines, chips)
// (offsetHeight ignores the entrance's scale transform)
new ResizeObserver(() => api.resize(panel.offsetHeight)).observe(panel);
