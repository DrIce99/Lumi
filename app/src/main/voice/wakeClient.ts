// The sidecar's /wake socket: loads a wake word model ("lumi", trained with
// sidecar/wake/train.py) and returns openWakeWord scores for the speech we
// send. When the model is missing or openWakeWord isn't installed, `ready`
// stays false and the turn manager spots the wake word in transcripts.
import { log } from "../log";
import { SidecarSocket, type SocketFactory } from "../socket";

export type WakeState = "off" | "connecting" | "ready" | "missing" | "error";

/** A missing model is looked for again this often (it may have just been trained). */
const MISSING_RETRY_MS = 60_000;
const RETRY_MS = 3000;

export class WakeClient {
  private readonly socket: SidecarSocket;
  private wanted = false;
  private model = "lumi";
  private retry: NodeJS.Timeout | null = null;
  state: WakeState = "off";

  constructor(
    url: () => string | null,
    private readonly handlers: { scores(scores: number[]): void; state?(state: WakeState, detail: string): void },
    factory?: SocketFactory,
  ) {
    this.socket = new SidecarSocket(
      url,
      {
        text: (data) => this.onText(data),
        binary: () => undefined,
        // The sidecar went away (or restarted): connect again
        closed: () => {
          this.setState(this.wanted ? "connecting" : "off", "");
          this.scheduleRetry(RETRY_MS);
        },
      },
      factory,
    );
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  /** Wanted (wake word mode, sidecar up) or not; `model` is the wake word model's name. */
  set(wanted: boolean, model: string): void {
    const changed = model !== this.model;
    this.wanted = wanted;
    this.model = model;
    if (!wanted) {
      this.clearRetry();
      this.socket.close();
      this.setState("off", "");
      return;
    }
    if (changed) {
      this.socket.close();
      this.open();
    } else if (this.state === "off") {
      this.open();
    }
    // "missing" and "error" are retried by their timer
  }

  /** A new speech segment begins. */
  reset(): void {
    if (this.ready) this.socket.sendJson({ reset: true });
  }

  audio(pcm: Uint8Array): void {
    if (this.ready) this.socket.sendFrame(0, pcm);
  }

  private open(): void {
    this.clearRetry();
    this.setState("connecting", "");
    if (!this.socket.sendJson({ model: this.model })) this.scheduleRetry(RETRY_MS);
  }

  private onText(data: Record<string, unknown>): void {
    if (data.type === "scores" && Array.isArray(data.scores)) {
      this.handlers.scores(data.scores.filter((s): s is number => typeof s === "number"));
    } else if (data.type === "ready") {
      this.setState("ready", String(data.model ?? ""));
    } else if (data.type === "error") {
      const missing = data.missing === true;
      this.setState(missing ? "missing" : "error", String(data.error ?? ""));
      // The socket stays open but useless: close it and look again later
      this.socket.close();
      this.scheduleRetry(MISSING_RETRY_MS);
    }
  }

  private setState(state: WakeState, detail: string): void {
    if (state === this.state) return;
    this.state = state;
    if (state === "ready") log.info(`Wake word: openWakeWord model "${detail}" ready`);
    else if (state === "missing") log.info(`Wake word: no "${this.model}" model yet, the name is spotted in transcripts (${detail})`);
    else if (state === "error") log.warn(`Wake word: openWakeWord unavailable, the name is spotted in transcripts (${detail})`);
    this.handlers.state?.(state, detail);
  }

  private scheduleRetry(ms: number): void {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.socket.connected) this.open();
    }, ms);
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}
