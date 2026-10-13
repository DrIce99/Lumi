// Speech synthesis through the sidecar's /tts WebSocket. Requests are
// synthesized in order; audio streams back in PCM chunks tagged with the
// request id, then a `done` message. `cancel` drops queued sentences and
// stops the running one.
import type { Emotion } from "../../shared/emotions";
import { SidecarSocket, type SocketFactory } from "../socket";

export interface TtsDone {
  cancelled: boolean;
  /** Time to the first audio chunk, ms. */
  firstMs: number | null;
  ms: number;
  audioMs: number;
  error?: string;
}

export interface TtsHandlers {
  chunk(pcm: Uint8Array, sampleRate: number): void;
  done(info: TtsDone): void;
}

export interface SpeakRequest {
  id: number;
  text: string;
  emotion: Emotion;
  intensity: number;
  voice?: string;
}

export class TtsClient {
  private readonly socket: SidecarSocket;
  private readonly pending = new Map<number, { handlers: TtsHandlers; rate: number }>();

  constructor(url: () => string | null, factory?: SocketFactory) {
    this.socket = new SidecarSocket(
      url,
      {
        text: (data) => this.onText(data),
        binary: (id, payload) => {
          const entry = this.pending.get(id);
          // The payload is a view into the frame: copy it so it can be sent elsewhere
          if (entry) entry.handlers.chunk(payload.slice(), entry.rate);
        },
        closed: () => this.failAll("i motori della voce si sono fermati"),
      },
      factory,
    );
  }

  /** False when the sidecar is not available (speak in text instead). */
  speak(request: SpeakRequest, handlers: TtsHandlers): boolean {
    this.pending.set(request.id, { handlers, rate: 24_000 });
    const sent = this.socket.sendJson({
      type: "speak",
      id: request.id,
      text: request.text,
      emotion: request.emotion,
      intensity: Math.round(request.intensity * 100) / 100,
      ...(request.voice ? { voice: request.voice } : {}),
    });
    if (!sent) this.pending.delete(request.id);
    return sent;
  }

  cancel(id: number | "all"): void {
    if (!this.socket.connected) return;
    this.socket.sendJson({ cancel: id });
  }

  close(): void {
    this.socket.close();
    this.failAll("chiuso");
  }

  private onText(data: Record<string, unknown>): void {
    const id = typeof data.id === "number" ? data.id : -1;
    const entry = this.pending.get(id);
    if (!entry) return;
    if (data.start && typeof data.sampleRate === "number") entry.rate = data.sampleRate;
    if (data.done) {
      this.pending.delete(id);
      entry.handlers.done({
        cancelled: data.cancelled === true,
        firstMs: typeof data.firstMs === "number" ? data.firstMs : null,
        ms: Number(data.ms) || 0,
        audioMs: Number(data.audioMs) || 0,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
      });
    }
  }

  private failAll(error: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.handlers.done({ cancelled: false, firstMs: null, ms: 0, audioMs: 0, error });
  }
}
