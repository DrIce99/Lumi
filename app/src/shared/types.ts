// Types and constants shared by the main process, preloads and renderers.
import type { Emotion, Expression } from "./emotions";
import { DEFAULT_MOOD_WEIGHTS, type DayMoodId, type MoodWeights } from "./dayMood";
import { DEFAULT_OLLAMA_URL, type ProviderId } from "./providers";

// ---------------- settings ----------------

export const PROFILES = ["leggero", "bilanciato", "locale"] as const;
export type Profile = (typeof PROFILES)[number];

export const SOCIABILITY = ["silenzioso", "discreto", "normale", "chiacchierone"] as const;
export type Sociability = (typeof SOCIABILITY)[number];

export const LISTEN_MODES = ["push-to-talk", "wake-word", "continuous"] as const;
/** How Lumi answers what is typed in the command bar. */
export const BAR_REPLIES = ["voice+text", "voice", "text"] as const;
export type BarReply = (typeof BAR_REPLIES)[number];
export type ListenMode = (typeof LISTEN_MODES)[number];

export const STT_ENGINES = ["faster-whisper", "parakeet", "whisper-cpp", "groq"] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

export const TTS_ENGINES = ["qwen3", "chatterbox", "kokoro"] as const;
export type TtsEngine = (typeof TTS_ENGINES)[number];

export const OCR_ENGINES = ["windows", "rapidocr"] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];

