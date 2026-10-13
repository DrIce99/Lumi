// Tool calls that some open models write as text instead of calling the
// tool. Gemma 4 through Ollama does it in about one reply out of four, in
// its own syntax or as a function call:
//   say{emotion:<|"|>gioia<|"|>,text:<|"|>Ciao!<|"|>}
//   say(emotion:gioia,text: "Ciao!")
//   say(emotion:gioia,text: Ciao! Come va?)
// They are read back into calls, also while the reply streams, so the
// speech still starts early and keeps its emotion.

export interface TextCall {
  name: string;
  /** The arguments as JSON; while the call streams, an unterminated prefix. */
  args: string;
  complete: boolean;
}

/** Tool names with their parameter names (which delimit unquoted values). */
export type ToolShapes = ReadonlyMap<string, readonly string[]>;

/** Gemma's string delimiter. */
const QUOTE = '<|"|>';

interface Args {
  values: [string, unknown][];
  /** A string value still streaming. */
  open?: { key: string; text: string };
  complete: boolean;
}

/** The value read, or how much of it arrived when the text ended first. */
type Value = { value: unknown } | { partial: string | null };

class Reader {
  i = 0;

  constructor(
    readonly s: string,
    /** The whole reply arrived: its end closes whatever is open. */
    readonly final: boolean,
  ) {}

  get done(): boolean {
    return this.i >= this.s.length;
  }

  /** Streaming text that ends with what may be the start of Gemma's string delimiter. */
  get cutQuote(): boolean {
    return !this.final && QUOTE.startsWith(this.s.slice(this.i));
  }

  skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  /** Whitespace, code fences, template tokens and prefixes around calls. */
  skipWrapping(): void {
    for (;;) {
      const m = /^(?:\s+|```[\w-]*|<\|?[a-z_]+\|?>|call:|default_api\.|functions\.)/.exec(this.s.slice(this.i));
      if (!m) return;
      this.i += m[0].length;
    }
  }

  readKey(): string | null {
    const ch = this.s[this.i];
    if (this.s.startsWith(QUOTE, this.i) || ch === '"' || ch === "'") {
      const v = this.readString();
      return "value" in v ? String(v.value) : null;
    }
    const m = /^[A-Za-z_][\w-]*/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  /** `key: value` pairs up to the closer; `params` delimit unquoted values. */
  readArgs(closer: string, params: readonly string[]): Args | null {
    const values: [string, unknown][] = [];
    for (;;) {
      this.skipSpace();
      if (this.done) return { values, complete: this.final };
      if (this.s[this.i] === closer) {
        this.i++;
        return { values, complete: true };
      }
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.cutQuote) return { values, complete: false };
      const key = this.readKey();
      if (key === null) return this.done ? { values, complete: this.final } : null;
      this.skipSpace();
      if (this.done) return { values, complete: this.final };
      if (this.s[this.i] !== ":" && this.s[this.i] !== "=") return null;
      this.i++;
      this.skipSpace();
      if (this.done) return { values, complete: this.final };
      const v = this.readValue(closer, params);
      if ("partial" in v) {
        if (this.final) {
          if (v.partial !== null) values.push([key, v.partial]);
          return { values, complete: true };
        }
        return { values, open: v.partial === null ? undefined : { key, text: v.partial }, complete: false };
      }
      values.push([key, v.value]);
    }
  }

  readValue(closer: string, params: readonly string[]): Value {
    if (this.cutQuote) {
      this.i = this.s.length;
      return { partial: null };
    }
    const ch = this.s[this.i];
    if (this.s.startsWith(QUOTE, this.i) || ch === '"' || ch === "'") return this.readString();
    if (ch === "{" || ch === "[") return this.readNested();
    return this.readBare(closer, params);
  }

  readString(): Value {
    if (this.s.startsWith(QUOTE, this.i)) {
      const start = this.i + QUOTE.length;
      const end = this.s.indexOf(QUOTE, start);
      if (end < 0) {
        this.i = this.s.length;
        return { partial: withoutPartialQuote(this.s.slice(start)) };
      }
      this.i = end + QUOTE.length;
      return { value: this.s.slice(start, end) };
    }
    const quote = this.s[this.i];
    let out = "";
    for (let i = this.i + 1; i < this.s.length; i++) {
      const ch = this.s[i];
      if (ch === quote && (quote === '"' || this.endsSingleQuoted(i + 1))) {
        this.i = i + 1;
        return { value: out };
      }
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const next = this.s[i + 1];
      if (next === undefined) break;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i++;
    }
    this.i = this.s.length;
    // A quote at the end may be the closing one: it shows once that's clear
    return { partial: quote === "'" ? out.replace(/'$/, "") : out };
  }

  /** Italian apostrophes ("C'è") don't close a single-quoted string: only a quote before a separator does. */
  private endsSingleQuoted(after: number): boolean {
    const rest = this.s.slice(after);
    return /^\s*[,:=)}\]]/.test(rest) || (this.final && !rest.trim());
  }

  /** An object or array value (not spoken: only complete ones count). */
  readNested(): Value {
    const open = this.s[this.i];
    const closer = open === "{" ? "}" : "]";
    this.i++;
    if (open === "{") {
      const args = this.readArgs(closer, []);
      if (!args) return { partial: null };
      return args.complete ? { value: Object.fromEntries(args.values) } : { partial: null };
    }
    const items: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.done) return { partial: null };
      if (this.s[this.i] === closer) {
        this.i++;
        return { value: items };
      }
      if (this.s[this.i] === ",") {
        this.i++;
        continue;
      }
      const v = this.readValue(closer, []);
      if ("partial" in v) return { partial: null };
      items.push(v.value);
    }
  }

  /**
   * An unquoted value. Inside a call it may be a whole sentence with commas
   * and parentheses: it ends before `, param:` or at a closer that ends the
   * line. Anything at the end of streaming text that may still turn out to
   * be one of those is held back, so the value only ever grows.
   */
  readBare(closer: string, params: readonly string[]): Value {
    const rest = this.s.slice(this.i);
    let end = -1;
    if (params.length) {
      const anchor = new RegExp(`,\\s*(?:${params.join("|")})\\s*[:=]|\\${closer}[ \\t]*(?=\\r?\\n|<|\`|$)`);
      const m = anchor.exec(rest);
      // A closer at the very end of streaming text may still be followed by more words
      if (m && (this.final || m[0][0] === "," || m.index + m[0].length < rest.length)) end = m.index;
    } else {
      end = rest.search(new RegExp(`[,\\${closer}]`));
    }
    if (end < 0) {
      this.i = this.s.length;
      if (this.final) return { partial: rest.trim() };
      const held = params.length ? rest.replace(/(?:,\s*[\w-]*\s*|\s*[)}\]][ \t]*)$/, "") : rest;
      return { partial: /^-?[\d.]*$/.test(held.trim()) ? null : held.trimStart() };
    }
    this.i += end;
    const token = rest.slice(0, end).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return { value: Number(token) };
    if (/^(?:true|false)$/i.test(token)) return { value: token.toLowerCase() === "true" };
    if (/^(?:null|none)$/i.test(token)) return { value: null };
    return { value: token };
  }
}

