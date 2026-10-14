// The up and down arrows walk through earlier prompts, like a shell; what
// was being typed is kept and comes back after the newest prompt.
export class PromptHistory {
  private index: number;
  private draft = "";

  constructor(private readonly items: string[]) {
    this.index = items.length;
  }

  /** The previous prompt, or null at the oldest one. */
  up(current: string): string | null {
    if (this.index === 0) return null;
    if (this.index === this.items.length) this.draft = current;
    this.index--;
    return this.items[this.index];
  }

  /** The next prompt, then the draft; null when already on the draft. */
  down(): string | null {
    if (this.index >= this.items.length) return null;
    this.index++;
    return this.index === this.items.length ? this.draft : this.items[this.index];
  }
}
