// The conversation's turn-taking: idle -> listening -> thinking -> speaking.
//
// Speech reaches the speech recognizer either while push-to-talk is held,
// or (with the wake word, continuous listening, during the follow-up window
// after an answer, or while Lumi talks) from every speech start the VAD
// detects. The end of a turn combines the VAD silence with a semantic check
// (endpoint.ts). If the user speaks over Lumi for more than ~300 ms
// (barge-in), the voice and the model stop and the new utterance is heard.
import type { ListenMode, MicControl, MicEvent, Settings } from "../../shared/types";
import { MAX_SILENCE_MS, meaningless, requiredSilenceMs } from "./endpoint";
import type { SttFinal, SttHandlers } from "./sttClient";
import { matchWakeWord } from "./wakeWord";

/** A speech recognizer: the sidecar (streaming, partials) or a remote service. */
export interface SttBackend {
  readonly partials: boolean;
  start(id: number, options: { vocabulary: string[]; partials: boolean }, handlers: SttHandlers): boolean;
  audio(id: number, pcm: Uint8Array): void;
  end(id: number): void;
  cancel(id: number): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface TurnHost {
  settings(): Settings;
  /** The speech recognizer to use now, or null when none is available. */
  stt(): SttBackend | null;
  micControl(control: MicControl): void;
  /** The user said something to Lumi. */
  utterance(text: string): void;
  /** Barge-in: stop the voice and the model now. */
  interrupt(): void;
  /** Lumi's voice is playing (or about to). */
  speaking(): boolean;
  setListening(listening: boolean): void;
  /** What Lumi said recently, to recognize its own voice coming back through the microphone. */
  recentSpeech(): string;
  /** Smart Turn: probability that the user finished their turn (null when unavailable). */
  turnComplete?(pcm: Uint8Array): Promise<number | null>;
  /** A short "mh" while the user pauses in a long turn (Lumi listening). */
  backchannel?(): void;
  /** The wake word alone was heard: a short "sì?" before the request. */
  acknowledge?(): void;
  log?(message: string): void;
}

interface Session {
  id: number;
  startedAt: number;
  viaPtt: boolean;
  /** Wake word heard, follow-up window or continuous mode: this utterance is for Lumi. */
  addressed: boolean;
  /** Started while Lumi was speaking: becomes a barge-in once the speech is confirmed. */
  overLumi: boolean;
  confirmed: boolean;
  speechActive: boolean;
  silenceSince: number | null;
  partial: string;
  turnComplete: number | null;
  endTimer: unknown;
  /** The last few seconds of audio, for Smart Turn. */
  recent: Uint8Array[];
  recentBytes: number;
  bytes: number;
  lastBackchannel: number;
  ending: boolean;
}

/** Bytes per second of 16 kHz PCM 16-bit. */
const BPS = 32_000;
const RECENT_BYTES = 8 * BPS;
const PTT_TAIL_MS = 150;
/** Silence that closes a VAD segment (the VAD's redemption time). */
const REDEMPTION_MS = 300;
/** A wake word alone opens a short window for the actual request. */
const WAKE_WINDOW_MS = 6000;
const MAX_TURN_MS = 60_000;

/** Lumi's own voice coming back through the microphone (speakers without headphones). */
export function isEcho(transcript: string, recent: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const heard = words(transcript);
  if (heard.length < 2) return false;
  const said = new Set(words(recent));
  const overlap = heard.filter((w) => said.has(w)).length / heard.length;
  return overlap >= 0.75;
}

export class TurnManager {
  private session: Session | null = null;
  private nextId = 1;
  private pttHeld = false;
  private followUpUntil = 0;
  private wakeUntil = 0;
  private lastControl = "";
  private wasSpeaking = false;
  private listeningOn = false;
  private ticker: unknown = null;

  constructor(
    private readonly host: TurnHost,
    private readonly clock: Clock = realClock,
  ) {
    // Follow-up windows expire by themselves: re-evaluate the microphone regularly
    const tick = () => {
      this.refresh();
      this.ticker = this.clock.setTimeout(tick, 250);
    };
    this.ticker = this.clock.setTimeout(tick, 250);
    this.refresh();
  }

  /** Tells the face whether Lumi is listening (only on changes). */
  private listen(on: boolean): void {
    if (on === this.listeningOn) return;
    this.listeningOn = on;
    this.host.setListening(on);
  }

  dispose(): void {
    this.clock.clearTimeout(this.ticker);
    if (this.session) this.drop(this.session);
    this.host.micControl({ ...this.control(), enabled: false });
  }

  get listening(): boolean {
    return this.session !== null && (this.session.addressed || this.session.viaPtt);
  }

  // ---------------- inputs ----------------

  pttDown(): void {
    if (!this.host.stt()) return;
    this.pttHeld = true;
    if (this.host.speaking()) this.host.interrupt();
    if (this.session && !this.session.viaPtt) {
      // Already capturing (follow-up or barge-in): keep it, now driven by the key
      this.session.viaPtt = true;
      this.session.addressed = true;
      this.clearEndTimer(this.session);
    } else if (!this.session) {
      this.open({ viaPtt: true, addressed: true, overLumi: false });
    }
    this.listen(true);
    this.refresh();
  }

