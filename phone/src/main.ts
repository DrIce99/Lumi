// Lumi on the phone (phase 15): pairing with the PC, the call and Lumi's
// face. The phone is only mic, speaker and body: speech recognition, the
// brain and the voice stay on the PC. Audio and the data channel travel over
// WebRTC (DTLS-SRTP, host candidates: same LAN or Tailscale); the signaling
// socket is plain, every message signed with the session key (shared/phone.ts).
import jsQR from "jsqr";
import { Face } from "../../app/src/renderer/face/face";
import { OUT_MS } from "../../app/src/renderer/face/transit";
import {
  hmac,
  parsePairingUrl,
  proofText,
  randomKey,
  sessionKey,
  SignedChannel,
  verifyHmac,
  PHONE_PATH,
  type CallBody,
  type PairingLink,
  type ToPc,
  type ToPhone,
} from "../../app/src/shared/phone";
import { FACE_HEIGHT, FACE_WIDTH, type FaceGesture, type FaceLayout, type FaceState } from "../../app/src/shared/types";

// ---------------- the paired PC ----------------

/** What the phone keeps of its PC. In the WebView's storage, which only this app can read (not the Android keystore). */
interface PairedPc {
  hosts: string[];
  port: number;
  deviceId: string;
  key: string;
  name: string;
}

const STORE = "lumi.pc";

function loadPc(): PairedPc | null {
  try {
    const pc = JSON.parse(localStorage.getItem(STORE) ?? "null") as PairedPc | null;
    return pc && Array.isArray(pc.hosts) && pc.hosts.length && pc.deviceId && pc.key ? pc : null;
  } catch {
    return null;
  }
}

function savePc(pc: PairedPc | null): void {
  try {
    if (pc) localStorage.setItem(STORE, JSON.stringify(pc));
    else localStorage.removeItem(STORE);
  } catch {
    // Nothing to do: the pairing lasts until the app closes
  }
}

/** The phone's name for the PC's list ("Pixel 7"), from the user agent. */
function deviceName(): string {
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent);
  return m?.[1]?.trim() || (/iPhone/.test(navigator.userAgent) ? "iPhone" : "Telefono");
}

// ---------------- signaling ----------------

type Login = { kind: "pair"; link: PairingLink } | { kind: "auth"; pc: PairedPc };

/** A logged-in signaling socket. */
class Signal {
  private channel: SignedChannel | null = null;
  private ping: number | undefined;
  onBody: (body: CallBody) => void = () => undefined;
  onClose: () => void = () => undefined;

  private constructor(private readonly ws: WebSocket) {}

  /** Tries the PC's addresses in order; resolves logged in, with the device id when it just paired. */
  static async connect(login: Login): Promise<{ signal: Signal; deviceId: string; host: string }> {
    const hosts = login.kind === "pair" ? login.link.hosts : login.pc.hosts;
    const port = login.kind === "pair" ? login.link.port : login.pc.port;
    let last: Error = new Error("Nessun indirizzo del PC.");
    for (const host of hosts) {
      try {
        const done = await Signal.tryHost(host, port, login);
        return { ...done, host };
      } catch (err) {
        last = err as Error;
        // A refusal is the PC's answer: other addresses would say the same
        if ((err as Error).name === "Denied") throw err;
      }
    }
    throw last;
  }

