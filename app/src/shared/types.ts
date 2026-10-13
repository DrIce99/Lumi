// Types and constants shared by the main process, preloads and renderers.
import type { Emotion, Expression } from "./emotions";
import { DEFAULT_OLLAMA_URL, type ProviderId } from "./providers";

// ---------------- settings ----------------

export const PROFILES = ["leggero", "bilanciato", "locale"] as const;
export type Profile = (typeof PROFILES)[number];

export const SOCIABILITY = ["silenzioso", "discreto", "normale", "chiacchierone"] as const;
export type Sociability = (typeof SOCIABILITY)[number];

export const LISTEN_MODES = ["push-to-talk", "wake-word", "continuous"] as const;
export type ListenMode = (typeof LISTEN_MODES)[number];

export const STT_ENGINES = ["faster-whisper", "parakeet", "whisper-cpp", "groq"] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

export const TTS_ENGINES = ["qwen3", "chatterbox", "kokoro"] as const;
export type TtsEngine = (typeof TTS_ENGINES)[number];

export const OCR_ENGINES = ["windows", "rapidocr"] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];

export const SCREENSHOT_POLICIES = ["never", "ask", "always"] as const;
export type ScreenshotPolicy = (typeof SCREENSHOT_POLICIES)[number];

export const DEVICES = ["auto", "cuda", "cpu"] as const;
export type Device = (typeof DEVICES)[number];

export interface BrainChoice {
  provider: ProviderId;
  model: string;
}

export interface Settings {
  profile: Profile;
  userName: string;
  /** Free notes about Lumi's character, added to the system prompt. */
  personality: string;
  brain: {
    chat: BrainChoice;
    /** Autonomous moments; can be a smaller or local model. */
    idle: BrainChoice;
    /** Model for look_at_screen; an empty model means "the chat model". */
    vision: BrainChoice;
    ollamaUrl: string;
    customUrl: string;
  };
  stt: { engine: SttEngine; model: string; device: Device; vocabulary: string[] };
  tts: { engine: TtsEngine; model: string; voice: string; speed: number; volume: number; seed: number };
  listen: {
    mode: ListenMode;
    /** Push-to-talk, held down (Electron accelerator syntax). */
    hotkey: string;
    wakeWord: string;
    /** After an answer Lumi keeps listening this long without hotkey or wake word (0 = off). */
    followUpSeconds: number;
    bargeIn: boolean;
    backchannel: boolean;
    fillers: boolean;
    micDevice: string;
  };
  face: { scale: number; color: string; subtitles: boolean };
  perception: {
    enabled: boolean;
    ocr: OcrEngine;
    captureFps: number;
    ocrFps: number;
    uia: boolean;
    pauseInApps: string[];
    sendScreenshots: ScreenshotPolicy;
  };
  sociability: Sociability;
  doNotDisturb: boolean;
  /** No voice: answers appear only as text bubbles. */
  muted: boolean;
  /** Opens the chat box. */
  chatHotkey: string;
  launchAtLogin: boolean;
  /** The first-run wizard (hardware profile) has been shown. */
  setupDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  profile: "bilanciato",
  userName: "",
  personality: "",
  brain: {
    chat: { provider: "groq", model: "llama-3.3-70b-versatile" },
    idle: { provider: "ollama", model: "qwen3" },
    vision: { provider: "gemini", model: "" },
    ollamaUrl: DEFAULT_OLLAMA_URL,
    customUrl: "",
  },
  stt: { engine: "faster-whisper", model: "large-v3-turbo", device: "auto", vocabulary: [] },
  tts: { engine: "qwen3", model: "1.7B-CustomVoice", voice: "ryan", speed: 1, volume: 1, seed: 7 },
  listen: {
    mode: "push-to-talk",
    hotkey: "Control+Alt+Space",
    wakeWord: "ehi lumi",
    followUpSeconds: 8,
    bargeIn: true,
    backchannel: true,
    fillers: true,
    micDevice: "",
  },
  face: { scale: 1, color: "#F5F3EE", subtitles: false },
  perception: {
    enabled: true,
    ocr: "windows",
    captureFps: 4,
    ocrFps: 1.5,
    uia: true,
    pauseInApps: ["KeePass", "1Password", "Bitwarden"],
    sendScreenshots: "ask",
  },
  sociability: "normale",
  doNotDisturb: false,
  muted: false,
  chatHotkey: "Control+Alt+L",
  launchAtLogin: false,
  setupDone: false,
};

