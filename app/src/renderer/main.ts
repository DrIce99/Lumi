// Face window renderer: draws the eyes (or the 3D avatar), shows speech
// bubbles and the chat box, and turns mouse gestures into clicks and drags.
// The window is click-through except over the face, the bubble and the chat
// box.
import type { AvatarConfig, FaceBridge, FaceLayout, FaceMode, FaceState, GazeCommand } from "../shared/types";
import { Player } from "./audio/player";
import { Listener } from "./audio/vad";
import type { Avatar } from "./avatar/avatar";
import { Bubble } from "./bubble";
import { Face } from "./face/face";
import type { FaceView } from "./faceView";

declare global {
  interface Window {
    lumi: FaceBridge;
  }
}

const api = window.lumi;
const canvas = document.getElementById("face") as HTMLCanvasElement;
let avatarCanvas = document.getElementById("avatar") as HTMLCanvasElement;

/** A new canvas for each avatar: a canvas whose WebGL context was released can't give another one. */
function freshAvatarCanvas(): HTMLCanvasElement {
  const next = avatarCanvas.cloneNode(false) as HTMLCanvasElement;
  avatarCanvas.replaceWith(next);
  avatarCanvas = next;
  return next;
}
const chat = document.getElementById("chat") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;

let layout: FaceLayout = {
  mode: "minimal",
  scale: 1,
  color: "#F5F3EE",
  face: { x: 110, y: 280, width: 160, height: 120 },
  windowWidth: 380,
  windowHeight: 400,
  overlay: "above",
};

// The face drawn now: the eyes, or the avatar once its bundle and model are loaded
let face: FaceView = new Face(canvas, layout);
let mode: FaceMode = "minimal";
let avatarConfig: AvatarConfig | null = null;
let lastState: FaceState | null = null;
let lastGaze: GazeCommand | null = null;

/** Does nothing while the avatar loads (the window shows only bubbles meanwhile). */
const NO_FACE: FaceView = {
  setLayout: () => undefined,
  setState: () => undefined,
  setGaze: () => undefined,
  setContrast: () => undefined,
  gesture: () => undefined,
  glare: () => undefined,
  travel: () => undefined,
  transit: () => 0,
  resetTransit: () => undefined,
  sentenceStart: () => undefined,
  sentenceEnd: () => undefined,
  setLevelSource: () => undefined,
  setTalking: () => undefined,
  hitTest: () => false,
  dispose: () => undefined,
};

/** The avatar bundle (three.js and the VRM loader), loaded the first time it is needed. */
let avatarModule: Promise<NonNullable<Window["LumiAvatar"]>> | null = null;
function loadAvatarModule(): Promise<NonNullable<Window["LumiAvatar"]>> {
  avatarModule ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "avatar/index.js";
    script.onload = () => (window.LumiAvatar ? resolve(window.LumiAvatar) : reject(new Error("avatar bundle without its module")));
    script.onerror = () => reject(new Error("avatar bundle not found"));
    document.head.append(script);
  });
  return avatarModule;
}

/** Gives a new face what the old one knew. */
function adopt(next: FaceView): void {
  face = next;
  face.setLevelSource(() => player.level());
  face.setTalking(player.active);
  if (lastState) face.setState(lastState);
  if (lastGaze) face.setGaze(lastGaze);
}

function useEyes(): void {
  face.dispose();
  adopt(new Face(canvas, layout));
}

function setMode(next: FaceMode): void {
  if (next === mode) return;
  mode = next;
  if (next === "minimal") return useEyes();
  face.dispose();
  face = NO_FACE;
  loadAvatarModule()
    .then((m) => {
      if (mode !== "3d") return;
      const avatar = new m.Avatar(freshAvatarCanvas(), layout, (err) => {
        // No WebGL, or a broken model: back to the eyes
        console.error(`The 3D avatar can't be shown, back to the eyes: ${err instanceof Error ? err.message : String(err)}`);
        if (face === avatar) useEyes();
      });
      avatar.setBrightSource(() => player.brightness());
      adopt(avatar);
      if (avatarConfig) void avatar.setConfig(avatarConfig).catch(() => undefined);
    })
    .catch((err: unknown) => {
      console.error(`The avatar bundle failed to load: ${err instanceof Error ? err.message : String(err)}`);
      if (mode === "3d") useEyes();
    });
}

const bubble = new Bubble(document.getElementById("bubble") as HTMLDivElement, {
  relayout: () => placeOverlays(),
  clicked: () => api.bubbleClicked(),
  choice: (id, choice) => api.bubbleChoice(id, choice),
});

// ---------------- voice ----------------

const player = new Player({
  event: (event) => {
    api.playback(event);
    face.setTalking(player.active);
  },
  sentenceStart: (kind) => {
    face.setTalking(true);
    if (kind === "speech") face.sentenceStart();
    else if (kind === "backchannel") face.gesture("nod");
  },
  sentenceEnd: (kind) => {
    face.setTalking(player.active);
    if (kind === "speech") face.sentenceEnd();
  },
});
face.setLevelSource(() => player.level());
api.onAudioBegin((msg) => player.begin(msg));
api.onAudioChunk((msg) => player.chunk(msg));
api.onAudioEnd(({ id }) => player.end(id));
api.onAudioLocal(({ local }) => player.setLocal(local));
api.onAudioStop(({ fadeMs }) => {
  player.stop(fadeMs);
  setTimeout(() => face.setTalking(player.active), fadeMs + 20);
});