export const SCREENSHOT_POLICIES = ["never", "ask", "always"] as const;
/** Who looks at images on this PC: Ollama, an OpenAI-compatible local server (brain.customUrl), or nobody. */
export const VISION_PROVIDERS = ["ollama", "custom", "none"] as const;
export type VisionProvider = (typeof VISION_PROVIDERS)[number];
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
    /**
     * Online model that gets images when there is no local vision model and
     * sendScreenshots allows it; an empty model means "the chat model".
     */
    vision: BrainChoice;
    ollamaUrl: string;
    customUrl: string;
  };
  /** Local vision model: describes screenshots and attached images in words, so images never leave the PC. */
  vision: {
    provider: VisionProvider;
    model: string;
    /** Ollama keeps the model loaded this long after a look, then frees the VRAM. */
    keepAlive: string;
    /** Long side of the image sent to the model, px. */
    maxSide: number;
  };
  stt: { engine: SttEngine; model: string; device: Device; vocabulary: string[] };
  /** `pronunciations`: "parola = pronuncia" lines, respelled before synthesis (sidecar/text/lexicon_it.py). */
  tts: { engine: TtsEngine; model: string; voice: string; speed: number; volume: number; seed: number; pronunciations: string[] };
  listen: {
    mode: ListenMode;
    /** Push-to-talk, held down (Electron accelerator syntax). */
    hotkey: string;
    wakeWord: string;
    /** openWakeWord score that counts as the name (two frames in a row; 30% higher while Lumi talks). */
    wakeThreshold: number;
    /** After an answer Lumi keeps listening this long without hotkey or wake word (0 = off). */
    followUpSeconds: number;
    /** Silence after a finished sentence before Lumi answers (longer when it sounds unfinished). */
    pauseMs: number;
    bargeIn: boolean;
    backchannel: boolean;
    fillers: boolean;
    /** Answer only sentences meant for Lumi (the name, a reply, a request; the model judges the rest). */
    addressCheck: boolean;
    micDevice: string;
  };
  /**
   * Moving around the screen: `enabled` (move_to at all), `initiative`
   * (Lumi moves on its own: pointing, moods), `pranks` (playful moves when
   * annoyed), `dodge` (out of the way of the text cursor).
   */
  movement: { enabled: boolean; initiative: boolean; pranks: boolean; dodge: boolean };
  /**
   * The mood of the day (main/brain/dayMood.ts): drawn every morning with
   * these weights (0-10 each), changed only by what the user does.
   */
  mood: { enabled: boolean; weights: MoodWeights };
  /**
   * Habits (phase 11): logging the apps the user opens (names only, on this
   * PC), finding patterns, proposing them at the right time.
   */
  habits: { enabled: boolean; proposalCooldownMinutes: number; minOccurrences: number; minFrequency: number };
  /** The phone app (phase 15): the LAN server for pairing and calls, off until enabled. */
  phone: { enabled: boolean; port: number };
  /** Searching the web (web_search, read_page): which free service, or none. */
  web: { provider: WebProvider; searxngUrl: string };
  /** Long-term memory (memory.db): where the embeddings come from, and how results are ordered. */
  memory: {
    /** auto, Ollama, the sidecar on the CPU or none (search by words only); `model` is Ollama's. */
    embeddings: { provider: EmbeddingProvider; model: string };
    /** Generative Agents score: relevance + recency + importance (to tune). */
    weights: { relevance: number; recency: number; importance: number };
    /** Daily copies of memory.db kept in %APPDATA%\Lumi\backups (0: none). */
    backupDays: number;
  };
  /** Recognizing voices (voiceprints stay on this computer). */
  voices: {
    enabled: boolean;
    /** At the microphone, answer only the owner's voice (others are heard as context). */
    onlyMe: boolean;
  };
  /** Lumi's voice in Discord: a bot follows the user into voice channels and speaks there. */
  discord: {
    enabled: boolean;
    /** The user on Discord: numeric id (Developer Mode -> Copy User ID) or username. The bot joins their channel. */
    userId: string;
  };
  /** Listening to other apps (a Discord call): their audio is transcribed on this computer. */
  appAudio: {
    enabled: boolean;
    /** Executable names, e.g. "Discord". */
    apps: string[];
  };
  face: {
    scale: number;
    color: string;
    subtitles: boolean;
    /** Shadow and border under the eyes follow the brightness behind the face (needs perception). */
    adaptiveShadow: boolean;
    /** Squints when the watched screen suddenly turns bright (needs perception). */
    glare: boolean;
    /** Visible to OBS, Remote Desktop and screen sharing (Lumi's own captures paint it over). */
    showInCaptures: boolean;
    /** "minimal": the two eyes; "3d": the VRM avatar (renderer/avatar/). */
    mode: FaceMode;
    /** A VRM file for the 3D mode; empty = the bundled Lumi.vrm. */
    model: string;
  };
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
  /** Opens the command bar. */
  chatHotkey: string;
  commandBar: {
    reply: BarReply;
    /** Text selected in another app when the bar opens becomes its context. */
    useSelection: boolean;
  };
  launchAtLogin: boolean;
  /** The first-run wizard (hardware profile) has been shown. */
  setupDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  profile: "bilanciato",
  userName: "",
  personality: "",
  brain: {
    chat: { provider: "groq", model: "openai/gpt-oss-120b" },
    idle: { provider: "ollama", model: "qwen3" },
    vision: { provider: "gemini", model: "" },
    ollamaUrl: DEFAULT_OLLAMA_URL,
    customUrl: "",
  },
  vision: { provider: "ollama", model: "qwen3-vl:8b", keepAlive: "2m", maxSide: 1344 },
  stt: { engine: "faster-whisper", model: "large-v3-turbo", device: "auto", vocabulary: [] },
  tts: { engine: "qwen3", model: "1.7B-Base", voice: "", speed: 1, volume: 1, seed: 7, pronunciations: [] },
  movement: { enabled: true, initiative: true, pranks: true, dodge: true },
  mood: { enabled: true, weights: DEFAULT_MOOD_WEIGHTS },
  habits: { enabled: true, proposalCooldownMinutes: 20, minOccurrences: 5, minFrequency: 0.7 },
  phone: { enabled: false, port: 47821 },
  web: { provider: "auto", searxngUrl: "" },
  memory: { embeddings: { provider: "auto", model: "bge-m3" }, weights: { relevance: 1, recency: 0.5, importance: 0.5 }, backupDays: 7 },
  listen: {
    mode: "push-to-talk",
    hotkey: "Control+Alt+Space",
    wakeWord: "ehi lumi",
    wakeThreshold: 0.5,
    followUpSeconds: 8,
    pauseMs: 1000,
    bargeIn: true,
    backchannel: true,
    fillers: true,
    addressCheck: true,
    micDevice: "",
  },
  voices: { enabled: true, onlyMe: false },
  discord: { enabled: false, userId: "" },
  appAudio: { enabled: false, apps: ["Discord"] },
  face: { scale: 1, color: "#F5F3EE", subtitles: false, adaptiveShadow: true, glare: true, showInCaptures: false, mode: "minimal", model: "" },
  perception: {
    enabled: true,
    ocr: "windows",
    captureFps: 4,
    ocrFps: 1.5,
    uia: true,
    pauseInApps: ["KeePass", "1Password", "Bitwarden"],
    sendScreenshots: "never",
  },
  sociability: "normale",
  doNotDisturb: false,
  muted: false,
  chatHotkey: "Control+Alt+L",
  commandBar: { reply: "voice+text", useSelection: true },
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
  /** 1-10: how much it matters; 8 and more always reach the prompt. Missing in older files (the kind's default). */
  importance?: number;
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

export const FACE_MODES = ["minimal", "3d"] as const;
export type FaceMode = (typeof FACE_MODES)[number];

/** The face box at scale 1 per mode: the eyes, or the avatar's bust (a half-length shot). */
export const FACE_BOX: Record<FaceMode, { width: number; height: number }> = {
  minimal: { width: FACE_WIDTH, height: FACE_HEIGHT },
  "3d": { width: 180, height: 220 },
};

