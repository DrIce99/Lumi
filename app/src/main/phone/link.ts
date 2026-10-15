// A call from the phone (phase 15): the server (pairing, login, signed
// signaling), the hidden bridge window (WebRTC, VAD, Lumi's voice into the
// call) and the handoff: Lumi leaves the PC's screen (spaghettification)
// and the phone shows it arriving; on hang-up the reverse. While the call
// is active main routes the voice and the microphone through here.
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { IPC } from "../../shared/ipc";
import type { CallBody, PairingLink, ToPc, ToPhone } from "../../shared/phone";
import type { AudioBegin, AudioChunk, FaceGesture, FaceState, MicControl, MicEvent, PlaybackEvent } from "../../shared/types";
import { log } from "../log";
import type { PhoneDevices } from "./devices";
import { PhoneServer, type PhoneSession } from "./server";

export type CallState = "idle" | "connecting" | "leaving" | "active" | "returning";

export interface PhoneLinkHost {
  /** The phone link is enabled, and on which port. */
  config(): { enabled: boolean; port: number };
  /** Lumi leaves the PC's screen (the animation); resolves when it is gone. */
  leave(): Promise<void>;
  /** Lumi comes back to the PC's screen (the window shows, the animation plays). */
  arrive(): void;
  /** The call started (after Lumi left) or ended: main reroutes voice and microphone. */
  callChanged(active: boolean, phone: string): void;
  mic(event: MicEvent): void;
  playback(event: PlaybackEvent): void;
  ptt(down: boolean): void;
  /** The face's current state, sent when the phone's face appears. */
  faceState(): FaceState;
  /** The eyes' color (settings), so the phone draws the same Lumi. */
  faceColor(): string;
  paired(name: string): void;
}

/** A broken connection ends the call after this long. */
const LOST_MS = 10_000;
/** The other side has this long to finish its animation on hang-up. */
const HANGUP_WAIT_MS = 2500;

export class PhoneLink {
  private readonly server: PhoneServer;
  private bridge: BrowserWindow | null = null;
  private state: CallState = "idle";
  private session: PhoneSession | null = null;
  private lostTimer: NodeJS.Timeout | null = null;
  private hangupTimer: NodeJS.Timeout | null = null;
  private answerWaiter: ((result: { sdp?: string; error?: string }) => void) | null = null;
  private bridgeReady: Promise<void> | null = null;

  constructor(
    private readonly host: PhoneLinkHost,
    readonly devices: PhoneDevices,
    private readonly bridgeUrl: string,
    appDir: string | null,
    pcName: string,
  ) {
    this.server = new PhoneServer(devices, { message: (s, b) => void this.onSignal(s, b), closed: (s) => this.onClosed(s), paired: (n) => host.paired(n) }, appDir, pcName);
    const fromBridge = (channel: string, fn: (event: IpcMainEvent, payload: unknown) => void) =>
      ipcMain.on(channel, (event, payload) => {
        if (this.bridge && event.sender === this.bridge.webContents) fn(event, payload);
      });
    fromBridge(IPC.bridgeAnswer, (_e, result) => {
      this.answerWaiter?.(result as { sdp?: string; error?: string });
      this.answerWaiter = null;
    });
    fromBridge(IPC.bridgeMessage, (_e, msg) => this.onData(msg as ToPc));
    fromBridge(IPC.bridgeConnection, (_e, state) => this.onConnection(String(state)));
    fromBridge(IPC.mic, (_e, event) => this.host.mic(event as MicEvent));
    fromBridge(IPC.playback, (_e, event) => this.host.playback(event as PlaybackEvent));
    fromBridge(IPC.bridgeLog, (_e, text) => log.info(`[phone bridge] ${String(text)}`));
  }

  /** Starts or stops the server to follow the settings. */
  async configure(): Promise<void> {
    const c = this.host.config();
    try {
      if (c.enabled) await this.server.start(c.port);
      else {
        if (this.state !== "idle") this.end("disabled");
        await this.server.stop();
      }
    } catch (err) {
      log.error(`The phone server can't listen on port ${c.port}`, err);
    }
  }

  listening(): boolean {
    return this.server.listening;
  }

  startPairing(): PairingLink {
    return this.server.startPairing();
  }

  /** A call is on and Lumi is on the phone: voice and microphone go through here. */
  active(): boolean {
    return this.state === "active";
  }

  callState(): CallState {
    return this.state;
  }

  phoneName(): string {
    return this.session?.deviceName ?? "";
  }

  // ---------------- voice and face during the call ----------------

  audioBegin(msg: AudioBegin): void {
    this.toBridge(IPC.audioBegin, msg);
  }

  audioChunk(msg: AudioChunk): void {
    this.toBridge(IPC.audioChunk, msg);
  }

  audioEnd(id: number): void {
    this.toBridge(IPC.audioEnd, { id });
  }

  audioStop(fadeMs: number): void {
    this.toBridge(IPC.audioStop, { fadeMs });
  }

  micControl(control: MicControl): void {
    this.toBridge(IPC.micControl, control);
  }

  faceState(state: FaceState): void {
    if (this.state === "active") this.send({ type: "state", state });
  }