const listener = new Listener((event) => api.mic(event));
let micQueue: Promise<void> = Promise.resolve();
api.onMicControl((control) => {
  // Changes are applied one at a time: starting the microphone takes a moment
  micQueue = micQueue.then(() => listener.apply(control)).catch((err: unknown) => api.mic({ type: "error", message: String(err) }));
});

// ---------------- layout ----------------

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

function placeOverlays(): void {
  const f = layout.face;
  const centerX = f.x + f.width / 2;
  const gap = 4 * layout.scale;
  // Overlays stack away from the eyes: above them, or below when the face is near the top of the screen
  // (the eyes sit in the middle of their box; the avatar's head is at the top of its own)
  const inset = layout.mode === "3d" ? 0.01 : 0.18;
  let edge = layout.overlay === "above" ? f.y + f.height * inset - gap : f.y + f.height * (1 - inset) + gap;
  const place = (el: HTMLElement) => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${clamp(centerX - w / 2, 6, layout.windowWidth - w - 6)}px`;
    if (layout.overlay === "above") {
      el.style.top = `${Math.max(4, edge - h)}px`;
      edge -= h + 10;
    } else {
      el.style.top = `${Math.min(layout.windowHeight - h - 4, edge)}px`;
      edge += h + 10;
    }
  };
  if (!chat.hidden) place(chat);
  if (bubble.visible) {
    const text = bubble.el.querySelector(".bubble-text") as HTMLElement;
    const room = layout.overlay === "above" ? edge - 30 : layout.windowHeight - edge - 30;
    text.style.maxHeight = `${clamp(room, 80, 220)}px`;
    place(bubble.el);
  }
}

// ---------------- mouse: hover, click, drag ----------------

let interactive = false;
let press: { x: number; y: number } | null = null;
let dragging = false;

function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  api.setInteractive(on);
}

function inside(el: HTMLElement, x: number, y: number): boolean {
  if (el.hidden) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 10 && y <= r.bottom + 4;
}

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  press = null;
  document.body.classList.remove("dragging");
  api.dragEnd();
}

document.addEventListener("mousemove", (e) => {
  if (dragging && (e.buttons & 1) === 0) endDrag();
  const onEyes = face.hitTest(e.clientX, e.clientY);
  document.body.classList.toggle("over-eyes", onEyes);
  setInteractive(dragging || press !== null || onEyes || inside(bubble.el, e.clientX, e.clientY) || inside(chat, e.clientX, e.clientY));
  if (press && !dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) {
    dragging = true;
    document.body.classList.add("dragging");
    api.dragStart();
  }
});

document.addEventListener("mouseleave", () => {
  if (!dragging && !press) setInteractive(false);
});

/** Mouse events on the bubble or the chat box are theirs, not the face's. */
const onOverlay = (e: MouseEvent) => e.target instanceof Element && e.target.closest("#bubble, #chat") !== null;

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || onOverlay(e) || !face.hitTest(e.clientX, e.clientY)) return;
  press = { x: e.clientX, y: e.clientY };
  e.preventDefault();
});

window.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !press) return;
  if (dragging) {
    endDrag();
    return;
  }
  press = null;
  if (face.hitTest(e.clientX, e.clientY, 8)) api.click();
});

document.addEventListener("contextmenu", (e) => {
  if (onOverlay(e) || !face.hitTest(e.clientX, e.clientY, 8)) return;
  e.preventDefault();
  api.contextMenu();
});

// ---------------- chat box ----------------

function autoGrow(): void {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(96, chatInput.scrollHeight)}px`;
  placeOverlays();
}

function sendChat(): void {
  const text = chatInput.value.trim();
  if (!text) return;
  api.send(text);
  chatInput.value = "";
  autoGrow();
}

function closeChat(): void {
  if (chat.hidden) return;
  chat.hidden = true;
  placeOverlays();
  api.closeInput();
}

api.onInputOpen(() => {
  chat.hidden = false;
  autoGrow();
  window.setTimeout(() => chatInput.focus(), 30);
});
api.onInputClose(() => {
  chat.hidden = true;
  placeOverlays();
});

chat.addEventListener("submit", (e) => {
  e.preventDefault();
  sendChat();
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat();
  } else if (e.key === "Escape") {
    closeChat();
  }
});
chatInput.addEventListener("input", autoGrow);
window.addEventListener("blur", () => {
  endDrag();
  closeChat();
});

// ---------------- state from the main process ----------------

api.onLayout((next) => {
  layout = next;
  face.setLayout(next);
  setMode(next.mode);
  placeOverlays();
});
api.onAvatar((config) => {
  avatarConfig = config;
  if (mode === "3d" && face !== NO_FACE && "setConfig" in face) void (face as Avatar).setConfig(config).catch(() => undefined);
});
api.onState((state) => {
  lastState = state;
  face.setState(state);
});
api.onGaze((gaze) => {
  lastGaze = gaze;
  face.setGaze(gaze);
});
api.onGesture((gesture) => face.gesture(gesture));
api.onAct((gesture) => {
  if ("act" in face) (face as Avatar).act(gesture);
});
api.onContrast((contrast) => face.setContrast(contrast));
api.onGlare(({ lightDx }) => face.glare(lightDx));
api.onTravel(({ vx, vy, landed }) => face.travel(vx, vy, landed));
api.onTransit(({ kind, x, y }) => (kind === "reset" ? face.resetTransit() : face.transit(kind, { x, y })));
api.onBubbleStart((msg) => bubble.start(msg));
api.onBubbleChunk((msg) => bubble.chunk(msg));
api.onBubbleEnd((msg) => bubble.end(msg));
api.onBubbleHide(() => bubble.hide());

placeOverlays();
api.ready();