/** A string cut in the middle of Gemma's delimiter loses the delimiter's start. */
function withoutPartialQuote(text: string): string {
  for (let k = QUOTE.length - 1; k > 0; k--) if (text.endsWith(QUOTE.slice(0, k))) return text.slice(0, -k);
  return text;
}

function argsJson(args: Args): string {
  const object = JSON.stringify(Object.fromEntries(args.values));
  if (args.complete) return object;
  const head = object.slice(0, -1);
  if (!args.open) return head;
  return `${head}${args.values.length ? "," : ""}${JSON.stringify(args.open.key)}:${JSON.stringify(args.open.text).slice(0, -1)}`;
}

/**
 * Reads the tool calls a reply starts with, or null when it doesn't start
 * with one. `final` says the reply is complete; otherwise the last call may
 * be cut short. `rest` is the text after the calls.
 */
export function readTextCalls(text: string, tools: ToolShapes, final: boolean): { calls: TextCall[]; rest: string } | null {
  const r = new Reader(text, final);
  const calls: TextCall[] = [];
  for (;;) {
    const start = r.i;
    r.skipWrapping();
    const name = /^[A-Za-z_]\w*/.exec(text.slice(r.i))?.[0];
    const params = name ? tools.get(name) : undefined;
    const opener = name ? /^\s*([({])/.exec(text.slice(r.i + name.length)) : null;
    if (!name || !params || !opener) {
      r.i = start;
      break;
    }
    r.i += name.length + opener[0].length;
    const args = r.readArgs(opener[1] === "(" ? ")" : "}", params);
    if (!args) {
      r.i = start;
      break;
    }
    calls.push({ name, args: argsJson(args), complete: args.complete });
    if (!args.complete) return { calls, rest: "" };
  }
  if (!calls.length) return null;
  r.skipWrapping();
  return { calls, rest: text.slice(r.i).trim() };
}

/** Removes chat-template tokens and code fences a model may leak into its text. */
export function stripMarkup(text: string): string {
  const word = /[\p{L}\p{N}]/u;
  return text
    .replace(/<\|[^<>\s]*\|?>|<[^<>\s|]+\|>|```[\w-]*/g, (token, at: number, all: string) =>
      // Between two words the token stood for a space
      word.test(all[at - 1] ?? "") && word.test(all[at + token.length] ?? "") ? " " : "",
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