// ---------------- memory ----------------

export type FactKind = "user" | "work" | "preference" | "event" | "lumi" | "note";
export const FACT_KINDS: FactKind[] = ["user", "work", "preference", "event", "lumi", "note"];

export interface Fact {
  id: string;
  text: string;
  kind: FactKind;
  createdAt: string;
  /** Notes expire; durable facts don't. */
  expiresAt?: string;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
}

export interface DiaryEntry {
  date: string;
  summary: string;
}

export type KeySource = "settings" | "environment" | "none";

// ---------------- face window ----------------

/** Base size of the face at scale 1 (DIP). */
export const FACE_WIDTH = 160;
export const FACE_HEIGHT = 120;

export interface FaceLayout {
  scale: number;
  color: string;
  /** The face box inside the window (DIP). */
  face: { x: number; y: number; width: number; height: number };
  windowWidth: number;
  windowHeight: number;
  /** Where speech bubbles and the chat box go, relative to the face. */
  overlay: "above" | "below";
}

/** What Lumi is looking at, decided in the main process by the attention module. */
export type AttentionKind = "speaking" | "caret" | "text" | "reading" | "change" | "mouse" | "user" | "idle";

export interface GazeCommand {
  /** Target relative to the face center (DIP, screen space); null when there is nothing to look at. */
  target: { dx: number; dy: number } | null;
  kind: AttentionKind;
  /** Follow the target continuously (a moving mouse) instead of jumping to it. */
  pursuit: boolean;
}

export interface FaceState {
  expression: Expression;
  intensity: number;
  listening: boolean;
  thinking: boolean;
  speaking: boolean;
  /** The user is away or it is very late: heavy lids, slow blinks. */
  drowsy: boolean;
}

/** A short eye gesture, independent of the expression. */
export type FaceGesture = "nod" | "shake" | "bounce" | "tremble";

export type BubbleKind = "speech" | "system" | "question";

export interface BubbleStart {
  id: number;
  kind: BubbleKind;
}

export interface BubbleChunk {
  id: number;
  text: string;
}

export interface BubbleEnd {
  id: number;
  /** Authoritative final text; replaces what was streamed if they differ. */
  finalText: string;
  holdMs: number;
  expectsReply: boolean;
  /** Buttons for a question bubble (e.g. permission to send a screenshot). */
  choices?: { id: string; label: string }[];
}

// ---------------- audio between main and the face renderer ----------------

export type UtteranceKind = "speech" | "filler" | "backchannel";

/** A sentence about to be played; its PCM follows in AudioChunk messages with the same id. */
export interface AudioBegin {
  id: number;
  kind: UtteranceKind;
  text: string;
  emotion: Emotion;
  intensity: number;
  volume: number;
}

export interface AudioChunk {
  id: number;
  /** PCM 16-bit little endian, mono. */
  pcm: ArrayBuffer;
  sampleRate: number;
}

export type PlaybackEvent =
  | { id: number; type: "start" }
  | { id: number; type: "end"; playedMs: number; totalMs: number; interrupted: boolean };

export interface MicControl {
  /** Microphone and VAD running. */
  enabled: boolean;
  /** Stream every frame to main (push-to-talk held). */
  forceStream: boolean;
  /** Stream frames to main from each detected speech start (with pre-roll) to its end. */
  autoStream: boolean;
  /** Lumi is talking: speech must be stronger and longer to count (barge-in). */
  strict: boolean;
  deviceId: string;
  /** Silence after which the VAD closes a speech segment. */
  redemptionMs: number;
}

