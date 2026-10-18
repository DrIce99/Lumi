// Provider-neutral interface between the brain and the AI services.
import type { ProviderId } from "../../../shared/providers";

export type ProviderErrorKind =
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "connection"
  | "bad_request"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly cause?: unknown,
    /** HTTP status, when the service answered with an error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** The connection was refused because of an untrusted certificate (e.g. a network that inspects HTTPS). */
  get certificate(): boolean {
    return this.kind === "connection" && /CERT|certificate|SSL|TLS/i.test(this.message);
  }
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface ToolCallOut {
  id: string;
  name: string;
  input: unknown;
}

/** A say call as it is being written: fields appear as soon as they are readable. */
export interface LiveSay {
  text: string;
  emotion?: string;
  intensity?: number;
  look?: string;
  gesture?: string;
  /** The call's arguments are complete. */
  complete: boolean;
}

export interface RoundResult {
  toolCalls: ToolCallOut[];
  /** Plain text the model wrote (thinking removed). */
  text: string;
  stop: "end" | "tools" | "length" | "refused";
  usage: Usage | null;
  model: string;
}

export interface ToolResultIn {
  id: string;
  name: string;
  text: string;
  images: { label: string; jpegBase64: string }[];
  isError: boolean;
}

export interface MomentOptions {
  model: string;
  system: string;
  context: string;
}

/** One moment: a request, plus follow-ups after tools that return something (look_at_screen). */
export interface MomentSession {
  /** Runs one request. `onLive` receives the say calls written so far, for streaming speech. */
  next(onLive?: (says: LiveSay[]) => void): Promise<RoundResult>;
  /** Appends the last reply and the tool results, ready for the follow-up request. */
  addResults(results: ToolResultIn[]): void;
  abort(): void;
}

export interface ChatProvider {
  readonly id: ProviderId;
  start(options: MomentOptions): MomentSession;
  /** A single completion without tools (diary summaries, screen descriptions, connection tests). */
  complete(options: { model: string; system: string; prompt: string; images?: string[]; maxTokens?: number }): Promise<{ text: string; usage: Usage | null; model: string }>;
}
