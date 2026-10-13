// A moment's speech, spoken: the say calls stream in, the chunker cuts them
// into sentences, each sentence goes to the TTS as soon as it is complete,
// its audio streams to the face window, and playback reports back. The
// emotion and gaze of each sentence are applied when it starts playing.
// Interrupted speech reports only what the user actually heard.
import { clampIntensity, toEmotion, type Emotion } from "../../shared/emotions";
import type { AudioBegin, PlaybackEvent } from "../../shared/types";
import type { SayCall, SpeechSink } from "../brain/brain";
import type { LiveSay } from "../brain/providers/types";
import { log } from "../log";
import { DEFAULT_CHUNKER, SentenceChunker } from "./chunker";
import type { SpeakRequest, TtsDone, TtsHandlers } from "./ttsClient";

export interface VoiceOutput {
  /** Starts synthesis; false when the TTS is unavailable. */
  speak(request: SpeakRequest, handlers: TtsHandlers): boolean;
  cancel(id: number | "all"): void;
  /** The face window plays the audio. */
  begin(msg: AudioBegin): void;
  chunk(id: number, pcm: Uint8Array, sampleRate: number): void;
  end(id: number): void;
  /** Fades out everything playing or queued. */
  stop(fadeMs: number): void;
}

export interface SpeechReactions {
  /** A sentence starts playing. */
  sentenceStart(sentence: Sentence): void;
  /** The speech started or ended (face talking, listening for barge-in). */
  speaking(active: boolean): void;
  /** A sentence couldn't be spoken: show it as text. */
  fallback(text: string): void;
  /** Synthesis timing, for the logs. */
  timing?(sentence: Sentence, done: TtsDone): void;
}

export interface Sentence {
  id: number;
  text: string;
  emotion: Emotion;
  intensity: number;
  look?: string;
  /** The say call it belongs to. */
  say: number;
  state: "synth" | "playing" | "played" | "failed" | "cancelled";
  synthDone: boolean;
  totalMs: number;
  playedMs: number;
}

/** The part of a sentence heard before an interruption, cut at a word boundary. */
export function heardPart(text: string, playedMs: number, totalMs: number): string {
  if (totalMs <= 0 || playedMs >= totalMs) return text;
  if (playedMs <= 0) return "";
  const target = Math.floor(text.length * (playedMs / totalMs));
  const cut = text.lastIndexOf(" ", target);
  return cut > 0 ? text.slice(0, cut).trim() : "";
}

interface SayState {
  chunker: SentenceChunker;
  /** The text given to the chunker so far. */
  fed: string;
  emotion?: Emotion;
  intensity: number;
  look?: string;
  /** Sentences waiting for the emotion (it normally arrives before the text). */
  waiting: string[];
  complete: boolean;
}

export class VoiceSpeech implements SpeechSink {
  readonly sentences: Sentence[] = [];
  private readonly says: SayState[] = [];
  private finished = false;
  private aborted = false;
  private speakingNow = false;
  private resolveDone!: (heard: { text: string; interrupted: boolean }) => void;
  private readonly heard: Promise<{ text: string; interrupted: boolean }>;

  constructor(
    private readonly out: VoiceOutput,
    private readonly react: SpeechReactions,
    private readonly nextId: () => number,
    private readonly options: { volume: number; voice?: string } = { volume: 1 },
  ) {
    this.heard = new Promise((resolve) => (this.resolveDone = resolve));
  }

  live(says: LiveSay[]): void {
    if (this.aborted || this.finished) return;
    says.forEach((say, index) => this.feed(index, say, false));
  }

