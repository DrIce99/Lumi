// Lumi's voice as the rest of the app sees it: whether it can speak right
// now, a speech sink for each moment, one-shot lines (reminders, tests),
// and the sidecar configuration that follows the settings.
import type { Emotion } from "../../shared/emotions";
import type { EngineStatus, PlaybackEvent, Settings } from "../../shared/types";
import { log } from "../log";
import type { Sidecar } from "../sidecar";
import type { FaceWindow } from "../window";

/** Where Lumi's audio goes: the face window, and with it a Discord call when one is joined. */
export type AudioOut = Pick<FaceWindow, "audioBegin" | "audioChunk" | "audioEnd" | "audioStop">;
import { VoiceSpeech, type Sentence, type SpeechReactions } from "./speechOut";
import { TtsClient } from "./ttsClient";

export interface VoiceHooks {
  sentenceStart(sentence: Sentence): void;
  speaking(active: boolean): void;
  fallback(text: string): void;
}

/** What the sidecar should load for these settings. */
export function sidecarConfig(settings: Settings, preload: boolean): Record<string, unknown> {
  return {
    tts: { engine: settings.tts.engine, model: settings.tts.model, voice: settings.tts.voice, speed: settings.tts.speed, seed: settings.tts.seed, device: "auto" },
    stt: { engine: settings.stt.engine, model: settings.stt.model, device: settings.stt.device, language: "it" },
    ocr: { enabled: settings.perception.enabled, engine: settings.perception.ocr },
    uia: { enabled: settings.perception.enabled && settings.perception.uia },
    preload,
  };
}

export class Voice {
  readonly tts: TtsClient;
  private readonly active = new Set<VoiceSpeech>();
  private nextId = 1;
  private lastConfig = "";
  /** The sidecar got the engine choice (OCR and STT may be used). */
  configured = false;

  constructor(
    private readonly sidecar: Sidecar,
    private readonly face: AudioOut,
    private readonly settings: () => Settings,
    private readonly hooks: VoiceHooks,
  ) {
    this.tts = new TtsClient(() => sidecar.socketUrl("/tts"));
    sidecar.on("ready", () => {
      this.lastConfig = "";
      this.configured = false;
      void this.configure();
    });
    sidecar.on("down", () => {
      this.configured = false;
      this.stopAll();
    });
  }

  /** The TTS engine, as reported by the sidecar. */
  engine(): EngineStatus | null {
    return this.sidecar.status().engines.find((e) => e.kind === "tts") ?? null;
  }

  /** A fresh id for audio sent to the face window (sentences and clips share them). */
  allocateId(): number {
    return this.nextId++;
  }

  /** Lumi can speak aloud right now. */
  ready(): boolean {
    return !this.settings().muted && this.sidecar.endpoint() !== null && this.engine()?.state === "ready";
  }

  /** Something is being said or is about to be. */
  busy(): boolean {
    return [...this.active].some((s) => s.sentences.some((x) => x.state === "synth" || x.state === "playing"));
  }

  /** Sends the engine choice to the sidecar (only when it changed). */
  async configure(): Promise<void> {
    if (!this.sidecar.endpoint()) return;
    const config = sidecarConfig(this.settings(), true);
    const key = JSON.stringify(config);
    if (key === this.lastConfig) return;
    this.lastConfig = key;
    try {
      await this.sidecar.request("/config", config, 15_000);
      this.configured = true;
      log.info(`Sidecar configured: tts ${this.settings().tts.engine}/${this.settings().tts.model}, stt ${this.settings().stt.engine}`);
    } catch (err) {
      this.lastConfig = "";
      log.warn("Configuring the sidecar failed", err);
    }
  }

  /** A sink that speaks one moment. */
  speech(): VoiceSpeech {
    const reactions: SpeechReactions = {
      sentenceStart: (s) => this.hooks.sentenceStart(s),
      speaking: (active) => this.updateSpeaking(active),
      fallback: (text) => this.hooks.fallback(text),
      timing: (s, done) => {
        if (!done.cancelled && !done.error) log.info(`TTS #${s.id}: first audio ${done.firstMs} ms, ${done.audioMs} ms of audio in ${done.ms} ms`);
        log.perception(`TTS #${s.id} (${s.emotion}): ${s.text}`);
      },
    };
    const speech = new VoiceSpeech(
      {
        speak: (request, handlers) => this.tts.speak(request, handlers),
        cancel: (id) => this.tts.cancel(id),
        begin: (msg) => this.face.audioBegin(msg),
        chunk: (id, pcm, sampleRate) => this.face.audioChunk({ id, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer, sampleRate }),
        end: (id) => this.face.audioEnd(id),
        stop: (fadeMs) => this.face.audioStop(fadeMs),
      },
      reactions,
      () => this.nextId++,
      { volume: this.settings().tts.volume },
    );
    this.active.add(speech);
    void speech.done().then(() => this.active.delete(speech));
    return speech;
  }

  /** A complete line, spoken aloud (reminders, tests, debug). */
  async say(text: string, emotion: Emotion = "neutra", intensity = 0.6): Promise<{ text: string; interrupted: boolean }> {
    const speech = this.speech();
    speech.final([{ text, emotion, intensity }]);
    return speech.done();
  }

  playback(event: PlaybackEvent): void {
    for (const speech of this.active) if (speech.playback(event)) return;
  }

  /** Barge-in or shutdown: everything stops with a short fade. */
  stopAll(): void {
    for (const speech of [...this.active]) speech.abort();
    this.tts.cancel("all");
  }

  private speakingCount = 0;

  private updateSpeaking(active: boolean): void {
    this.speakingCount = Math.max(0, this.speakingCount + (active ? 1 : -1));
    this.hooks.speaking(this.speakingCount > 0);
  }
}