  private static tryHost(host: string, port: number, login: Login): Promise<{ signal: Signal; deviceId: string }> {
    return new Promise((resolve, reject) => {
      const url = `ws://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}${PHONE_PATH}`;
      const ws = new WebSocket(url);
      const clientNonce = randomKey(16);
      let serverNonce = "";
      let settled = false;
      const fail = (message: string, name = "Error") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = new Error(message);
        err.name = name;
        reject(err);
        try {
          ws.close();
        } catch {
          // already closed
        }
      };
      const timer = window.setTimeout(() => fail(`Il PC non risponde (${host}).`), 4000);
      ws.onerror = () => fail(`Il PC non risponde (${host}).`);
      ws.onclose = () => fail(`Connessione chiusa (${host}).`);
      ws.onmessage = (event) => {
        void (async () => {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (data.type === "hello" && typeof data.nonce === "string") {
            serverNonce = data.nonce;
            if (login.kind === "pair") {
              const proof = await hmac(login.link.key, proofText(serverNonce, clientNonce, login.link.id));
              ws.send(JSON.stringify({ type: "pair", pairing: login.link.id, device: deviceName(), nonce: clientNonce, proof }));
            } else {
              const proof = await hmac(login.pc.key, proofText(serverNonce, clientNonce, login.pc.deviceId));
              ws.send(JSON.stringify({ type: "auth", deviceId: login.pc.deviceId, nonce: clientNonce, proof }));
            }
            return;
          }
          if (data.type === "denied") return fail(typeof data.reason === "string" ? data.reason : "Il PC ha rifiutato il telefono.", "Denied");
          if ((data.type === "paired" || data.type === "ready") && serverNonce) {
            const key = login.kind === "pair" ? login.link.key : login.pc.key;
            // The PC proves it knows the key too: nobody else on the network can pose as it
            if (typeof data.proof !== "string" || !(await verifyHmac(key, `lumi-server|${serverNonce}|${clientNonce}`, data.proof))) {
              return fail("Il PC non ha dimostrato di essere il tuo: connessione interrotta.", "Denied");
            }
            const deviceId = login.kind === "pair" ? String(data.deviceId ?? "") : login.pc.deviceId;
            if (!deviceId) return fail("Risposta del PC non valida.");
            settled = true;
            clearTimeout(timer);
            const signal = new Signal(ws);
            signal.channel = new SignedChannel(await sessionKey(key, serverNonce, clientNonce), "phone");
            signal.listen();
            resolve({ signal, deviceId });
          }
        })().catch(() => fail("Risposta del PC non valida."));
      };
    });
  }

  private listen(): void {
    this.ws.onmessage = (event) => {
      void (async () => {
        let data: unknown;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return this.close();
        }
        const body = await this.channel!.open(data);
        if (!body) return this.close();
        if (body.type !== "pong") this.onBody(body);
      })();
    };
    this.ws.onclose = () => {
      window.clearInterval(this.ping);
      this.onClose();
    };
    this.ws.onerror = () => undefined;
    // Keeps NATs and Wi-Fi power saving from dropping an idle socket
    this.ping = window.setInterval(() => void this.send({ type: "ping" }), 20_000);
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  async send(body: CallBody): Promise<void> {
    if (this.open) this.ws.send(JSON.stringify(await this.channel!.sign(body)));
  }

  close(): void {
    window.clearInterval(this.ping);
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// ---------------- screens ----------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = { setup: $("setup"), home: $("home"), call: $("callScreen") };

function show(screen: keyof typeof screens): void {
  for (const [name, el] of Object.entries(screens)) el.hidden = name !== screen;
}

let pc = loadPc();
let signal: Signal | null = null;

function goHome(status = ""): void {
  if (!pc) return goSetup();
  show("home");
  $("homeStatus").textContent = `Abbinato a ${pc.name}`;
  $("callStatus").textContent = status;
  $<HTMLInputElement>("hostEdit").value = pc.hosts.join(", ");
  $<HTMLButtonElement>("call").disabled = false;
  renderLast();
  void probe();
}

function goSetup(status = ""): void {
  show("setup");
  $("setupStatus").textContent = status;
}

/** Logged in to the PC (reusing the open socket). Concurrent callers share one attempt. */
let opening: Promise<Signal> | null = null;

function connected(): Promise<Signal> {
  if (signal?.open) return Promise.resolve(signal);
  if (opening) return opening;
  if (!pc) return Promise.reject(new Error("Nessun PC abbinato."));
  opening = (async () => {
    try {
      const done = await Signal.connect({ kind: "auth", pc: pc! });
      // The address that answered goes first next time
      if (pc && done.host !== pc.hosts[0]) {
        pc = { ...pc, hosts: [done.host, ...pc.hosts.filter((h) => h !== done.host)] };
        savePc(pc);
      }
      signal = done.signal;
      signal.onClose = () => {
        signal = null;
      };
      signal.onBody = (body) => call?.signal(body);
      return signal;
    } finally {
      opening = null;
    }
  })();
  return opening;
}

/** Checks the PC answers, for the status dot on the home screen (the socket stays open for a call). */
async function probe(): Promise<void> {
  const name = pc?.name ?? "Lumi";
  setPcStatus("checking", "Controllo…");
  try {
    await connected();
    setPcStatus("ok", `${name} è raggiungibile`);
  } catch {
    setPcStatus("off", "PC non raggiungibile");
  }
}

function setPcStatus(state: "checking" | "ok" | "off", text: string): void {
  $("pcStatus").className = `pill ${state}`;
  $("pcStatusText").textContent = text;
}

// ---------------- small things ----------------

const LAST_KEY = "lumi.last";

/** A short vibration, where the phone has a motor. */
function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // no vibration here
  }
}