  pttUp(): void {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    const s = this.session;
    if (s?.viaPtt) this.clock.setTimeout(() => this.finish(s), PTT_TAIL_MS);
    this.refresh();
  }

  mic(event: MicEvent): void {
    switch (event.type) {
      case "speech-start":
        this.onSpeechStart();
        break;
      case "speech-confirmed":
        this.onSpeechConfirmed();
        break;
      case "frame":
        this.onFrame(new Uint8Array(event.pcm));
        break;
      case "speech-end":
        this.onSpeechEnd();
        break;
      case "misfire":
        this.onMisfire();
        break;
      case "error":
        this.host.log?.(`Microphone error: ${event.message}`);
        break;
      case "ready":
        break;
    }
  }

  /** Lumi started or stopped talking. */
  speakingChanged(speaking: boolean): void {
    if (this.wasSpeaking && !speaking) {
      // After an answer, listen a little longer without hotkey or wake word
      const seconds = this.host.settings().listen.followUpSeconds;
      this.followUpUntil = seconds > 0 ? this.clock.now() + seconds * 1000 : 0;
    }
    this.wasSpeaking = speaking;
    this.refresh();
  }

  /** Mode or engines changed. */
  refresh(): void {
    const now = this.clock.now();
    const s = this.session;
    if (s && !s.ending && now - s.startedAt > MAX_TURN_MS) this.finish(s);
    const control = this.control();
    const key = JSON.stringify(control);
    if (key !== this.lastControl) {
      this.lastControl = key;
      this.host.micControl(control);
    }
  }

  // ---------------- microphone policy ----------------

  private followUp(): boolean {
    const now = this.clock.now();
    return now < this.followUpUntil || now < this.wakeUntil;
  }

  control(): MicControl {
    const settings = this.host.settings();
    const mode: ListenMode = settings.listen.mode;
    const available = this.host.stt() !== null;
    const speaking = this.host.speaking();
    const bargeIn = settings.listen.bargeIn && speaking;
    const alwaysOn = mode === "continuous" || mode === "wake-word";
    const enabled = available && (alwaysOn || this.pttHeld || bargeIn || this.followUp() || this.session !== null);
    return {
      enabled,
      forceStream: enabled && this.pttHeld,
      autoStream: enabled && (alwaysOn || bargeIn || this.followUp() || this.session !== null),
      strict: speaking,
      deviceId: settings.listen.micDevice,
      redemptionMs: REDEMPTION_MS,
    };
  }

  // ---------------- sessions ----------------

  private open(flags: { viaPtt: boolean; addressed: boolean; overLumi: boolean }): Session | null {
    const stt = this.host.stt();
    if (!stt) return null;
    const s: Session = {
      id: this.nextId++,
      startedAt: this.clock.now(),
      ...flags,
      confirmed: flags.viaPtt,
      speechActive: !flags.viaPtt,
      silenceSince: null,
      partial: "",
      turnComplete: null,
      endTimer: null,
      recent: [],
      recentBytes: 0,
      bytes: 0,
      lastBackchannel: 0,
      ending: false,
    };
    const vocabulary = this.host.settings().stt.vocabulary;
    const ok = stt.start(s.id, { vocabulary, partials: stt.partials }, {
      partial: (text) => this.onPartial(s, text),
      final: (result) => this.onFinal(s, result),
    });
    if (!ok) return null;
    this.session = s;
    return s;
  }

  private onSpeechStart(): void {
    const s = this.session;
    if (s) {
      // The user started again within the end-of-turn wait: same turn
      s.speechActive = true;
      s.silenceSince = null;
      this.clearEndTimer(s);
      return;
    }
    const mode = this.host.settings().listen.mode;
    const speaking = this.host.speaking();
    const overLumi = speaking && this.host.settings().listen.bargeIn;
    const addressed = mode === "continuous" || this.followUp() || overLumi;
    if (!addressed && mode !== "wake-word") return;
    this.open({ viaPtt: false, addressed, overLumi });
    if (addressed && !overLumi) this.listen(true);
    this.refresh();
  }

  private onSpeechConfirmed(): void {
    const s = this.session;
    if (!s) return;
    s.confirmed = true;
    if (s.overLumi && this.host.speaking()) {
      // Barge-in: the user talks over Lumi
      this.host.log?.("Barge-in: stopping the voice");
      this.host.interrupt();
      this.listen(true);
    }
  }

  private onFrame(pcm: Uint8Array): void {
    const s = this.session;
    if (!s || s.ending) return;
    const stt = this.host.stt();
    if (!stt) return;
    stt.audio(s.id, pcm);
    s.bytes += pcm.byteLength;
    s.recent.push(pcm);
    s.recentBytes += pcm.byteLength;
    while (s.recentBytes > RECENT_BYTES && s.recent.length > 1) s.recentBytes -= s.recent.shift()!.byteLength;
  }