export type MicEvent =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "speech-start" }
  | { type: "speech-confirmed" }
  | { type: "speech-end"; durationMs: number }
  | { type: "misfire" }
  /** PCM 16-bit 16 kHz mono. */
  | { type: "frame"; pcm: ArrayBuffer; speech: number };

/** API exposed by the face window preload as `window.lumi`. */
export interface FaceBridge {
  onLayout(cb: (layout: FaceLayout) => void): void;
  onState(cb: (state: FaceState) => void): void;
  onGaze(cb: (gaze: GazeCommand) => void): void;
  onGesture(cb: (gesture: FaceGesture) => void): void;
  onBubbleStart(cb: (msg: BubbleStart) => void): void;
  onBubbleChunk(cb: (msg: BubbleChunk) => void): void;
  onBubbleEnd(cb: (msg: BubbleEnd) => void): void;
  onBubbleHide(cb: () => void): void;
  onInputOpen(cb: () => void): void;
  onInputClose(cb: () => void): void;
  onAudioBegin(cb: (msg: AudioBegin) => void): void;
  onAudioChunk(cb: (msg: AudioChunk) => void): void;
  /** No more chunks for this sentence. */
  onAudioEnd(cb: (msg: { id: number }) => void): void;
  /** Stop everything playing or queued, fading out (barge-in). */
  onAudioStop(cb: (msg: { fadeMs: number }) => void): void;
  onMicControl(cb: (control: MicControl) => void): void;
  ready(): void;
  setInteractive(interactive: boolean): void;
  click(): void;
  dragStart(): void;
  dragEnd(): void;
  contextMenu(): void;
  send(text: string): void;
  closeInput(): void;
  bubbleClicked(): void;
  bubbleChoice(bubbleId: number, choice: string): void;
  playback(event: PlaybackEvent): void;
  mic(event: MicEvent): void;
}

// ---------------- sidecar status ----------------

export type EngineState = "missing" | "idle" | "loading" | "ready" | "error";

export interface EngineStatus {
  kind: "stt" | "tts" | "ocr" | "uia" | "turn" | "wake";
  name: string;
  state: EngineState;
  device?: string;
  detail?: string;
}

export interface GpuInfo {
  name: string;
  vramTotalMb: number;
  vramFreeMb?: number;
}

export interface SidecarStatus {
  state: "off" | "starting" | "ready" | "error";
  message: string;
  engines: EngineStatus[];
  gpu: GpuInfo | null;
  /** Engine packages installed in the sidecar environment. */
  installed: string[];
}

// ---------------- settings window ----------------

export interface SettingsSnapshot {
  settings: Settings;
  keys: Record<ProviderId, KeySource>;
  facts: Fact[];
  reminders: Reminder[];
  diary: DiaryEntry[];
  dataPath: string;
  sidecar: SidecarStatus;
  /** Detected with nvidia-smi, for the profile wizard. */
  gpu: GpuInfo | null;
  voices: Partial<Record<TtsEngine, string[]>>;
}

export interface ConnectionReport {
  ok: boolean;
  message: string;
}

/** API exposed by the settings window preload as `window.settingsApi`. */
export interface SettingsBridge {
  load(): Promise<SettingsSnapshot>;
  /** `keys`: missing providers keep their key, "" removes it. */
  save(settings: Settings, keys: Partial<Record<ProviderId, string>>): Promise<SettingsSnapshot>;
  testConnection(): Promise<ConnectionReport[]>;
  listModels(provider: ProviderId): Promise<{ ok: boolean; models: string[]; message: string }>;
  testVoice(text: string): Promise<ConnectionReport>;
  applyProfile(profile: Profile): Promise<SettingsSnapshot>;
  pickVoiceFile(): Promise<string | null>;
  forgetFact(id: string): Promise<SettingsSnapshot>;
  clearMemory(): Promise<SettingsSnapshot>;
  openDataFolder(): Promise<void>;
  restartSidecar(): Promise<SettingsSnapshot>;
  onStatus(cb: (status: SidecarStatus) => void): void;
}
