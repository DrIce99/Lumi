// Wake word: the spotting rule, the pre-roll buffer, the microphone in use by other apps, the /wake client.
import assert from "node:assert/strict";
import test from "node:test";
import { muteConsole } from "../src/main/log";
import type { SocketLike } from "../src/main/socket";
import { otherMicUsers, parseMicUse } from "../src/main/voice/micUse";
import { WakeClient } from "../src/main/voice/wakeClient";
import { PcmRing, PREROLL_BYTES, WakeSpotter } from "../src/main/voice/wakeSpotter";

muteConsole();

test("the wake word fires on two frames in a row above the threshold, 30% higher while Lumi talks", () => {
  const s = new WakeSpotter();
  assert.equal(s.push([0.9, 0.1, 0.9], 0.5, false), false, "isolated peaks");
  assert.equal(s.push([0.55], 0.5, false), true, "the streak continues across batches");
  assert.equal(s.push([0.6], 0.5, false), false, "and starts over after firing");
  s.reset();
  assert.equal(s.push([0.6, 0.6], 0.5, true), false, "0.6 < 0.65 while speaking");
  assert.equal(s.push([0.7, 0.7], 0.5, true), true);
});

test("the pre-roll keeps the last 1.5 s of speech", () => {
  const ring = new PcmRing();
  for (let i = 0; i < 100; i++) ring.push(new Uint8Array(1024).fill(i));
  assert.ok(ring.size >= PREROLL_BYTES && ring.size < PREROLL_BYTES + 1024);
  const chunks = ring.take();
  assert.equal(chunks.at(-1)![0], 99, "the newest last");
  assert.equal(ring.size, 0);
});

const STORE = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
const REG = [
  STORE,
  "    Value    REG_SZ    Allow",
  "",
  `${STORE}\\MSTeams_8wekyb3d8bbwe`,
  "    Value    REG_SZ    Allow",
  "    LastUsedTimeStart    REG_QWORD    0x1dcb6df63904305",
  "    LastUsedTimeStop    REG_QWORD    0x0",
  "",
  `${STORE}\\NonPackaged`,
  "    Value    REG_SZ    Allow",
  "",
  `${STORE}\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dcad3d62b869cb",
  "    LastUsedTimeStop    REG_QWORD    0x1dcad3d6818f459",
  "",
  `${STORE}\\NonPackaged\\C:#Users#me#AppData#Local#Discord#app-1.0#Discord.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dcad3d62b869cb",
  "    LastUsedTimeStop    REG_QWORD    0x0",
  "",
  `${STORE}\\NonPackaged\\C:#lumi#node_modules#electron#dist#electron.exe`,
  "    LastUsedTimeStart    REG_QWORD    0x1dcad3d62b869cb",
  "    LastUsedTimeStop    REG_QWORD    0x0",
].join("\r\n");

test("apps recording now are read from the privacy store; Lumi and the apps it listens to don't count", () => {
  const users = parseMicUse(REG);
  assert.deepEqual(
    users.map((u) => u.name),
    ["MSTeams_8wekyb3d8bbwe", "Discord.exe", "electron.exe"],
  );
  assert.equal(users[1].id, "C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0\\Discord.exe");
  const others = otherMicUsers(users, "C:\\lumi\\node_modules\\electron\\dist\\electron.exe", ["Discord"]);
  assert.deepEqual(
    others.map((u) => u.name),
    ["MSTeams_8wekyb3d8bbwe"],
  );
});

class FakeSocket implements SocketLike {
  binaryType = "";
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

test("the /wake client asks for the model, is ready only when it loads, and forwards scores", () => {
  const sockets: FakeSocket[] = [];
  const scores: number[][] = [];
  const client = new WakeClient(() => "ws://sidecar/wake", { scores: (s) => scores.push(s) }, () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  client.set(true, "lumi");
  const ws = sockets[0];
  ws.open();
  assert.deepEqual(ws.sent, [{ model: "lumi" }]);
  assert.equal(client.ready, false);
  client.audio(new Uint8Array(4));
  assert.equal(ws.sent.length, 1, "no audio before the model is ready");
  ws.reply({ type: "ready", model: "lumi" });
  assert.equal(client.ready, true);
  client.reset();
  client.audio(new Uint8Array([1, 2]));
  assert.deepEqual(ws.sent[1], { reset: true });
  assert.ok(ws.sent[2] instanceof Uint8Array && (ws.sent[2] as Uint8Array).byteLength === 6, "[uint32 id][pcm]");
  ws.reply({ type: "scores", scores: [0.1, 0.8] });
  assert.deepEqual(scores, [[0.1, 0.8]]);

  ws.reply({ type: "error", missing: true, error: "lumi.onnx not found" });
  assert.equal(client.state, "missing");
  assert.equal(client.ready, false);
  client.set(false, "lumi");
  assert.equal(client.state, "off");
});
