// The conversation's turn-taking: idle -> listening -> thinking -> speaking.
//
// Speech reaches the speech recognizer either while push-to-talk is held,
// or (with the wake word, continuous listening, during the follow-up window
// after an answer, or while Lumi talks) from every speech start the VAD
// detects. The end of a turn combines the VAD silence with a semantic check
// (endpoint.ts). If the user speaks over Lumi for more than ~300 ms
// (barge-in), the voice and the model stop and the new utterance is heard.
//
// Wake word mode: with openWakeWord available (sidecar /wake), speech goes
// only to the wake word detector until the name is heard; then the last
// 1.5 s plus what follows reach the speech recognizer, so nothing said
// before the name is ever transcribed. Without it, every utterance is
// transcribed and the name is spotted in the text (wakeWord.ts).
import type { ListenMode, MicControl, MicEvent, Settings } from "../../shared/types";
import type { Opened } from "./addressing";
import { meaningless, requiredSilenceMs, silenceRange } from "./endpoint";
import type { SttFinal, SttHandlers } from "./sttClient";
import { matchWakeWord } from "./wakeWord";
import { PcmRing, WakeSpotter } from "./wakeSpotter";

/** A speech recognizer: the sidecar (streaming, partials) or a remote service. */
export interface SttBackend {
  readonly partials: boolean;
  start(id: number, options: { vocabulary: string[]; partials: boolean; voiceprint?: boolean }, handlers: SttHandlers): boolean;
  audio(id: number, pcm: Uint8Array): void;
  end(id: number): void;
  cancel(id: number): void;
}

/** openWakeWord in the sidecar: scores come back through TurnManager.wakeScores(). */
export interface WakeBackend {
  /** A new speech segment begins. */
  reset(): void;
  audio(pcm: Uint8Array): void;
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
  /**
   * The user said something that may be for Lumi (with the voiceprint, when voices are recognized).
   * `opened`: how the turn began; the hotkey and the name are explicit, with open listening the
   * sentence still has to be judged (addressing.ts).
   */
  utterance(text: string, voiceprint?: number[], opened?: Opened): void;
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
  /** The user is in a call Lumi listens to: "continuous" then waits for the wake word (they talk to their friends). */
  inCall?(): boolean;
  /** The wake word detector, when ready (else the name is spotted in transcripts). */
  wake?(): WakeBackend | null;
  /** The wake word may listen now: not with the screen locked or while another app records (a call). */
  wakeAllowed?(): boolean;
  log?(message: string): void;
}

interface Session {
  id: number;
  startedAt: number;
  viaPtt: boolean;
  /** Opened by the wake word detector: the name is (probably) at the start. */
  viaWake: boolean;
  /** Wake word heard, follow-up window or continuous mode: this utterance is for Lumi. */
  addressed: boolean;
  /** What made this turn open: the key, the name, a barge-in, open listening, the window after an answer. */
  opened: Opened;
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
const WAKE_WINDOW_MS = 5000;
const MAX_TURN_MS = 60_000;
/** After a speech segment ends, the wake word detector's last scores may still arrive this late. */
const WAKE_LATE_MS = 400;

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
  /** Speech is being checked for the wake word (no transcription yet). */
  private spotting = false;
  private readonly spotter = new WakeSpotter();
  private readonly ring = new PcmRing();
  /** The VAD hears speech right now. */
  private vadSpeech = false;
  /** Counts the segments checked for the wake word (a late stop must not end a newer one). */
  private segment = 0;

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

  /** openWakeWord scores for the speech sent with WakeBackend.audio(), in order. */
  wakeScores(scores: number[]): void {
    if (!this.spotting || this.session) return;
    const speaking = this.host.speaking();
    if (!this.spotter.push(scores, this.host.settings().listen.wakeThreshold, speaking)) return;
    this.spotting = false;
    this.host.log?.("Wake word heard");
    // Calling Lumi by name while it talks interrupts it
    if (speaking) this.host.interrupt();
    const s = this.open({ viaPtt: false, addressed: true, overLumi: false, viaWake: true, opened: "name" });
    if (!s) return;
    s.confirmed = true;
    // The name and what was said with it, then the rest live
    for (const chunk of this.ring.take()) this.onFrame(chunk);
    if (!this.vadSpeech) {
      s.speechActive = false;
      s.silenceSince = this.clock.now();
      this.scheduleEndCheck(s);
    }
    this.listen(true);
    this.refresh();
  }

  get listening(): boolean {
    return this.session !== null && (this.session.addressed || this.session.viaPtt);
  }

  // ---------------- inputs ----------------

