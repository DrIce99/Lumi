// Persistent user settings (non-secret), in %APPDATA%\Lumi\settings.json.
// API keys live in secrets.ts.
import { join } from "node:path";
import { DEFAULT_OLLAMA_URL, isProvider, PROVIDERS, type ProviderId } from "../shared/providers";
import {
  DEFAULT_SETTINGS,
  DEVICES,
  LISTEN_MODES,
  OCR_ENGINES,
  PROFILES,
  SCREENSHOT_POLICIES,
  SOCIABILITY,
  STT_ENGINES,
  TTS_ENGINES,
  type BrainChoice,
  type Settings,
} from "../shared/types";
import { readJson, writeJson } from "./jsonStore";

type Listener = (next: Settings, prev: Settings) => void;

/** A partial update: nested groups may be partial too. */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? (Settings[K] extends unknown[] ? Settings[K] : Partial<Settings[K]>) : Settings[K] };

export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<Listener>();
  private readonly file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, "settings.json") : null;
    this.current = sanitizeSettings((this.file && readJson<unknown>(this.file)) || {});
  }

  get(): Settings {
    return this.current;
  }

  update(patch: SettingsPatch): Settings {
    const prev = this.current;
    const merged: Record<string, unknown> = { ...prev };
    for (const [key, value] of Object.entries(patch)) {
      const old = (prev as unknown as Record<string, unknown>)[key];
      merged[key] = value && typeof value === "object" && !Array.isArray(value) && old && typeof old === "object" ? { ...old, ...value } : value;
    }
    this.current = sanitizeSettings(merged);
    if (this.file) writeJson(this.file, this.current);
    for (const listener of this.listeners) listener(this.current, prev);
    return this.current;
  }

  /** Replaces everything (settings window save). */
  replace(next: unknown): Settings {
    const prev = this.current;
    this.current = sanitizeSettings(next);
    if (this.file) writeJson(this.file, this.current);
    for (const listener of this.listeners) listener(this.current, prev);
    return this.current;
  }

  onChange(listener: Listener): void {
    this.listeners.add(listener);
  }
}

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown, fallback: string, max: number) => (typeof v === "string" ? v.slice(0, max) : fallback);
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback;
const strings = (v: unknown, fallback: string[], maxItems: number, maxLength: number) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems)
    : fallback;
const color = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toUpperCase() : fallback);

function brainChoice(v: unknown, fallback: BrainChoice, allowEmptyModel = false): BrainChoice {
  const o = obj(v);
  const provider: ProviderId = isProvider(o.provider) ? o.provider : fallback.provider;
  const model = str(o.model, fallback.model, 200).trim();
  // An empty model falls back to the service's first suggestion
  return { provider, model: model || (allowEmptyModel ? "" : PROVIDERS[provider].suggestions[0] || (provider === fallback.provider ? fallback.model : "")) };
}

/** Fills defaults and clamps values coming from disk or from the settings window. */
export function sanitizeSettings(input: unknown): Settings {
  const raw = obj(input);
  const d = DEFAULT_SETTINGS;
  const brain = obj(raw.brain);
  const stt = obj(raw.stt);
  const tts = obj(raw.tts);
  const listen = obj(raw.listen);
  const face = obj(raw.face);
  const perception = obj(raw.perception);
  return {
    profile: oneOf(raw.profile, PROFILES, d.profile),
    userName: str(raw.userName, d.userName, 50).trim(),
    personality: str(raw.personality, d.personality, 2000),
    brain: {
      chat: brainChoice(brain.chat, d.brain.chat),
      idle: brainChoice(brain.idle, d.brain.idle),
      vision: brainChoice(brain.vision, d.brain.vision, true),
      ollamaUrl: str(brain.ollamaUrl, d.brain.ollamaUrl, 300).trim() || DEFAULT_OLLAMA_URL,
      customUrl: str(brain.customUrl, d.brain.customUrl, 300).trim(),
    },
    stt: {
      engine: oneOf(stt.engine, STT_ENGINES, d.stt.engine),
      model: str(stt.model, d.stt.model, 120).trim() || d.stt.model,
      device: oneOf(stt.device, DEVICES, d.stt.device),
      vocabulary: strings(stt.vocabulary, d.stt.vocabulary, 200, 60),
    },
    tts: {
      engine: oneOf(tts.engine, TTS_ENGINES, d.tts.engine),
      model: str(tts.model, d.tts.model, 120).trim() || d.tts.model,
      voice: str(tts.voice, d.tts.voice, 400).trim(),
      speed: Math.round(num(tts.speed, d.tts.speed, 0.7, 1.4) * 100) / 100,
      volume: Math.round(num(tts.volume, d.tts.volume, 0.1, 1) * 100) / 100,
      seed: Math.round(num(tts.seed, d.tts.seed, 0, 2 ** 31 - 1)),
    },
    listen: {
      mode: oneOf(listen.mode, LISTEN_MODES, d.listen.mode),
      hotkey: str(listen.hotkey, d.listen.hotkey, 60).trim(),
      wakeWord: str(listen.wakeWord, d.listen.wakeWord, 40).trim().toLowerCase() || d.listen.wakeWord,
      followUpSeconds: Math.round(num(listen.followUpSeconds, d.listen.followUpSeconds, 0, 60)),
      bargeIn: bool(listen.bargeIn, d.listen.bargeIn),
      backchannel: bool(listen.backchannel, d.listen.backchannel),
      fillers: bool(listen.fillers, d.listen.fillers),
      micDevice: str(listen.micDevice, d.listen.micDevice, 200),
    },
    face: {
      scale: Math.round(num(face.scale, d.face.scale, 0.5, 3) * 100) / 100,
      color: color(face.color, d.face.color),
      subtitles: bool(face.subtitles, d.face.subtitles),
    },
    perception: {
      enabled: bool(perception.enabled, d.perception.enabled),
      ocr: oneOf(perception.ocr, OCR_ENGINES, d.perception.ocr),
      captureFps: Math.round(num(perception.captureFps, d.perception.captureFps, 1, 10) * 10) / 10,
      ocrFps: Math.round(num(perception.ocrFps, d.perception.ocrFps, 0.2, 4) * 10) / 10,
      uia: bool(perception.uia, d.perception.uia),
      pauseInApps: strings(perception.pauseInApps, d.perception.pauseInApps, 100, 80),
      sendScreenshots: oneOf(perception.sendScreenshots, SCREENSHOT_POLICIES, d.perception.sendScreenshots),
    },
    sociability: oneOf(raw.sociability, SOCIABILITY, d.sociability),
    doNotDisturb: bool(raw.doNotDisturb, d.doNotDisturb),
    muted: bool(raw.muted, d.muted),
    chatHotkey: str(raw.chatHotkey, d.chatHotkey, 60).trim(),
    launchAtLogin: bool(raw.launchAtLogin, d.launchAtLogin),
    setupDone: bool(raw.setupDone, d.setupDone),
  };
}
