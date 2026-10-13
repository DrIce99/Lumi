// The /apps client: what it asks the sidecar, what it reports, when a call is on.
import assert from "node:assert/strict";
import test from "node:test";
import { muteConsole } from "../src/main/log";
import type { SocketLike } from "../src/main/socket";
import { AppAudioClient, type AppUtterance } from "../src/main/voice/appAudio";

muteConsole();

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  text(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

test("AppAudioClient: asks for the apps, reports what is heard and the status, knows when a call is on", () => {
  let now = 1_000_000;
  const sockets: FakeSocket[] = [];
  const heard: AppUtterance[] = [];
  const statuses: Record<string, string>[] = [];
  const client = new AppAudioClient(() => "ws://x/apps", { heard: (u) => heard.push(u), status: (s) => statuses.push(s) }, () => now, () => {
    sockets.push(new FakeSocket());
    return sockets[sockets.length - 1];
  });
  client.set(["Discord"], ["Lumi"]);
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { apps: ["Discord"], vocabulary: ["Lumi"] });
  client.set(["Discord"], ["Lumi"]);
  assert.equal(sockets[0].sent.length, 1, "the same request is not sent again");
  assert.equal(client.active(), false);
  sockets[0].text({ type: "status", apps: { Discord: "in ascolto" } });
  sockets[0].text({ type: "heard", app: "Discord", text: "Ciao a tutti", durationMs: 1200, voiceprint: [0.6, 0.8] });
  assert.deepEqual(statuses, [{ Discord: "in ascolto" }]);
  assert.deepEqual(heard, [{ app: "Discord", text: "Ciao a tutti", durationMs: 1200, voiceprint: [0.6, 0.8] }]);
  assert.equal(client.active(), true);
  now += 120_000;
  assert.equal(client.active(), false, "nobody heard for two minutes: the call is over");
  client.set(null);
  assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(statuses[statuses.length - 1], {});
});
