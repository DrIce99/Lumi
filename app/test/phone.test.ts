// Lumi on the phone (phase 15): the pairing link, the signed signaling, the
// paired-phone store, the server's login and the leave/arrive animation.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { transitPoint } from "../src/main/layout";
import { muteConsole } from "../src/main/log";
import { PhoneDevices, type Cipher } from "../src/main/phone/devices";
import { PhoneServer, type PhoneSession } from "../src/main/phone/server";
import { capsuleTube, IN_MS, OUT_MS, stretchedTube, transitFrame } from "../src/renderer/face/transit";
import { hmac, pairingUrl, parsePairingUrl, proofText, randomKey, sessionKey, SignedChannel, type CallBody } from "../src/shared/phone";
import type { FaceLayout } from "../src/shared/types";

muteConsole();

/** Not DPAPI: a reversible scramble, enough to see that the file isn't plain JSON. */
const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString(),
};

test("pairing link: round trip, and anything else is refused", () => {
  const link = { hosts: ["192.168.1.20", "100.64.0.3"], port: 47821, id: randomKey(9), key: randomKey(32), name: "PC di Diego" };
  const url = pairingUrl(link);
  assert.match(url, /^lumi:\/\/pair\?/);
  assert.deepEqual(parsePairingUrl(url), link);
  assert.deepEqual(parsePairingUrl(`  ${url}\n`), link);
  assert.equal(parsePairingUrl("https://example.com"), null);
  assert.equal(parsePairingUrl(url.replace(/k=[^&]+/, "k=short")), null);
  assert.equal(parsePairingUrl(url.replace(/p=\d+/, "p=99999")), null);
  assert.equal(parsePairingUrl(url.replace(/h=[^&]+/, "h=")), null);
});

test("signed channel: in order, from the other side only, never replayed or changed", async () => {
  const key = randomKey(32);
  const pc = new SignedChannel(key, "pc");
  const phone = new SignedChannel(key, "phone");
  const offer = await phone.sign({ type: "offer", sdp: "v=0" });
  assert.deepEqual(await pc.open(offer), { type: "offer", sdp: "v=0" });
  // Replayed
  assert.equal(await pc.open(offer), null);
  // Changed on the way (another DTLS fingerprint)
  const next = await phone.sign({ type: "offer", sdp: "v=0 a" });
  assert.equal(await pc.open({ ...next, body: { type: "offer", sdp: "v=0 evil" } }), null);
  // Bounced back to its sender
  const answer = await pc.sign({ type: "answer", sdp: "v=0" });
  assert.equal(await new SignedChannel(key, "pc").open(answer), null);
  assert.deepEqual(await phone.open(answer), { type: "answer", sdp: "v=0" });
  // Another key
  assert.equal(await new SignedChannel(randomKey(32), "phone").open(await pc.sign({ type: "hangup" })), null);
  assert.equal(await pc.open(null), null);
  assert.equal(await pc.open({ seq: 99, body: { type: "hangup" } }), null);
});