  final(says: SayCall[]): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.aborted) says.forEach((say, index) => this.feed(index, { ...say, complete: true }, true));
    this.checkDone();
  }

  done(): Promise<{ text: string; interrupted: boolean }> {
    return this.heard;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const s of this.sentences) {
      if (s.state === "synth" || s.state === "playing") this.out.cancel(s.id);
      if (s.state === "synth") s.state = "cancelled";
    }
    this.out.stop(80);
    // Playback "end" events report how much of the playing sentence was heard
    setTimeout(() => this.settle(true), 150);
  }

  /** Playback events from the face window. */
  playback(event: PlaybackEvent): boolean {
    const s = this.sentences.find((x) => x.id === event.id);
    if (!s) return false;
    // A sentence shown as text instead has nothing more to report
    if (s.state === "failed") return true;
    if (event.type === "start") {
      if (s.state === "synth") s.state = "playing";
      if (!this.speakingNow) {
        this.speakingNow = true;
        this.react.speaking(true);
      }
      this.react.sentenceStart(s);
    } else {
      s.totalMs = event.totalMs;
      s.playedMs = event.playedMs;
      s.state = event.interrupted ? "cancelled" : "played";
      this.checkDone();
    }
    return true;
  }

  /** What was heard so far (complete sentences plus the heard part of an interrupted one). */
  heardText(): string {
    return this.sentences
      .map((s) => (s.state === "played" ? s.text : s.state === "cancelled" ? heardPart(s.text, s.playedMs, s.totalMs) : ""))
      .filter(Boolean)
      .join(" ");
  }

  private feed(index: number, say: LiveSay, final: boolean): void {
    let state = this.says[index];
    if (!state) {
      state = { chunker: new SentenceChunker(index === 0 ? DEFAULT_CHUNKER : { ...DEFAULT_CHUNKER, firstCommaAfter: DEFAULT_CHUNKER.commaAfter }), fed: "", intensity: 0.6, waiting: [], complete: false };
      this.says[index] = state;
    }
    if (state.complete) return;
    if (say.emotion && !state.emotion) state.emotion = toEmotion(say.emotion) ?? "neutra";
    if (say.intensity !== undefined) state.intensity = clampIntensity(say.intensity);
    if (say.look) state.look = say.look;
    const text = say.text;
    const sentences: string[] = [];
    if (!text.startsWith(state.fed)) {
      // Streamed text only grows; if a provider rewrote it anyway, what isn't spoken yet follows the new version
      log.warn("Streamed speech was rewritten while being spoken");
      const spoken = state.fed.slice(0, state.fed.length - state.chunker.pending().length);
      state.chunker.discardPending();
      state.fed = text.startsWith(spoken) ? spoken : text.slice(0, Math.min(spoken.length, text.length));
    }
    if (text.length > state.fed.length) sentences.push(...state.chunker.push(text.slice(state.fed.length)));
    state.fed = text;
    if (say.complete || final) {
      state.complete = true;
      sentences.push(...state.chunker.flush());
      // The emotion is part of a complete call; a model that left it out speaks neutrally
      state.emotion ??= "neutra";
    }
    state.waiting.push(...sentences);
    if (!state.emotion) return;
    for (const sentence of state.waiting.splice(0)) this.speak(index, sentence, state);
  }

  private speak(say: number, text: string, state: SayState): void {
    const sentence: Sentence = {
      id: this.nextId(),
      text,
      emotion: state.emotion ?? "neutra",
      intensity: state.intensity,
      look: state.look,
      say,
      state: "synth",
      synthDone: false,
      totalMs: 0,
      playedMs: 0,
    };
    this.sentences.push(sentence);
    this.out.begin({ id: sentence.id, kind: "speech", text, emotion: sentence.emotion, intensity: sentence.intensity, volume: this.options.volume });
    const ok = this.out.speak(
      { id: sentence.id, text, emotion: sentence.emotion, intensity: sentence.intensity, voice: this.options.voice },
      {
        chunk: (pcm, rate) => {
          if (!this.aborted) this.out.chunk(sentence.id, pcm, rate);
        },
        done: (info) => {
          sentence.synthDone = true;
          this.react.timing?.(sentence, info);
          if (info.error && !this.aborted) {
            log.warn(`Speech synthesis failed: ${info.error}`);
            if (sentence.state === "synth") {
              sentence.state = "failed";
              this.react.fallback(text);
            }
          }
          this.out.end(sentence.id);
          this.checkDone();
        },
      },
    );
    if (!ok) {
      sentence.state = "failed";
      sentence.synthDone = true;
      this.out.end(sentence.id);
      this.react.fallback(text);
    }
  }

  private checkDone(): void {
    if (!this.finished && !this.aborted) return;
    const open = this.sentences.some((s) => s.state === "synth" || s.state === "playing");
    if (!open) this.settle(this.aborted);
  }

  private settle(interrupted: boolean): void {
    if (this.speakingNow) {
      this.speakingNow = false;
      this.react.speaking(false);
    }
    const failed = this.sentences.filter((s) => s.state === "failed").map((s) => s.text);
    const heard = [this.heardText(), ...failed].filter(Boolean).join(" ");
    this.resolveDone({ text: heard, interrupted: interrupted && heard.length > 0 });
  }
}