  pttDown(): void {
    if (!this.host.stt()) return;
    this.pttHeld = true;
    if (this.host.speaking()) this.host.interrupt();
    this.stopSpotting();
    if (this.session && !this.session.viaPtt) {
      // Already capturing (follow-up or barge-in): keep it, now driven by the key
      this.session.viaPtt = true;
      this.session.addressed = true;
      this.session.opened = "ptt";
      this.clearEndTimer(this.session);
    } else if (!this.session) {
      this.open({ viaPtt: true, addressed: true, overLumi: false, viaWake: false, opened: "ptt" });
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
    const mode: ListenMode = this.mode();
    const available = this.host.stt() !== null;
    const speaking = this.host.speaking();
    const bargeIn = settings.listen.bargeIn && speaking;
    // The wake word sleeps with the screen locked and during other apps' calls
    const alwaysOn = mode === "continuous" || (mode === "wake-word" && (this.host.wakeAllowed?.() ?? true));
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

  private open(flags: { viaPtt: boolean; addressed: boolean; overLumi: boolean; viaWake: boolean; opened: Opened }): Session | null {
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
    const { stt: sttSettings, voices } = this.host.settings();
    const ok = stt.start(s.id, { vocabulary: sttSettings.vocabulary, partials: stt.partials, voiceprint: voices.enabled }, {
      partial: (text) => this.onPartial(s, text),
      final: (result) => this.onFinal(s, result),
    });
    if (!ok) return null;
    this.session = s;
    return s;
  }

  private onSpeechStart(): void {
    this.vadSpeech = true;
    const s = this.session;
    if (s) {
      // The user started again within the end-of-turn wait: same turn
      s.speechActive = true;
      s.silenceSince = null;
      this.clearEndTimer(s);
      return;
    }
    const mode = this.mode();
    const speaking = this.host.speaking();
    const overLumi = speaking && this.host.settings().listen.bargeIn;
    const addressed = mode === "continuous" || this.followUp() || overLumi;
    if (!addressed && mode !== "wake-word") return;
    if (!addressed) {
      if (!(this.host.wakeAllowed?.() ?? true)) return;
      const wake = this.host.wake?.();
      if (wake) {
        // Only the wake word detector hears this, until the name is said
        this.spotting = true;
        this.segment++;
        this.spotter.reset();
        this.ring.clear();
        wake.reset();
        return;
      }
    }
    // The name alone just opened a window for the request: that is an invitation, not a guess
    const opened: Opened = overLumi ? "barge" : this.clock.now() < this.wakeUntil ? "name" : this.followUp() ? "followup" : "open";
    this.open({ viaPtt: false, addressed, overLumi, viaWake: false, opened });
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
    if (!s && this.spotting) {
      const wake = this.host.wake?.();
      if (!wake) return this.stopSpotting();
      this.ring.push(pcm);
      wake.audio(pcm);
      return;
    }
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
    this.vadSpeech = false;
    // A late score may still name Lumi: the detector gets a moment before the segment is dropped
    if (this.spotting) {
      const segment = this.segment;
      this.clock.setTimeout(() => {
        if (this.segment === segment) this.stopSpotting();
      }, WAKE_LATE_MS);
    }
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
    this.vadSpeech = false;
    this.stopSpotting();
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
      s.opened = "name";
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
    if (this.silenceNeeded(s) < silenceRange(this.host.settings().listen.pauseMs).max) return;
    s.lastBackchannel = now;
    this.host.backchannel();
  }

  private scheduleEndCheck(s: Session): void {
    this.clearEndTimer(s);
    if (s.silenceSince === null) return;
    const due = s.silenceSince + this.silenceNeeded(s);
    const wait = Math.max(0, due - this.clock.now());
    s.endTimer = this.clock.setTimeout(() => {
      s.endTimer = null;
      if (this.session !== s || s.speechActive || s.silenceSince === null) return;
      if (this.clock.now() >= s.silenceSince + this.silenceNeeded(s)) this.finish(s);
      else this.scheduleEndCheck(s);
    }, wait);
  }

  private silenceNeeded(s: Session): number {
    return requiredSilenceMs(s.partial, s.turnComplete, this.host.settings().listen.pauseMs);
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
    if (s.viaWake) {
      // The detector heard the name: drop it from the request; the name alone waits for the request
      const wake = matchWakeWord(text, settings.listen.wakeWord);
      if (wake.matched) text = wake.rest;
      if (!text || meaningless(text)) return this.awaitRequest();
    } else if (!s.viaPtt && this.mode() === "wake-word" && !s.addressed) {
      const wake = matchWakeWord(text, settings.listen.wakeWord);
      if (!wake.matched) return this.refresh();
      s.opened = "name";
      text = wake.rest;
      if (!text || meaningless(text)) return this.awaitRequest();
    } else if (this.mode() === "wake-word" && !s.viaPtt) {
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
    // The name heard in the transcript (wake-word mode without the detector) counts as the name
    const opened: Opened = s.viaPtt ? "ptt" : s.viaWake ? "name" : s.opened;
    this.host.utterance(text, result.voiceprint, opened);
    this.refresh();
  }

  /** Just the name: a short "sì?" and a few seconds for the request, then back to rest. */
  private awaitRequest(): void {
    this.wakeUntil = this.clock.now() + WAKE_WINDOW_MS;
    this.listen(true);
    this.host.acknowledge?.();
    this.clock.setTimeout(() => {
      if (!this.session && this.clock.now() >= this.wakeUntil) this.listen(false);
    }, WAKE_WINDOW_MS + 50);
    this.refresh();
  }

  private stopSpotting(): void {
    if (!this.spotting) return;
    this.spotting = false;
    this.ring.clear();
  }

  /** The listening mode in effect: during a call, "continuous" becomes "wake-word". */
  private mode(): ListenMode {
    const mode = this.host.settings().listen.mode;
    return mode === "continuous" && this.host.inCall?.() ? "wake-word" : mode;
  }

  private clearEndTimer(s: Session): void {
    if (s.endTimer !== null) this.clock.clearTimeout(s.endTimer);
    s.endTimer = null;
  }
}