test("paired phones: kept encrypted, revoked for good", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-phone-"));
  try {
    const devices = new PhoneDevices(dir, cipher);
    devices.add({ id: "abc", name: "Pixel", key: randomKey(32), paired: "2026-10-01T10:00:00Z", lastSeen: "2026-10-01T10:00:00Z" });
    assert.doesNotMatch(readFileSync(join(dir, "phones.bin"), "latin1"), /Pixel/);
    const again = new PhoneDevices(dir, cipher);
    assert.equal(again.get("abc")?.name, "Pixel");
    assert.equal(again.revoke("abc"), true);
    assert.equal(again.revoke("abc"), false);
    assert.equal(new PhoneDevices(dir, cipher).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A phone speaking the protocol: logs in, then signs its messages. */
async function phoneLogin(port: number, login: (hello: { nonce: string }, nonce: string) => Promise<object>): Promise<{ ws: WebSocket; reply: Record<string, unknown>; nonce: string; serverNonce: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lumi`);
  const nonce = randomKey(16);
  const messages: Record<string, unknown>[] = [];
  let wake: (() => void) | null = null;
  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
    wake?.();
  });
  const next = async () => {
    while (!messages.length) await new Promise<void>((r) => (wake = r));
    return messages.shift()!;
  };
  const hello = (await next()) as { nonce: string };
  ws.send(JSON.stringify(await login(hello, nonce)));
  return { ws, reply: await next(), nonce, serverNonce: hello.nonce };
}

test("server: one-time pairing, then login with the device key; bad proofs are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumi-phone-"));
  const devices = new PhoneDevices(dir, cipher);
  const received: CallBody[] = [];
  const paired: string[] = [];
  let lastSession: PhoneSession | null = null;
  const server = new PhoneServer(
    devices,
    {
      message: (s, body) => {
        lastSession = s;
        received.push(body);
      },
      closed: () => undefined,
      paired: (name) => paired.push(name),
    },
    null,
    "PC",
  );
  const port = 40000 + Math.floor(Math.random() * 9000);
  await server.start(port, "127.0.0.1");
  try {
    const link = server.startPairing();
    assert.equal(link.port, port);
    // A wrong key can't pair
    const wrong = await phoneLogin(port, async (h, n) => ({ type: "pair", pairing: link.id, device: "X", nonce: n, proof: await hmac(randomKey(32), proofText(h.nonce, n, link.id)) }));
    assert.equal(wrong.reply.type, "denied");
    wrong.ws.close();

    const pair = await phoneLogin(port, async (h, n) => ({ type: "pair", pairing: link.id, device: "Pixel 7", nonce: n, proof: await hmac(link.key, proofText(h.nonce, n, link.id)) }));
    assert.equal(pair.reply.type, "paired");
    assert.equal(pair.reply.proof, await hmac(link.key, `lumi-server|${pair.serverNonce}|${pair.nonce}`));
    const deviceId = String(pair.reply.deviceId);
    assert.deepEqual(paired, ["Pixel 7"]);
    assert.equal(devices.get(deviceId)?.name, "Pixel 7");
    pair.ws.close();

    // The code works once
    const reuse = await phoneLogin(port, async (h, n) => ({ type: "pair", pairing: link.id, device: "Y", nonce: n, proof: await hmac(link.key, proofText(h.nonce, n, link.id)) }));
    assert.equal(reuse.reply.type, "denied");
    reuse.ws.close();

    // Login, then a signed message reaches the handler; a forged one closes the socket
    const auth = await phoneLogin(port, async (h, n) => ({ type: "auth", deviceId, nonce: n, proof: await hmac(link.key, proofText(h.nonce, n, deviceId)) }));
    assert.equal(auth.reply.type, "ready");
    const channel = new SignedChannel(await sessionKey(link.key, auth.serverNonce, auth.nonce), "phone");
    auth.ws.send(JSON.stringify(await channel.sign({ type: "hangup" })));
    const closed = new Promise<number>((r) => auth.ws.on("close", (code) => r(code)));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, [{ type: "hangup" }]);
    assert.equal(lastSession!.deviceName, "Pixel 7");
    auth.ws.send(JSON.stringify({ seq: 5, body: { type: "hangup" }, mac: "AAAA" }));
    assert.equal(await closed, 4403);

    // A revoked phone can't log in any more
    devices.revoke(deviceId);
    const revoked = await phoneLogin(port, async (h, n) => ({ type: "auth", deviceId, nonce: n, proof: await hmac(link.key, proofText(h.nonce, n, deviceId)) }));
    assert.equal(revoked.reply.type, "denied");
    revoked.ws.close();
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transit: the eyes stretch into the edge point, vanish, then come back whole", () => {
  const eyes = [
    { cx: 60, cy: 60, width: 14, height: 44 },
    { cx: 96, cy: 60, width: 14, height: 44 },
  ];
  const target = { x: 78, y: 0 };
  const out = { kind: "out" as const, start: 0, target };
  assert.equal(transitFrame(out, 50, eyes).tubes, null);
  assert.ok(transitFrame(out, 50, eyes).wide > 1);
  const mid = transitFrame(out, 500, eyes);
  assert.ok(mid.tubes && mid.tubes.length === 2);
  // Longer than the eye, thinner, and pulled toward the point
  for (const tube of mid.tubes!) {
    const top = Math.min(...tube.map((p) => p.y - p.r));
    const bottom = Math.max(...tube.map((p) => p.y + p.r));
    assert.ok(bottom - top > 44, `${bottom - top}`);
    assert.ok(top < 30, `${top}`);
    assert.ok(Math.max(...tube.map((p) => p.r)) <= 7.5);
  }
  const gone = transitFrame(out, OUT_MS + 10, eyes);
  assert.equal(gone.hidden, true);
  assert.equal(gone.done, true);

  const back = { kind: "in" as const, start: 0, target };
  assert.equal(transitFrame(back, 10, eyes).hidden, true);
  assert.ok(transitFrame(back, 10, eyes).glint > 0);
  const end = transitFrame(back, IN_MS + 10, eyes);
  assert.equal(end.done, true);
  assert.equal(end.tubes, null);
  assert.equal(end.hidden, false);

  // At rest the tube is the capsule itself
  const cap = capsuleTube(eyes[0]);
  assert.equal(cap.r, 7);
  const rest = stretchedTube(eyes[0], target, 0, 0, -1);
  assert.ok(Math.abs(Math.min(...rest.map((p) => p.y - p.r)) - 38) < 1.5);
});

test("transit point: the window edge toward the nearest screen edge", () => {
  const layout: FaceLayout = { scale: 1, color: "#FFFFFF", face: { x: 20, y: 120, width: 160, height: 120 }, windowWidth: 200, windowHeight: 240, overlay: "above" };
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  // Near the bottom of the screen: down
  assert.deepEqual(transitPoint(layout, { x: 900, y: 1040 - 240, width: 200, height: 240 }, area), { x: 100, y: 234 });
  // Near the left edge: left
  assert.deepEqual(transitPoint(layout, { x: 0, y: 400, width: 200, height: 240 }, area), { x: 6, y: 180 });
  // Near the right edge: right
  assert.deepEqual(transitPoint(layout, { x: 1720, y: 400, width: 200, height: 240 }, area), { x: 194, y: 180 });
});