/** mm:ss, for the call's timer. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function saveLast(seconds: number): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ at: Date.now(), seconds }));
  } catch {
    // Not kept: nothing else depends on it
  }
}

/** "Ultima chiamata oggi alle 18:40, 12 min" on the home screen. */
function renderLast(): void {
  let text = "";
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as { at: number; seconds: number } | null;
    if (last) text = `Ultima chiamata ${when(last.at)}, ${last.seconds < 60 ? `${last.seconds} s` : `${Math.round(last.seconds / 60)} min`}`;
  } catch {
    // unreadable: show nothing
  }
  $("lastCall").textContent = text;
}

function when(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `oggi alle ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `ieri alle ${time}`;
  return `il ${d.toLocaleDateString("it-IT", { day: "numeric", month: "short" })}`;
}

async function pairWith(text: string): Promise<void> {
  const link = parsePairingUrl(text);
  if (!link) return goSetup("Questo non è un codice di Lumi.");
  $("setupStatus").textContent = `Mi collego a ${link.name}…`;
  try {
    const done = await Signal.connect({ kind: "pair", link });
    done.signal.close();
    pc = { hosts: [done.host, ...link.hosts.filter((h) => h !== done.host)], port: link.port, deviceId: done.deviceId, key: link.key, name: link.name };
    savePc(pc);
    goHome("Abbinato! Ora puoi chiamare Lumi.");
  } catch (err) {
    goSetup((err as Error).message);
  }
}

// ---------------- QR scanner ----------------

let scanning: { stream: MediaStream; timer: number } | null = null;

async function startScan(): Promise<void> {
  const video = $<HTMLVideoElement>("camera");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = stream;
    await video.play();
    $("scanner").hidden = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const timer = window.setInterval(() => {
      if (!video.videoWidth) return;
      // A smaller frame is enough for a QR on a screen, and much faster
      const s = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * s);
      canvas.height = Math.round(video.videoHeight * s);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (code?.data.startsWith("lumi://")) {
        stopScan();
        void pairWith(code.data);
      }
    }, 200);
    scanning = { stream, timer };
  } catch {
    goSetup("Non riesco a usare la fotocamera: incolla il link qui sotto.");
  }
}

function stopScan(): void {
  if (!scanning) return;
  window.clearInterval(scanning.timer);
  for (const track of scanning.stream.getTracks()) track.stop();
  scanning = null;
  $("scanner").hidden = true;
}

// ---------------- the face ----------------

const canvas = $<HTMLCanvasElement>("face");
const stage = $("stage");
let faceColor = "#F5F3EE";
let face: Face | null = null;

function faceLayout(): FaceLayout {
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  // About 3x the desktop face, smaller on a small screen
  const scale = Math.max(1.5, Math.min(3.2, (w * 0.8) / FACE_WIDTH, (h * 0.6) / FACE_HEIGHT));
  const fw = FACE_WIDTH * scale;
  const fh = FACE_HEIGHT * scale;
  return { scale, color: faceColor, face: { x: (w - fw) / 2, y: (h - fh) / 2.3, width: fw, height: fh }, windowWidth: w, windowHeight: h, overlay: "below" };
}

/** Where Lumi enters and leaves the phone: the top edge, above the eyes. */
function edgePoint(): { x: number; y: number } {
  const l = faceLayout();
  return { x: l.face.x + l.face.width / 2, y: -8 };
}

function ensureFace(): Face {
  if (!face) face = new Face(canvas, faceLayout());
  else face.setLayout(faceLayout());
  return face;
}

window.addEventListener("resize", () => face?.setLayout(faceLayout()));

/** Touch: a tap makes Lumi bounce, a drag makes the eyes follow the finger. */
function setupTouch(): void {
  let down: { x: number; y: number; moved: boolean } | null = null;
  const lookAt = (x: number, y: number) => {
    const l = faceLayout();
    face?.setGaze({ target: { dx: x - (l.face.x + l.face.width / 2), dy: y - (l.face.y + l.face.height / 2) }, kind: "mouse", pursuit: true });
  };
  stage.addEventListener("pointerdown", (e) => {
    down = { x: e.offsetX, y: e.offsetY, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 12) down.moved = true;
    if (down.moved) lookAt(e.offsetX, e.offsetY);
  });
  const up = () => {
    if (down && !down.moved) {
      face?.gesture("bounce");
      buzz(12);
    }
    down = null;
    lookAtUser();
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
}

/** On the phone Lumi looks at the person holding it. */
function lookAtUser(): void {
  face?.setGaze({ target: { dx: 0, dy: 0 }, kind: "user", pursuit: false });
}

setupTouch();

// ---------------- the call ----------------

/** A broken connection ends the call after this long (as on the PC). */
const LOST_MS = 10_000;

class Call {
  private readonly peer = new RTCPeerConnection({ iceServers: [] });
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuffer = new Float32Array(1024);
  private talkTimer: number | undefined;
  private lostTimer: number | undefined;
  private wakeLock: WakeLockSentinel | null = null;
  private muted = false;
  /** When the voice connected (0 until then): the timer counts from here. */
  private startedAt = 0;
  private clockTimer: number | undefined;
  private arrived = false;
  private ended = false;
  private leaving = false;
  private readonly face: Face;
  private answer: ((sdp: string) => void) | null = null;
  private refuse: ((reason: string) => void) | null = null;

  constructor(private readonly sig: Signal) {
    this.face = ensureFace();
  }

  async start(): Promise<void> {
    show("call");
    $("subtitle").textContent = "Chiamo Lumi…";
    $("timer").textContent = "00:00";
    $("mute").classList.remove("on");
    $("mute").setAttribute("aria-label", "Silenzia");
    // The face starts away: Lumi is still on the PC
    this.face.setLayout(faceLayout());
    this.face.transit("out", edgePoint(), OUT_MS);
    lookAtUser();
    void this.keepAwake();
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    for (const track of this.mic.getAudioTracks()) this.peer.addTrack(track, this.mic);
    this.channel = this.peer.createDataChannel("lumi", { ordered: true });
    this.channel.onmessage = (e) => {
      try {
        this.onData(JSON.parse(String(e.data)) as ToPhone);
      } catch {
        // not ours
      }
    };
    this.peer.ontrack = (e) => this.onVoice(e.streams[0] ?? new MediaStream([e.track]));
    this.peer.onconnectionstatechange = () => this.onState();
    await this.peer.setLocalDescription(await this.peer.createOffer());
    await this.gathered();
    const answer = new Promise<string>((resolve, reject) => {
      this.answer = resolve;
      this.refuse = (reason) => reject(new Error(reason));
      window.setTimeout(() => reject(new Error("Il PC non risponde alla chiamata.")), 15_000);
    });
    await this.sig.send({ type: "offer", sdp: this.peer.localDescription!.sdp });
    await this.peer.setRemoteDescription({ type: "answer", sdp: await answer });
  }

  /** No trickle ICE: the offer goes with all its candidates (host addresses only, no STUN). */
  private gathered(): Promise<void> {
    if (this.peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this.peer.iceGatheringState !== "complete") return;
        this.peer.removeEventListener("icegatheringstatechange", done);
        resolve();
      };
      this.peer.addEventListener("icegatheringstatechange", done);
      window.setTimeout(resolve, 2500);
    });
  }

  /** A signed message from the PC. */
  signal(body: CallBody): void {
    if (body.type === "answer") this.answer?.(body.sdp);
    else if (body.type === "busy") this.refuse?.(body.reason);
    else if (body.type === "hangup") this.finish("Il PC ha chiuso la chiamata.");
  }

  private onData(msg: ToPhone): void {
    if (msg.type === "state") {
      if (typeof msg.color === "string" && /^#[0-9a-f]{6}$/i.test(msg.color) && msg.color !== faceColor) {
        faceColor = msg.color;
        this.face.setLayout(faceLayout());
      }
      this.face.setState(msg.state as FaceState);
    } else if (msg.type === "gesture") {
      this.face.gesture(msg.gesture as FaceGesture);
    } else if (msg.type === "transit" && msg.what === "gone") {
      // Lumi left the PC: here it comes, out of the top edge
      this.arrived = true;
      $("subtitle").textContent = "";
      this.face.transit("in", edgePoint());
      window.setTimeout(lookAtUser, 1300);
    } else if (msg.type === "subtitle") {
      const el = $("subtitle");
      el.textContent = msg.text;
      // A finished line fades after a while, like the PC's bubble
      if (msg.done) window.setTimeout(() => el.textContent === msg.text && (el.textContent = ""), 6000);
    } else if (msg.type === "hangup") {
      // The PC hangs up: Lumi leaves the phone, then the PC plays its arrival
      void this.leave(false);
    }
  }

  private onVoice(stream: MediaStream): void {
    const el = $<HTMLAudioElement>("voice");
    // Played by an <audio> element: Android's echo canceller uses it as the reference
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    try {
      this.audio = new AudioContext();
      this.analyser = this.audio.createAnalyser();
      this.analyser.fftSize = 1024;
      this.audio.createMediaStreamSource(stream).connect(this.analyser);
      this.face.setLevelSource(() => this.level());
      // The talk pulse follows the voice actually playing here
      let quietSince = 0;
      this.talkTimer = window.setInterval(() => {
        const loud = this.level() > 0.012;
        const now = performance.now();
        if (loud) quietSince = 0;
        else if (!quietSince) quietSince = now;
        this.face.setTalking(loud || (quietSince > 0 && now - quietSince < 300));
      }, 50);
    } catch {
      // No pulse: the voice still plays
    }
  }

  private level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) sum += v * v;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  private onState(): void {
    const state = this.peer.connectionState;
    if (state === "connected") {
      window.clearTimeout(this.lostTimer);
      this.lostTimer = undefined;
      if (!this.arrived) $("subtitle").textContent = "Lumi sta arrivando…";
      if (!this.startedAt) {
        this.startedAt = Date.now();
        buzz(20);
        this.clockTimer = window.setInterval(() => $("timer").textContent = clock(this.elapsed()), 1000);
      }
    } else if (state === "disconnected" || state === "failed") {
      if (state === "failed") return this.finish("Linea persa.");
      $("subtitle").textContent = "Linea disturbata…";
      this.lostTimer ??= window.setTimeout(() => this.finish("Linea persa."), LOST_MS);
    }
  }

  private send(msg: ToPc): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(msg));
  }

  /** Lumi leaves the phone (sucked into the top edge); `mine`: this phone hung up. */
  async leave(mine: boolean): Promise<void> {
    if (this.leaving || this.ended) return;
    this.leaving = true;
    if (!this.arrived) {
      // Not here yet: just cancel
      if (this.channel?.readyState === "open") this.send({ type: "hangup" });
      else await this.sig.send({ type: "hangup" });
      return this.finish("");
    }
    this.face.setTalking(false);
    const ms = this.face.transit("out", edgePoint());
    await new Promise((r) => window.setTimeout(r, ms));
    // "gone" answers the PC's hang-up; "hangup" is ours
    if (this.channel?.readyState === "open") this.send(mine ? { type: "hangup" } : { type: "transit", what: "gone" });
    else await this.sig.send({ type: "hangup" });
    // Let the message leave before closing
    window.setTimeout(() => this.finish(""), 300);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
    this.send({ type: "mute", muted });
  }

  isMuted(): boolean {
    return this.muted;
  }

  ptt(down: boolean): void {
    this.send({ type: "ptt", down });
  }

  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      // The screen may sleep: the call goes on
    }
  }

  /** Whole seconds since the voice connected. */
  private elapsed(): number {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  finish(status: string): void {
    if (this.ended) return;
    this.ended = true;
    window.clearTimeout(this.lostTimer);
    window.clearInterval(this.talkTimer);
    window.clearInterval(this.clockTimer);
    if (this.startedAt) saveLast(this.elapsed());
    this.refuse?.(status || "Chiamata chiusa.");
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    try {
      this.channel?.close();
      this.peer.close();
    } catch {
      // already closed
    }
    void this.audio?.close().catch(() => undefined);
    void this.wakeLock?.release().catch(() => undefined);
    $<HTMLAudioElement>("voice").srcObject = null;
    this.face.setLevelSource(null);
    this.face.setTalking(false);
    this.face.resetTransit();
    if (call === this) call = null;
    goHome(status);
  }
}

let call: Call | null = null;

async function startCall(): Promise<void> {
  if (call) return;
  const button = $<HTMLButtonElement>("call");
  button.disabled = true;
  $("callStatus").textContent = "Mi collego al PC…";
  let current: Call | null = null;
  try {
    const sig = await connected();
    current = call = new Call(sig);
    await current.start();
  } catch (err) {
    const message = (err as Error).name === "NotAllowedError" ? "Serve il permesso del microfono per parlare con Lumi." : (err as Error).message;
    if (current) current.finish(message);
    else goHome(message);
  } finally {
    button.disabled = false;
  }
}

// ---------------- buttons ----------------

$("scan").addEventListener("click", () => void startScan());
$("scanCancel").addEventListener("click", stopScan);
$("pasteGo").addEventListener("click", () => void pairWith($<HTMLTextAreaElement>("pasteLink").value));
$("call").addEventListener("click", () => void startCall());
$("hangup").addEventListener("click", () => {
  buzz(30);
  void call?.leave(true);
});
$("mute").addEventListener("click", () => {
  if (!call) return;
  call.setMuted(!call.isMuted());
  $("mute").classList.toggle("on", call.isMuted());
  $("mute").setAttribute("aria-label", call.isMuted() ? "Riattiva il microfono" : "Silenzia");
  buzz(8);
});
const ptt = $("ptt");
const pttDown = (e: Event) => {
  e.preventDefault();
  ptt.classList.add("down");
  call?.ptt(true);
};
const pttUp = () => {
  if (!ptt.classList.contains("down")) return;
  ptt.classList.remove("down");
  call?.ptt(false);
};
ptt.addEventListener("pointerdown", pttDown);
ptt.addEventListener("pointerup", pttUp);
ptt.addEventListener("pointercancel", pttUp);
ptt.addEventListener("pointerleave", pttUp);
$("hostSave").addEventListener("click", () => {
  if (!pc) return;
  const hosts = $<HTMLInputElement>("hostEdit")
    .value.split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  if (!hosts.length) return;
  pc = { ...pc, hosts };
  savePc(pc);
  signal?.close();
  goHome("Indirizzo salvato.");
});
$("unpair").addEventListener("click", () => {
  if (!confirm("Dimenticare questo PC? Per richiamare Lumi dovrai abbinare di nuovo il telefono.")) return;
  signal?.close();
  signal = null;
  pc = null;
  savePc(null);
  goSetup("Telefono scollegato. Ricordati di rimuoverlo anche dalle impostazioni di Lumi.");
});

// A pairing link opened directly (lumi://pair?... or ?pair=... when served by the PC for a test)
const opened = new URLSearchParams(location.search).get("pair");
if (opened) void pairWith(opened);
else if (pc) goHome();
else goSetup();