/** What the 3D avatar loads: the model and the extra clips (gesture name -> app:// URL). */
export interface AvatarConfig {
  model: string;
  clips: Record<string, string>;
}

export interface FaceLayout {
  mode: FaceMode;
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

/** Opacity (0..1) of the dark shadow and border under the eyes. */
export interface FaceContrast {
  shadow: number;
  border: number;
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
/** freeze: half a second still, then a jolt (shock); glassesPush: a finger pushes the glasses up (saccente). */
export type FaceGesture = "nod" | "shake" | "bounce" | "tremble" | "freeze" | "glassesPush" | "land";

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
  /** The sentence starts in EXPRESSION_LEAD_MS (or right away, if it was scheduled later than that): the face anticipates the voice. */
  | { id: number; type: "lead" }
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
/** Text selected in another app when the command bar opened. */
export interface BarContext {
  app: string;
  text: string;
}

export interface BarOpen {
  context: BarContext | null;
  /** Earlier prompts, oldest first (recalled with the up arrow). */
  history: string[];
}

export interface BarSubmit {
  text: string;
  /** The selection shown as context, unless the user removed it. */
  useContext: boolean;
  /** Paths of dropped files. */
  files: string[];
}

/** `window.lumiBar` in the command bar. */
export interface BarBridge {
  onOpen(cb: (msg: BarOpen) => void): void;
  onClose(cb: () => void): void;
  submit(msg: BarSubmit): void;
  cancel(): void;
  /** The panel's height (DIP), the window follows it. */
  resize(height: number): void;
  /** The user is typing: the eyes look at the bar. */
  typing(): void;
  /** The path of a dropped file. */
  pathFor(file: File): string;
}

/** The phone bridge's hidden window (renderer/phone/bridge.ts). */
export interface PhoneBridgeApi {
  onOffer(cb: (msg: { sdp: string }) => void): void;
  onSend(cb: (msg: unknown) => void): void;
  onHangup(cb: () => void): void;
  onAudioBegin(cb: (msg: AudioBegin) => void): void;
  onAudioChunk(cb: (msg: AudioChunk) => void): void;
  onAudioEnd(cb: (msg: { id: number }) => void): void;
  onAudioStop(cb: (msg: { fadeMs: number }) => void): void;
  onMicControl(cb: (control: MicControl) => void): void;
  answer(result: { sdp?: string; error?: string }): void;
  message(msg: unknown): void;
  connection(state: string): void;
  mic(event: MicEvent): void;
  playback(event: PlaybackEvent): void;
  log(text: string): void;
}

export interface FaceBridge {
  onLayout(cb: (layout: FaceLayout) => void): void;
  onState(cb: (state: FaceState) => void): void;
  onGaze(cb: (gaze: GazeCommand) => void): void;
  onGesture(cb: (gesture: FaceGesture) => void): void;
  /** A body gesture chosen by the brain (the 3D avatar plays it; the eyes map a few). */
  onAct(cb: (gesture: string) => void): void;
  onAvatar(cb: (config: AvatarConfig) => void): void;
  onContrast(cb: (contrast: FaceContrast) => void): void;
  onGlare(cb: (msg: { lightDx: number }) => void): void;
  /** Flying across the screen: direction and speed (-1..1), `landed` at the end of a flight. */
  onTravel(cb: (msg: { vx: number; vy: number; landed: boolean }) => void): void;
  /** Leaving for the phone or coming back, at a point of the window. */
  onTransit(cb: (msg: { kind: "out" | "in" | "reset"; x: number; y: number }) => void): void;
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
  onAudioLocal(cb: (msg: { local: boolean }) => void): void;
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
  /** setup: the installed app has no Python environment yet (setup/runtime.ts). */
  state: "off" | "setup" | "starting" | "ready" | "error";
  message: string;
  engines: EngineStatus[];
  gpu: GpuInfo | null;
  /** Engine packages installed in the sidecar environment. */
  installed: string[];
}

// ---------------- settings window ----------------

/** The installed app's voice engine setup (main/setup): dev = development, nothing to install. */
export interface RuntimeSetupState {
  phase: "dev" | "missing" | "outdated" | "installing" | "starting" | "models" | "ready" | "error";
  /** Extras of the sidecar the profile needs (gpu, wakeword). */
  extras: string[];
  /** Packages: bytes downloaded of those announced by uv. */
  downloaded: number;
  total: number;
  detail: string;
  /** Models downloaded since the engines started. */
  modelsMb: number;
}

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
  /** Installing the voice engine (installed app only). */
  setup: RuntimeSetupState;
  voices: Partial<Record<TtsEngine, string[]>>;
  /** Voices Lumi recognizes (no voiceprints: they never leave the main process). */
  knownVoices: KnownVoice[];
  /** Listened apps and their state ("in ascolto", "chiusa", "errore: ..."). */
  appAudioStatus: Record<string, string>;
  discord: { state: string; detail: string; token: "env" | "saved" | "none" };
  /** The memory's embedding queue: how much has vectors of the chosen model. */
  memoryIndex: MemoryIndexStatus | null;
  /** Habits found (phase 11), archived ones included. */
  habits: HabitInfo[];
  /** Where the 3D avatar's extra gesture clips go, and the ones found there. */
  avatarClips: { dir: string; names: string[] };
  /** Today's mood (null when the mood of the day is off). */
  dayMood: { mood: DayMoodId; rolled: DayMoodId; intensity: number; since: string; changes: { at: string; from: DayMoodId; to: DayMoodId; intensity: number }[] } | null;
  /** The phone link: paired phones (no keys), the server and the call. */
  phone: { listening: boolean; devices: { id: string; name: string; paired: string; lastSeen?: string }[]; call: string; phoneName: string };
}

/** A memory the user may choose to forget (memory/db.ts ForgetItem). */
export interface ForgetCandidate {
  type: "message" | "summary" | "fact";
  id: number;
  at: string;
  text: string;
  label: string;
  /** A clear match: selected by default. */
  strong: boolean;
}

export interface HabitInfo {
  id: number;
  name: string;
  confidence: number;
  status: "active" | "archived";
  /** Lumi does it by itself (the user allowed it), instead of asking. */
  auto: boolean;
  accepted: number;
  rejected: number;
}

export interface MemoryIndexStatus {
  state: "off" | "unavailable" | "idle" | "indexing" | "waiting" | "missing" | "offline" | "error";
  model: string;
  source?: "ollama" | "sidecar";
  done: number;
  total: number;
  detail?: string;
}

/** auto: Ollama's web search with the Ollama Cloud key, else DuckDuckGo. */
export const WEB_PROVIDERS = ["auto", "ollama", "duckduckgo", "searxng", "none"] as const;
export type WebProvider = (typeof WEB_PROVIDERS)[number];

/** auto: Ollama when it is installed, else the sidecar on the CPU (roadmap 10.6). */
export const EMBEDDING_PROVIDERS = ["auto", "ollama", "sidecar", "none"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export interface KnownVoice {
  id: string;
  label: string;
  owner: boolean;
  via: string[];
  samples: number;
  lastHeard: string;
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
  /** Local models that can see (Ollama: only those with the vision capability). */
  listVisionModels(provider: VisionProvider): Promise<{ ok: boolean; models: string[]; message: string }>;
  testVoice(text: string): Promise<ConnectionReport>;
  applyProfile(profile: Profile): Promise<SettingsSnapshot>;
  pickVoiceFile(): Promise<string | null>;
  /** Deletes a fact, a note or a pending reminder. */
  forgetMemory(id: string): Promise<SettingsSnapshot>;
  clearMemory(): Promise<SettingsSnapshot>;
  forgetVoice(id: string): Promise<SettingsSnapshot>;
  /** Saves the Discord bot token (empty: removes it). */
  setDiscordToken(token: string): Promise<SettingsSnapshot>;
  openDataFolder(): Promise<void>;
  restartSidecar(): Promise<SettingsSnapshot>;
  installRuntime(): Promise<SettingsSnapshot>;
  /** What Lumi remembers about `query`, to choose what to forget (nothing is deleted). */
  findForget(query: string): Promise<ForgetCandidate[]>;
  /** Forgets the chosen items, with everything that depends on them. */
  forgetItems(selection: { messages: number[]; summaries: number[]; facts: number[] }): Promise<{ ok: boolean; message: string; snapshot: SettingsSnapshot }>;
  onStatus(cb: (status: SidecarStatus) => void): void;
  onSetup(cb: (state: RuntimeSetupState) => void): void;
  /** A new phone pairing: the link and its QR code (an image data URL), valid 5 minutes. */
  phonePair(): Promise<{ ok: boolean; url: string; qr: string; hosts: string[]; message: string }>;
  phoneRevoke(id: string): Promise<SettingsSnapshot>;
  /** A habit: let Lumi do it by itself, ask first again, or forget it. */
  habit(id: number, action: "auto" | "ask" | "forget"): Promise<SettingsSnapshot>;
  /** Draws today's mood again. */
  rerollMood(): Promise<SettingsSnapshot>;
  /** A VRM file for the 3D avatar, or null when cancelled. */
  pickModelFile(): Promise<string | null>;
  /** Something changed outside the window (a phone was paired): reload. */
  onRefresh(cb: () => void): void;
  /** Lumi asked to forget something: the Memory tab opens on it. */
  onForgetQuery(cb: (query: string) => void): void;
}
