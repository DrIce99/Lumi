// Speech that goes to two places at once: the voice, and a bubble with the
// same words (typed conversations, subtitles).
import type { SayCall, SpeechSink } from "./brain/brain";
import type { LiveSay } from "./brain/providers/types";

export class TeeSpeech implements SpeechSink {
  constructor(
    private readonly primary: SpeechSink,
    private readonly secondary: SpeechSink,
  ) {}

  live(says: LiveSay[]): void {
    this.primary.live(says);
    this.secondary.live(says);
  }

  final(says: SayCall[]): void {
    this.primary.final(says);
    this.secondary.final(says);
  }

  /** What the user heard is what the voice said. */
  done(): Promise<{ text: string; interrupted: boolean }> {
    return this.primary.done();
  }

  abort(): void {
    this.primary.abort();
    this.secondary.abort();
  }
}
