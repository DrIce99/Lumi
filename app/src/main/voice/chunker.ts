// Cuts the model's streamed text into sentences for the TTS: each sentence
// is synthesized as soon as it is complete. A sentence ends at . ! ? … or
// a line break; a long sentence is also cut at a comma after ~60
// characters. The very first piece may be cut at an earlier comma, so the
// voice starts sooner. Pure: no I/O, fully tested.

export interface ChunkerOptions {
  /** Cut at a comma (, ; :) once a piece is at least this long. */
  commaAfter: number;
  /** The first piece may be cut at a comma once it is this long. */
  firstCommaAfter: number;
  /** Hard limit: cut at the last space before this many characters. */
  maxChars: number;
}

export const DEFAULT_CHUNKER: ChunkerOptions = { commaAfter: 60, firstCommaAfter: 28, maxChars: 220 };

/** Abbreviations whose dot doesn't end a sentence. */
const ABBREVIATIONS = new Set(["es", "ecc", "etc", "sig", "sigg", "sig.ra", "dott", "dott.ssa", "prof", "ing", "avv", "pag", "pagg", "tel", "cfr", "n", "nr", "p.es", "vs", "ca", "max", "min", "art", "cap", "fig", "vol", "s.p.a", "s.r.l", "mr", "mrs", "dr"]);

export class SentenceChunker {
  private buffer = "";
  private emitted = 0;

  constructor(private readonly options: ChunkerOptions = DEFAULT_CHUNKER) {}

  /** Adds streamed text; returns the sentences it completed. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut(false);
      if (cut < 0) break;
      this.take(cut, out);
    }
    return out;
  }

  /** The text is over: whatever is left is the last sentence. */
  flush(): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut(true);
      if (cut < 0) break;
      this.take(cut, out);
    }
    this.take(this.buffer.length, out);
    return out;
  }

  /** Text received but not yet emitted. */
  pending(): string {
    return this.buffer;
  }

  /** Drops the text not yet emitted (the stream rewrote it). */
  discardPending(): void {
    this.buffer = "";
  }

  private take(end: number, out: string[]): void {
    const piece = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end).replace(/^\s+/, "");
    const clean = piece.replace(/\s+/g, " ").trim();
    // A piece made only of punctuation or symbols has nothing to say
    if (/[\p{L}\p{N}]/u.test(clean)) {
      out.push(clean);
      this.emitted++;
    }
  }

  /** Index just after the end of the next sentence, or -1 when none is complete yet. */
  private findCut(final: boolean): number {
    const b = this.buffer;
    const commaAfter = this.emitted === 0 ? this.options.firstCommaAfter : this.options.commaAfter;
    let comma = -1;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i];
      if (ch === "\n") {
        if (b.slice(0, i).trim()) return i + 1;
        continue;
      }
      if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
        // Runs like "?!" or "..." end together
        let end = i + 1;
        while (end < b.length && /[.!?…"»)\]']/.test(b[end])) end++;
        if (end >= b.length) {
          // The next character decides ("3." may become "3.14"): wait for it unless the text is over
          if (final) return end;
          return comma >= 0 && i >= this.options.maxChars ? comma : -1;
        }
        if (/\s/.test(b[end]) && this.endsSentence(b, i)) return end;
        i = end - 1;
        continue;
      }
      if ((ch === "," || ch === ";" || ch === ":") && i + 1 < b.length && /\s/.test(b[i + 1])) {
        if (i + 1 >= commaAfter) return i + 1;
        comma = i + 1;
      }
      if (i >= this.options.maxChars) {
        // Too long without punctuation: cut at the last comma or space
        const space = b.lastIndexOf(" ", i);
        return comma > 0 ? comma : space > 0 ? space + 1 : i + 1;
      }
    }
    return -1;
  }

  /** Whether the punctuation at `i` really ends a sentence (not "es.", "3.5", "S.p.A."). */
  private endsSentence(b: string, i: number): boolean {
    if (b[i] !== ".") return true;
    const before = b.slice(0, i);
    const word = /([\p{L}.]+)$/u.exec(before)?.[1]?.toLowerCase() ?? "";
    if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/\.$/, ""))) return false;
    // Single capital initials: "G. Verdi"
    if (/(^|\s)\p{Lu}$/u.test(before)) return false;
    return true;
  }
}

/** Splits a whole text at once (for tests and non-streamed speech). */
export function splitSentences(text: string, options: ChunkerOptions = DEFAULT_CHUNKER): string[] {
  const chunker = new SentenceChunker(options);
  return [...chunker.push(text), ...chunker.flush()];
}