  gesture(gesture: FaceGesture): void {
    if (this.state === "active") this.send({ type: "gesture", gesture });
  }

  subtitle(text: string, done: boolean): void {
    if (this.state === "active") this.send({ type: "subtitle", text, done });
  }

  /** "Richiama Lumi" on the PC: the phone lets Lumi go, then it comes back here. */
  hangup(): void {
    if (this.state === "idle" || this.state === "returning") return;
    if (this.state !== "active") return this.end("pc");
    this.send({ type: "hangup" });
    // The phone plays its animation and answers; without an answer Lumi comes back anyway
    this.hangupTimer = setTimeout(() => this.end("pc"), HANGUP_WAIT_MS);
  }

  dispose(): void {
    if (this.state !== "idle") this.end("quit");
    void this.server.stop();
    this.bridge?.destroy();
    this.bridge = null;
  }

  // ---------------- signaling ----------------

  private async onSignal(session: PhoneSession, body: CallBody): Promise<void> {
    if (body.type === "offer") {
      if (this.session && this.session !== session && this.state !== "idle") {
        await session.send({ type: "busy", reason: "Lumi è già al telefono con un altro dispositivo." });
        return;
      }
      if (this.state === "leaving" || this.state === "returning") {
        await session.send({ type: "busy", reason: "Un attimo: Lumi sta ancora viaggiando." });
        return;
      }
      this.session = session;
      this.state = "connecting";
      log.info(`Phone call from "${session.deviceName}"`);
      const result = await this.offer(body.sdp);
      if (!result.sdp) {
        log.warn(`The phone bridge couldn't answer: ${result.error ?? "no answer"}`);
        await session.send({ type: "busy", reason: "Il PC non riesce a rispondere alla chiamata." });
        this.end("error");
        return;
      }
      await session.send({ type: "answer", sdp: result.sdp });
      return;
    }
    if (body.type === "hangup" && session === this.session) this.end("phone");
  }

  private onClosed(session: PhoneSession): void {
    // The signaling socket may drop while the call itself (WebRTC) goes on; only a call that never connected ends here
    if (session === this.session && this.state === "connecting") this.end("lost");
  }

  private async ensureBridge(): Promise<void> {
    if (this.bridge && !this.bridge.isDestroyed()) return this.bridgeReady ?? Promise.resolve();
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, "../preload/phoneBridge.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.bridge = win;
    win.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") log.warn(`[phone bridge] ${event.message}`);
    });
    win.webContents.on("render-process-gone", (_e, d) => {
      log.error(`Phone bridge gone: ${d.reason}`);
      if (this.state !== "idle") this.end("error");
      this.bridge = null;
    });
    this.bridgeReady = win.loadURL(this.bridgeUrl);
    return this.bridgeReady;
  }

  private async offer(sdp: string): Promise<{ sdp?: string; error?: string }> {
    await this.ensureBridge();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.answerWaiter = null;
        resolve({ error: "timeout" });
      }, 8000);
      this.answerWaiter = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.toBridge(IPC.bridgeOffer, { sdp });
    });
  }

  // ---------------- the call ----------------

  private onConnection(state: string): void {
    log.info(`Phone connection: ${state}`);
    if (state === "open" && this.state === "connecting") return void this.begin();
    if (state === "connected" && this.lostTimer) {
      clearTimeout(this.lostTimer);
      this.lostTimer = null;
    }
    if (this.state === "idle") return;
    if (state === "failed" || state === "closed") this.end("lost");
    else if (state === "disconnected" && !this.lostTimer) this.lostTimer = setTimeout(() => this.end("lost"), LOST_MS);
  }

  /** The call is up: Lumi leaves the PC, then the phone shows it arriving. */
  private async begin(): Promise<void> {
    this.state = "leaving";
    await this.host.leave();
    if (this.state !== "leaving") return;
    this.state = "active";
    this.host.callChanged(true, this.phoneName());
    this.send({ type: "state", state: this.host.faceState(), color: this.host.faceColor() });
    this.send({ type: "transit", what: "gone" });
  }

  private onData(msg: ToPc): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hangup" || (msg.type === "transit" && msg.what === "gone")) return this.end("phone");
    if (msg.type === "ptt") this.host.ptt(msg.down === true);
  }

  /** Back to the PC: routing restored, the face window comes back with the reverse animation. */
  private end(why: string): void {
    if (this.state === "idle" || this.state === "returning") return;
    const wasOnPhone = this.state === "active" || this.state === "leaving";
    log.info(`Phone call ended (${why})`);
    this.state = "returning";
    for (const t of [this.lostTimer, this.hangupTimer]) if (t) clearTimeout(t);
    this.lostTimer = null;
    this.hangupTimer = null;
    this.toBridge(IPC.bridgeHangup, null);
    this.session?.close();
    this.session = null;
    this.host.callChanged(false, "");
    if (wasOnPhone) this.host.arrive();
    this.state = "idle";
  }

  private send(msg: ToPhone): void {
    this.toBridge(IPC.bridgeSend, msg);
  }

  private toBridge(channel: string, payload: unknown): void {
    if (this.bridge && !this.bridge.isDestroyed()) this.bridge.webContents.send(channel, payload);
  }
}
