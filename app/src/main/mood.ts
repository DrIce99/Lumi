// The face's state as the main process sees it: the current emotion (set by
// what Lumi says, fading back to the resting face 1.5-3 s after the answer)
// plus the conversation flags (listening, thinking, speaking) and drowsiness.
// The resting face is neutral, or a trace of the mood of the day.
import { clampIntensity, type Emotion } from "../shared/emotions";
import type { FaceState } from "../shared/types";

export type MoodFlags = Pick<FaceState, "listening" | "thinking" | "speaking" | "drowsy">;

type Face = { emotion: Emotion; intensity: number };
const NEUTRAL: Face = { emotion: "neutra", intensity: 0.6 };

export class Mood {
  private emotion: Emotion = "neutra";
  private intensity = 0.6;
  private until = 0;
  /** An answer's emotion is showing (it expires back to `resting`). */
  private held = false;
  private resting: Face = NEUTRAL;
  private flags: MoodFlags = { listening: false, thinking: false, speaking: false, drowsy: false };
  private lastSent = "";
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly send: (state: FaceState) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random,
  ) {
    this.timer = setInterval(() => this.expire(), 250);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** Shows an emotion for `holdMs` (it stays while Lumi keeps talking). */
  setEmotion(emotion: Emotion, intensity: number, holdMs = 15_000): void {
    // A neutral line on a sad or angry day keeps the trace of the mood
    const face = emotion === "neutra" ? this.resting : { emotion, intensity: clampIntensity(intensity) };
    this.emotion = face.emotion;
    this.intensity = face.intensity;
    this.held = true;
    this.until = this.now() + holdMs;
    this.emit();
  }

  /** The face between answers (the mood of the day); null = neutral. */
  setResting(face: Face | null): void {
    this.resting = face ? { emotion: face.emotion, intensity: clampIntensity(face.intensity) } : NEUTRAL;
    if (!this.held) this.rest();
  }

  set(flags: Partial<MoodFlags>): void {
    this.flags = { ...this.flags, ...flags };
    // The emotion of an answer outlives the answer by 1.5-3 s only
    if (flags.speaking === false && this.held) this.until = this.now() + 1500 + this.random() * 1500;
    this.emit();
  }

  /** Lumi was interrupted: the emotion of the cut answer goes at once (the face listens). */
  clearEmotion(): void {
    this.until = 0;
    this.rest();
  }

  /** Runs the expiry check now (tests drive the clock). */
  tick(): void {
    this.expire();
  }

  state(): FaceState {
    return { expression: this.emotion, intensity: this.intensity, ...this.flags };
  }

  /** Re-sends the state (the renderer reloaded). */
  resend(): void {
    this.lastSent = "";
    this.emit();
  }

  private expire(): void {
    if (this.held && !this.flags.speaking && this.now() >= this.until) this.rest();
  }

  private rest(): void {
    this.held = false;
    this.emotion = this.resting.emotion;
    this.intensity = this.resting.intensity;
    this.emit();
  }

  private emit(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.send(state);
  }
}
