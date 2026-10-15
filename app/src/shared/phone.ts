// The phone link (phase 15), shared by the PC (main/phone/) and the phone
// app (phone/): the pairing link in the QR code, the challenge-response
// login and the signed signaling messages. WebCrypto only, so the same
// code runs in Node and in the phone's WebView.
//
// Security: the QR carries a random 256-bit key, shown only on the PC's
// screen. Every signaling message is signed with a session key derived
// from it (HMAC-SHA256, with a sequence number against replays), so the
// WebRTC offer and answer - which carry the DTLS fingerprints - can't be
// changed on the way: audio and data then travel encrypted (DTLS-SRTP).
// The WebSocket itself is plain: no self-signed certificate to pin.

export const PHONE_PORT = 47821;
export const PHONE_PATH = "/lumi";
/** A pairing code is valid this long after it appears on the PC. */
export const PAIRING_MS = 5 * 60_000;

export interface PairingLink {
  /** The PC's addresses (LAN, Tailscale...): the phone tries them in order. */
  hosts: string[];
  port: number;
  /** Which pairing on the PC this is. */
  id: string;
  /** The shared key, base64url (32 bytes). */
  key: string;
  /** The PC's name, shown on the phone. */
  name: string;
}

export function pairingUrl(link: PairingLink): string {
  const q = new URLSearchParams({ h: link.hosts.join(","), p: String(link.port), i: link.id, k: link.key, n: link.name });
  return `lumi://pair?${q.toString()}`;
}

/** Reads a lumi://pair link (from the QR code, or pasted); null when it isn't one. */
export function parsePairingUrl(text: string): PairingLink | null {
  const m = /^lumi:\/\/pair\?(.+)$/.exec(text.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const hosts = (q.get("h") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const port = Number(q.get("p"));
  const id = q.get("i") ?? "";
  const key = q.get("k") ?? "";
  if (!hosts.length || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[\w-]{8,64}$/.test(id) || !/^[\w-]{40,48}$/.test(key)) return null;
  return { hosts, port, id, key, name: q.get("n") ?? "Lumi" };
}

// ---------------- bytes ----------------

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomKey(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const encoder = new TextEncoder();

async function hmacKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmac(key: string, text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), encoder.encode(text))));
}

/** Constant-time check of an HMAC. */
export async function verifyHmac(key: string, text: string, mac: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(key), fromBase64Url(mac), encoder.encode(text));
  } catch {
    return false;
  }
}

/** The login proof: the device knows the key, for this server nonce and its own. */
export function proofText(serverNonce: string, clientNonce: string, deviceId: string): string {
  return `lumi-auth|${serverNonce}|${clientNonce}|${deviceId}`;
}

/** The session key: fresh per connection, from the device key and both nonces. */
export async function sessionKey(deviceKey: string, serverNonce: string, clientNonce: string): Promise<string> {
  return hmac(deviceKey, `lumi-session|${serverNonce}|${clientNonce}`);
}

// ---------------- messages ----------------

/** Before login: unsigned. */
export type HelloMessage = { type: "hello"; nonce: string; name: string };
export type PairMessage = { type: "pair"; pairing: string; device: string; nonce: string; proof: string };
export type AuthMessage = { type: "auth"; deviceId: string; nonce: string; proof: string };
export type PairedMessage = { type: "paired"; deviceId: string; proof: string };
export type ReadyMessage = { type: "ready"; proof: string };
export type DeniedMessage = { type: "denied"; reason: string };

/** After login: signed. */
export type CallBody =
  | { type: "call" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "busy"; reason: string }
  | { type: "hangup" }
  | { type: "ping" }
  | { type: "pong" };

export interface Signed {
  seq: number;
  body: CallBody;
  mac: string;
}

/** Signs and checks the messages of one session, in order (a replayed or reordered message fails). */
export class SignedChannel {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly key: string,
    /** "pc" or "phone": a message can't be bounced back to its sender. */
    private readonly me: "pc" | "phone",
  ) {}

  async sign(body: CallBody): Promise<Signed> {
    const seq = ++this.sent;
    return { seq, body, mac: await hmac(this.key, `${this.me}|${seq}|${JSON.stringify(body)}`) };
  }

  /** The body of a valid message, or null. */
  async open(message: unknown): Promise<CallBody | null> {
    const m = message as Partial<Signed> | null;
    if (!m || typeof m.seq !== "number" || typeof m.mac !== "string" || !m.body || typeof m.body !== "object") return null;
    if (m.seq <= this.received) return null;
    const from = this.me === "pc" ? "phone" : "pc";
    if (!(await verifyHmac(this.key, `${from}|${m.seq}|${JSON.stringify(m.body)}`, m.mac))) return null;
    this.received = m.seq;
    return m.body as CallBody;
  }
}

// ---------------- the data channel (inside DTLS: not signed again) ----------------

/** PC -> phone: the face and the call. */
export type ToPhone =
  | { type: "state"; state: unknown; color?: string }
  | { type: "gesture"; gesture: string }
  | { type: "transit"; what: "gone" }
  | { type: "subtitle"; text: string; done: boolean }
  | { type: "hangup" };

/** Phone -> PC. */
export type ToPc = { type: "transit"; what: "gone" } | { type: "ptt"; down: boolean } | { type: "mute"; muted: boolean } | { type: "hangup" };
