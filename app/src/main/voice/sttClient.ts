// Speech recognition through the sidecar's /stt WebSocket: a session per
// utterance, PCM 16 kHz frames tagged with the session id, partial results
// while the user speaks and a final result at the end.
import { SidecarSocket, type SocketFactory } from "../socket";

export interface SttWord {
  word: string;
  start: number;
  end: number;
  p: number;
}

export interface SttFinal {
  text: string;
  words: SttWord[];
  durationMs: number;
  ms: number;
  error?: string;
  /** Speaker embedding of the utterance, when asked for and measurable. */
  voiceprint?: number[];
}

export interface SttHandlers {
  partial(text: string): void;
  final(result: SttFinal): void;
}

export class SttClient {
  private readonly socket: SidecarSocket;
  private readonly sessions = new Map<number, SttHandlers>();

  constructor(url: () => string | null, factory?: SocketFactory) {
    this.socket = new SidecarSocket(
      url,
      {
        text: (data) => this.onText(data),
        binary: () => undefined,
        closed: () => {
          const sessions = [...this.sessions.values()];
          this.sessions.clear();
          for (const s of sessions) s.final({ text: "", words: [], durationMs: 0, ms: 0, error: "i motori della voce si sono fermati" });
        },
      },
      factory,
    );
  }

  start(id: number, options: { vocabulary: string[]; partials: boolean; voiceprint?: boolean }, handlers: SttHandlers): boolean {
    this.sessions.set(id, handlers);
    const sent = this.socket.sendJson({ type: "start", id, vocabulary: options.vocabulary, partials: options.partials, voiceprint: options.voiceprint ?? false });
    if (!sent) this.sessions.delete(id);
    return sent;
  }

  /** PCM 16-bit little endian, 16 kHz mono. */
  audio(id: number, pcm: Uint8Array): void {
    if (this.sessions.has(id)) this.socket.sendFrame(id, pcm);
  }

  end(id: number): void {
    if (this.sessions.has(id)) this.socket.sendJson({ type: "end", id });
  }

  cancel(id: number): void {
    if (!this.sessions.delete(id)) return;
    this.socket.sendJson({ type: "cancel", id });
  }

  close(): void {
    this.socket.close();
  }

  private onText(data: Record<string, unknown>): void {
    const id = typeof data.id === "number" ? data.id : -1;
    const handlers = this.sessions.get(id);
    if (!handlers) return;
    if (typeof data.partial === "string") handlers.partial(data.partial);
    if (typeof data.final === "string") {
      this.sessions.delete(id);
      handlers.final({
        text: data.final,
        words: Array.isArray(data.words) ? (data.words as SttWord[]) : [],
        durationMs: Number(data.durationMs) || 0,
        ms: Number(data.ms) || 0,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
        ...(Array.isArray(data.voiceprint) && data.voiceprint.every((x) => typeof x === "number") ? { voiceprint: data.voiceprint as number[] } : {}),
      });
    }
  }
}
