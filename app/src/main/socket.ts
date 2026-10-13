// A WebSocket to the sidecar that connects on demand, queues messages sent
// while connecting, and reports when the connection is lost (the sidecar
// restarted). Binary frames are `[uint32 LE id][payload]`.

/** The minimal WebSocket surface used here (the global one, or a fake in tests). */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

const OPEN = 1;

export interface SocketHandlers {
  text(data: Record<string, unknown>): void;
  binary(id: number, payload: Uint8Array): void;
  closed(): void;
}

export class SidecarSocket {
  private ws: SocketLike | null = null;
  private queue: (string | Uint8Array)[] = [];

  constructor(
    private readonly url: () => string | null,
    private readonly handlers: SocketHandlers,
    private readonly factory: SocketFactory = defaultSocketFactory,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  /** Opens the connection if the sidecar is up; returns false when it isn't. */
  connect(): boolean {
    if (this.ws) return true;
    const url = this.url();
    if (!url) return false;
    const ws = this.factory(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      for (const message of this.queue.splice(0)) ws.send(message);
    };
    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string") {
        try {
          this.handlers.text(JSON.parse(data) as Record<string, unknown>);
        } catch {
          // not for us
        }
      } else if (data instanceof ArrayBuffer && data.byteLength >= 4) {
        const view = new DataView(data);
        this.handlers.binary(view.getUint32(0, true), new Uint8Array(data, 4));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.queue = [];
      this.handlers.closed();
    };
    ws.onerror = () => undefined;
    this.ws = ws;
    return true;
  }

  sendJson(message: unknown): boolean {
    return this.send(JSON.stringify(message));
  }

  /** Sends `[id][payload]`. */
  sendFrame(id: number, payload: Uint8Array): boolean {
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, id, true);
    frame.set(payload, 4);
    return this.send(frame);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.queue = [];
    ws?.close();
  }

  private send(message: string | Uint8Array): boolean {
    if (!this.connect()) return false;
    if (this.ws!.readyState === OPEN) this.ws!.send(message);
    else this.queue.push(message);
    return true;
  }
}
