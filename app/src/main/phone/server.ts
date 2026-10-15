// The phone link's server (phase 15): the only part of Lumi listening on
// the local network (the sidecar stays on 127.0.0.1). A WebSocket at
// /lumi for pairing, login and the signed call signaling; static files at
// /app/ (the phone app's web build), handy to try a call from a browser on
// this PC (http://localhost is a secure context, other addresses aren't).
// Off until the user enables the phone in the settings.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PAIRING_MS,
  PHONE_PATH,
  proofText,
  randomKey,
  sessionKey,
  SignedChannel,
  verifyHmac,
  hmac,
  type CallBody,
  type PairingLink,
} from "../../shared/phone";
import { log } from "../log";
import type { PhoneDevices } from "./devices";

export interface PhoneSession {
  deviceId: string;
  deviceName: string;
  /** Sends a signed message to the phone. */
  send(body: CallBody): Promise<void>;
  close(): void;
}

export interface PhoneServerHandlers {
  /** A logged-in phone sent a signed message. */
  message(session: PhoneSession, body: CallBody): void;
  /** A logged-in phone went away. */
  closed(session: PhoneSession): void;
  /** A phone was just paired (the settings window updates). */
  paired(name: string): void;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".map": "application/json" };
/** A connection must log in this fast. */
const LOGIN_MS = 10_000;

/** The PC's IPv4 addresses a phone may reach (LAN first, then the others: Tailscale, VPNs). */
export function localAddresses(): string[] {
  const out: { address: string; score: number }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const lan = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name);
      out.push({ address: a.address, score: (lan ? 2 : 1) - (virtual ? 2 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score).map((a) => a.address);
}

export class PhoneServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private pairing: { id: string; key: string; until: number } | null = null;
  private port = 0;

  constructor(
    private readonly devices: PhoneDevices,
    private readonly handlers: PhoneServerHandlers,
    /** The phone app's web build (served at /app/), or null. */
    private readonly appDir: string | null,
    private readonly pcName: string,
  ) {}

  get listening(): boolean {
    return this.server !== null;
  }

  async start(port: number, host = "0.0.0.0"): Promise<void> {
    if (this.server && this.port === port) return;
    await this.stop();
    const server = createServer((req, res) => this.serveFile(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== PHONE_PATH) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    this.wss = wss;
    this.port = port;
    log.info(`Phone server listening on port ${port}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    this.wss = null;
  }

  /** A new pairing: the link for the QR code, valid 5 minutes. */
  startPairing(): PairingLink {
    this.pairing = { id: randomKey(9), key: randomKey(32), until: Date.now() + PAIRING_MS };
    return { hosts: localAddresses(), port: this.port, id: this.pairing.id, key: this.pairing.key, name: this.pcName };
  }

  private serveFile(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!this.appDir || !path.startsWith("/app/")) {
      res.writeHead(404).end();
      return;
    }
    const rel = normalize(decodeURIComponent(path.slice(5)) || "index.html").replace(/^(\.\.[\\/])+/, "");
    const file = join(this.appDir, rel);
    if (!file.startsWith(this.appDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    const nonce = randomKey(16);
    let session: PhoneSession | null = null;
    let channel: SignedChannel | null = null;
    const who = req.socket.remoteAddress ?? "?";
    const timer = setTimeout(() => {
      if (!session) ws.close(4401, "login");
    }, LOGIN_MS);
    const sendJson = (data: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };
    sendJson({ type: "hello", nonce, name: this.pcName });
    ws.on("message", (raw) => {
      void (async () => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return ws.close(4400, "json");
        }
        if (!session) {
          const done = await this.login(data, nonce);
          if (!done) {
            log.warn(`Phone login refused from ${who}`);
            sendJson({ type: "denied", reason: "Questo telefono non è abbinato (o il codice è scaduto): abbinalo di nuovo dalle impostazioni di Lumi." });
            return ws.close(4403, "denied");
          }
          clearTimeout(timer);
          channel = new SignedChannel(done.session, "pc");
          const ch = channel;
          session = {
            deviceId: done.id,
            deviceName: done.name,
            send: async (body) => sendJson(await ch.sign(body)),
            close: () => ws.close(1000),
          };
          sendJson(done.reply);
          log.info(`Phone "${done.name}" logged in`);
          return;
        }
        const body = await channel!.open(data);
        if (!body) {
          log.warn("Phone message with a bad signature: closing");
          return ws.close(4403, "signature");
        }
        if (body.type === "ping") return void session.send({ type: "pong" });
        this.handlers.message(session, body);
      })().catch((err: unknown) => log.warn("Phone message failed", err));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (session) this.handlers.closed(session);
    });
    ws.on("error", () => undefined);
  }

  /** Pairing with the code of the QR, or login of a paired phone: the session key and the reply, or null. */
  private async login(data: Record<string, unknown>, serverNonce: string): Promise<{ id: string; name: string; session: string; reply: unknown } | null> {
    const clientNonce = typeof data.nonce === "string" && /^[\w-]{16,64}$/.test(data.nonce) ? data.nonce : null;
    if (!clientNonce || typeof data.proof !== "string") return null;
    if (data.type === "pair") {
      const p = this.pairing;
      if (!p || Date.now() > p.until || data.pairing !== p.id) return null;
      if (!(await verifyHmac(p.key, proofText(serverNonce, clientNonce, p.id), data.proof))) return null;
      // The code works once: the key now belongs to this phone
      this.pairing = null;
      const id = randomKey(9);
      const name = typeof data.device === "string" && data.device.trim() ? data.device.trim().slice(0, 40) : "Telefono";
      this.devices.add({ id, name, key: p.key, paired: new Date().toISOString(), lastSeen: new Date().toISOString() });
      this.handlers.paired(name);
      log.info(`Phone "${name}" paired`);
      return { id, name, session: await sessionKey(p.key, serverNonce, clientNonce), reply: { type: "paired", deviceId: id, proof: await hmac(p.key, `lumi-server|${serverNonce}|${clientNonce}`) } };
    }
    if (data.type === "auth" && typeof data.deviceId === "string") {
      const phone = this.devices.get(data.deviceId);
      if (!phone || !(await verifyHmac(phone.key, proofText(serverNonce, clientNonce, phone.id), data.proof))) return null;
      this.devices.seen(phone.id);
      return { id: phone.id, name: phone.name, session: await sessionKey(phone.key, serverNonce, clientNonce), reply: { type: "ready", proof: await hmac(phone.key, `lumi-server|${serverNonce}|${clientNonce}`) } };
    }
    return null;
  }
}
