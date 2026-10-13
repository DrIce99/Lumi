// Listening to other apps (a Discord call) through the sidecar's /apps
// WebSocket: the sidecar captures only those apps' audio, cuts it into
// utterances, transcribes them locally and measures a voiceprint for each.
// This client says which apps to listen to and reconnects while wanted.
import { SidecarSocket, type SocketFactory } from "../socket";

export interface AppUtterance {
  app: string;
  text: string;
  durationMs: number;
  voiceprint?: number[];
}

export interface AppAudioHandlers {
  heard(utterance: AppUtterance): void;
  /** Per app: "in ascolto", "chiusa" or "errore: ...". */
  status(apps: Record<string, string>): void;
}

export class AppAudioClient {
  private readonly socket: SidecarSocket;
  private wanted: { apps: string[]; vocabulary: string[] } | null = null;
  private retry: NodeJS.Timeout | null = null;
  private lastHeard = 0;
  statuses: Record<string, string> = {};

  constructor(
    url: () => string | null,
    private readonly handlers: AppAudioHandlers,
    private readonly now: () => number = Date.now,
    factory?: SocketFactory,
  ) {
    this.socket = new SidecarSocket(url, {
      text: (data) => this.onText(data),
      binary: () => undefined,
      closed: () => {
        this.setStatuses({});
        this.scheduleRetry();
      },
    }, factory);
  }

  /** Listens to these apps (null or none: stops listening). */
  set(apps: string[] | null, vocabulary: string[] = []): void {
    const next = apps?.length ? { apps, vocabulary } : null;
    if (JSON.stringify(next) === JSON.stringify(this.wanted) && (!next || this.socket.connected)) return;
    this.wanted = next;
    if (!next) {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      this.socket.close();
      this.setStatuses({});
      return;
    }
    if (!this.socket.sendJson(next)) this.scheduleRetry();
  }

  /** Someone was heard in a listened app within `withinMs` (a call is going on). */
  active(withinMs = 90_000): boolean {
    return this.lastHeard > 0 && this.now() - this.lastHeard < withinMs;
  }

  private onText(data: Record<string, unknown>): void {
    if (data.type === "status" && data.apps && typeof data.apps === "object") {
      this.setStatuses({ ...this.statuses, ...(data.apps as Record<string, string>) });
    } else if (data.type === "heard" && typeof data.app === "string" && typeof data.text === "string") {
      this.lastHeard = this.now();
      const print = Array.isArray(data.voiceprint) && data.voiceprint.every((x) => typeof x === "number") ? (data.voiceprint as number[]) : undefined;
      this.handlers.heard({ app: data.app, text: data.text, durationMs: Number(data.durationMs) || 0, ...(print ? { voiceprint: print } : {}) });
    }
  }

  private setStatuses(next: Record<string, string>): void {
    if (JSON.stringify(next) === JSON.stringify(this.statuses)) return;
    this.statuses = next;
    this.handlers.status(next);
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      const wanted = this.wanted;
      if (wanted && !this.socket.sendJson(wanted)) this.scheduleRetry();
    }, 3000);
  }
}
