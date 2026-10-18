// Text output: speech bubbles. Used when the voice is off or unavailable,
// for typed conversations with subtitles, and for system messages. Lines
// Lumi says on its own initiative wait for a pause in the user's typing.
import { clampIntensity, toEmotion, type Emotion } from "../shared/emotions";
import type { BubbleKind } from "../shared/types";
import type { SayCall, SpeechSink } from "./brain/brain";
import type { LiveSay } from "./brain/providers/types";
import type { FaceWindow } from "./window";

const PAUSE_SEC = 1.5;
const MAX_WAIT_MS = 20_000;

export function holdTime(text: string, expectsReply: boolean): number {
  return Math.min(45_000, Math.max(6000, 3500 + text.length * 60)) + (expectsReply ? 15_000 : 0);
}

export function expectsReply(text: string): boolean {
  return /\?[\s"»)]*$/u.test(text.trim());
}

export interface BubbleHandle {
  append(delta: string): void;
  /** Settles the bubble on the final text (empty hides it). */
  end(finalText: string): void;
}

export class Bubbles {
  private nextId = 1;
  private pending: { text: string; since: number } | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly questions = new Map<number, (choice: string | null) => void>();

  constructor(
    private readonly view: FaceWindow,
    private readonly idleSec: () => number,
    private readonly silenced: () => boolean,
  ) {
    this.timer = setInterval(() => this.deliverPending(), 500);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** A bubble filled while the text is still being generated. */
  start(kind: BubbleKind = "speech"): BubbleHandle {
    const id = this.nextId++;
    this.view.bubbleStart({ id, kind });
    let shown = "";
    return {
      append: (delta) => {
        shown += delta;
        this.view.bubbleChunk({ id, text: delta });
      },
      end: (finalText) => {
        if (finalText || shown) this.view.bubbleEnd({ id, finalText: finalText || shown, holdMs: holdTime(finalText || shown, expectsReply(finalText)), expectsReply: expectsReply(finalText) });
        else this.view.bubbleHide();
      },
    };
  }

  say(text: string, options: { spontaneous?: boolean; kind?: BubbleKind } = {}): void {
    if (options.spontaneous) {
      // Only the latest unsaid thought matters
      this.pending = { text, since: Date.now() };
      return;
    }
    this.show(text, options.kind ?? "speech");
  }

  /** A question with buttons; resolves with the chosen id, or null on timeout or dismissal. */
  ask(text: string, choices: { id: string; label: string }[], timeoutMs: number): Promise<string | null> {
    const id = this.nextId++;
    this.view.bubbleStart({ id, kind: "question" });
    this.view.bubbleChunk({ id, text });
    this.view.bubbleEnd({ id, finalText: text, holdMs: timeoutMs, expectsReply: true, choices });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.questions.delete(id);
        this.view.bubbleHide();
        resolve(null);
      }, timeoutMs);
      this.questions.set(id, (choice) => {
        clearTimeout(timer);
        this.questions.delete(id);
        resolve(choice);
      });
    });
  }

  /** The user clicked a button of a question bubble. */
  answered(bubbleId: number, choice: string): void {
    this.questions.get(bubbleId)?.(choice);
  }

  hide(): void {
    this.view.bubbleHide();
  }

  private deliverPending(): void {
    if (!this.pending) return;
    if (this.idleSec() < PAUSE_SEC && Date.now() - this.pending.since < MAX_WAIT_MS) return;
    const { text } = this.pending;
    this.pending = null;
    if (!this.silenced()) this.show(text, "speech");
  }

  private show(text: string, kind: BubbleKind): void {
    const id = this.nextId++;
    this.view.bubbleStart({ id, kind });
    this.view.bubbleChunk({ id, text });
    this.view.bubbleEnd({ id, finalText: text, holdMs: holdTime(text, expectsReply(text)), expectsReply: expectsReply(text) });
  }
}

/** Joins say calls the way they are shown in a bubble. */
export function joinSays(says: { text: string }[]): string {
  return says
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** A moment's speech shown as a bubble (voice off or unavailable). */
export class BubbleSpeech implements SpeechSink {
  private bubble: BubbleHandle | null = null;
  private shown = "";
  private emotions = 0;
  private finished = false;
  private aborted = false;
  private resolve: ((heard: { text: string; interrupted: boolean }) => void) | null = null;
  private readonly heard: Promise<{ text: string; interrupted: boolean }>;

  constructor(
    private readonly bubbles: Bubbles,
    private readonly react: { emotion(emotion: Emotion, intensity: number): void; look(text: string): void; gesture?(gesture: string): void },
    private readonly spontaneous: boolean,
  ) {
    this.heard = new Promise((resolve) => (this.resolve = resolve));
  }

  live(says: LiveSay[]): void {
    if (this.aborted || this.finished) return;
    this.reactTo(says);
    // Spontaneous lines appear whole, when the user pauses typing
    if (this.spontaneous) return;
    const full = joinSays(says);
    if (!full.startsWith(this.shown) || full.length === this.shown.length) return;
    this.bubble ??= this.bubbles.start();
    this.bubble.append(full.slice(this.shown.length));
    this.shown = full;
  }

  final(says: SayCall[]): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.aborted) this.reactTo(says.map((s) => ({ ...s, complete: true })));
    const text = this.aborted ? this.shown : joinSays(says);
    if (this.spontaneous && text && !this.aborted) this.bubbles.say(text, { spontaneous: true });
    else if (this.bubble) this.bubble.end(text);
    else if (text) this.bubbles.say(text);
    this.resolve?.({ text, interrupted: this.aborted && text.length > 0 });
  }

  done(): Promise<{ text: string; interrupted: boolean }> {
    return this.heard;
  }

  abort(): void {
    this.aborted = true;
  }

  private reactTo(says: LiveSay[]): void {
    // Each say call's emotion shows on the face as soon as it is known
    for (let i = this.emotions; i < says.length; i++) {
      const s = says[i];
      if (!s.emotion && !s.complete) break;
      this.react.emotion(toEmotion(s.emotion) ?? "neutra", clampIntensity(s.intensity));
      if (s.look) this.react.look(s.look);
      if (s.gesture) this.react.gesture?.(s.gesture);
      this.emotions = i + 1;
    }
  }
}