  private onSpeechEnd(): void {
    const s = this.session;
    if (!s || s.viaPtt || s.ending) return;
    s.speechActive = false;
    // The VAD reports the end after its redemption time of silence
    s.silenceSince = this.clock.now() - REDEMPTION_MS;
    if (!s.confirmed) return;
    this.askTurnModel(s);
    this.maybeBackchannel(s);
    this.scheduleEndCheck(s);
  }

  private onMisfire(): void {
    const s = this.session;
    // Too short to be speech (a click, a cough): drop the session it opened
    if (s && !s.viaPtt && !s.confirmed && !s.ending) this.drop(s);
  }

  private onPartial(s: Session, text: string): void {
    if (s !== this.session) return;
    s.partial = text;
    // In wake-word mode the face starts listening as soon as the name is heard
    if (!s.addressed && matchWakeWord(text, this.host.settings().listen.wakeWord).matched) {
      s.addressed = true;
      this.listen(true);
    }
    if (s.silenceSince !== null) this.scheduleEndCheck(s);
  }

  private askTurnModel(s: Session): void {
    if (!this.host.turnComplete || !s.recent.length) return;
    const audio = new Uint8Array(s.recentBytes);
    let offset = 0;
    for (const part of s.recent) {
      audio.set(part, offset);
      offset += part.byteLength;
    }
    void this.host.turnComplete(audio).then((p) => {
      if (this.session !== s || s.ending) return;
      s.turnComplete = p;
      if (s.silenceSince !== null) this.scheduleEndCheck(s);
    });
  }

  private maybeBackchannel(s: Session): void {
    const now = this.clock.now();
    // Only in long turns, not too often, and only when the turn clearly goes on
    if (!this.host.backchannel || !s.addressed || now - s.startedAt < 4000 || now - s.lastBackchannel < 6000) return;
    if (requiredSilenceMs(s.partial, s.turnComplete) < MAX_SILENCE_MS) return;
    s.lastBackchannel = now;
    this.host.backchannel();
  }

  private scheduleEndCheck(s: Session): void {
    this.clearEndTimer(s);
    if (s.silenceSince === null) return;
    const due = s.silenceSince + requiredSilenceMs(s.partial, s.turnComplete);
    const wait = Math.max(0, due - this.clock.now());
    s.endTimer = this.clock.setTimeout(() => {
      s.endTimer = null;
      if (this.session !== s || s.speechActive || s.silenceSince === null) return;
      if (this.clock.now() >= s.silenceSince + requiredSilenceMs(s.partial, s.turnComplete)) this.finish(s);
      else this.scheduleEndCheck(s);
    }, wait);
  }

  private finish(s: Session): void {
    if (s.ending || this.session !== s) return;
    s.ending = true;
    this.clearEndTimer(s);
    this.session = null;
    this.host.stt()?.end(s.id);
    this.refresh();
  }

  private drop(s: Session): void {
    this.clearEndTimer(s);
    if (this.session === s) this.session = null;
    this.host.stt()?.cancel(s.id);
    if (!this.pttHeld) this.listen(false);
    this.refresh();
  }

  private onFinal(s: Session, result: SttFinal): void {
    if (!this.session || this.session === s) {
      if (this.session === s) this.session = null;
      if (!this.pttHeld) this.listen(false);
    }
    let text = result.text.trim();
    if (result.error) this.host.log?.(`Speech recognition failed: ${result.error}`);
    if (!text) return this.refresh();
    const settings = this.host.settings();
    if (!s.viaPtt && settings.listen.mode === "wake-word" && !s.addressed) {
      const wake = matchWakeWord(text, settings.listen.wakeWord);
      if (!wake.matched) return this.refresh();
      text = wake.rest;
      if (!text || meaningless(text)) {
        // Just the name: the request comes next
        this.wakeUntil = this.clock.now() + WAKE_WINDOW_MS;
        this.listen(true);
        this.host.acknowledge?.();
        this.clock.setTimeout(() => {
          if (!this.session && this.clock.now() >= this.wakeUntil) this.listen(false);
        }, WAKE_WINDOW_MS + 50);
        return this.refresh();
      }
    } else if (settings.listen.mode === "wake-word" && !s.viaPtt) {
      // Addressed by the wake word heard in a partial: drop the name from the request
      const wake = matchWakeWord(text, settings.listen.wakeWord);
      if (wake.matched) text = wake.rest || text;
    }
    if (meaningless(text)) return this.refresh();
    if (!s.viaPtt && isEcho(text, this.host.recentSpeech())) {
      this.host.log?.("Ignored an utterance that sounds like Lumi's own voice (echo)");
      return this.refresh();
    }
    this.followUpUntil = 0;
    this.wakeUntil = 0;
    this.host.utterance(text);
    this.refresh();
  }

  private clearEndTimer(s: Session): void {
    if (s.endTimer !== null) this.clock.clearTimeout(s.endTimer);
    s.endTimer = null;
  }
}
