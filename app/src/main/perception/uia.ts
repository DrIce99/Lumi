// UI Automation from the sidecar's /uia WebSocket: the focused element, its
// caret (also in Chrome, VS Code and Electron apps), the line being typed
// and the selection. Rectangles arrive in physical screen pixels.
import { SidecarSocket } from "../socket";

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiaSnapshot {
  focus: {
    name: string;
    controlType: string;
    className: string;
    processId: number;
    rect: PhysicalRect | null;
    isPassword: boolean;
  };
  caret: PhysicalRect | null;
  line: string | null;
  selection: string | null;
}

export class UiaClient {
  private readonly socket: SidecarSocket;
  private wanted = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(
    url: () => string | null,
    private readonly onSnapshot: (snapshot: UiaSnapshot) => void,
  ) {
    this.socket = new SidecarSocket(url, {
      text: (data) => {
        if (data && typeof data === "object" && "focus" in data) this.onSnapshot(data as unknown as UiaSnapshot);
      },
      binary: () => undefined,
      closed: () => this.scheduleRetry(),
    });
  }

  /** Subscribes (true) or unsubscribes (false); reconnects by itself while wanted. */
  set(wanted: boolean): void {
    this.wanted = wanted;
    if (wanted) {
      if (!this.socket.connected && !this.socket.connect()) this.scheduleRetry();
    } else {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      this.socket.close();
    }
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.socket.connected && !this.socket.connect()) this.scheduleRetry();
    }, 3000);
  }
}
