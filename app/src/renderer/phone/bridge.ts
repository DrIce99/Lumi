// The phone bridge: a hidden window that holds the WebRTC call with the
// phone. Chromium already has WebRTC (no native module in Node). The
// phone's microphone goes through the same VAD as the face window's and
// its frames reach the turn manager; Lumi's voice is played by the same
// Player into the outgoing track instead of the speakers. A data channel
// carries the face's state and the call's control messages.
import type { PhoneBridgeApi } from "../../shared/types";
import { Player } from "../audio/player";
import { Listener } from "../audio/vad";

declare global {
  interface Window {
    bridge: PhoneBridgeApi;
  }
}

const api = window.bridge;
let pc: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let remote: MediaStream | null = null;
let remoteReady: (stream: MediaStream) => void = () => undefined;
let remotePromise = new Promise<MediaStream>((resolve) => (remoteReady = resolve));
let outgoing: MediaStreamAudioDestinationNode | null = null;
/** Chromium only feeds a remote track into WebAudio while a media element plays it (muted here). */
const sink = new Audio();
sink.muted = true;

const player = new Player(
  {
    event: (event) => api.playback(event),
    sentenceStart: () => undefined,
    sentenceEnd: () => undefined,
  },
  (ctx) => (outgoing = ctx.createMediaStreamDestination()),
);
player.start();

const listener = new Listener((event) => api.mic(event), { stream: () => remotePromise, assets: "../vad/" });
let micQueue: Promise<void> = Promise.resolve();
api.onMicControl((control) => {
  micQueue = micQueue.then(() => listener.apply(control)).catch((err: unknown) => api.mic({ type: "error", message: String(err) }));
});

api.onAudioBegin((msg) => player.begin(msg));
api.onAudioChunk((msg) => player.chunk(msg));
api.onAudioEnd(({ id }) => player.end(id));
api.onAudioStop(({ fadeMs }) => player.stop(fadeMs));

/** The offer is complete (no trickle ICE): the answer goes back once candidates are gathered. */
async function gathered(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (peer.iceGatheringState === "complete") resolve();
    };
    peer.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 2500);
  });
}

function close(): void {
  channel?.close();
  pc?.close();
  pc = null;
  channel = null;
  remote = null;
  sink.srcObject = null;
  remotePromise = new Promise<MediaStream>((resolve) => (remoteReady = resolve));
}

api.onOffer(async ({ sdp }) => {
  try {
    close();
    // Same network (LAN or Tailscale): host candidates are enough, no STUN server
    const peer = new RTCPeerConnection({ iceServers: [] });
    pc = peer;
    peer.addEventListener("track", (e) => {
      remote = e.streams[0] ?? new MediaStream([e.track]);
      sink.srcObject = remote;
      void sink.play().catch(() => undefined);
      remoteReady(remote);
      api.log("phone microphone track received");
    });
    peer.addEventListener("datachannel", (e) => {
      channel = e.channel;
      channel.addEventListener("open", () => api.connection("open"));
      channel.addEventListener("message", (m) => {
        try {
          api.message(JSON.parse(String(m.data)));
        } catch {
          // not ours
        }
      });
      channel.addEventListener("close", () => api.connection("closed"));
    });
    peer.addEventListener("connectionstatechange", () => api.connection(peer.connectionState));
    if (!outgoing) throw new Error("no outgoing audio");
    for (const track of outgoing.stream.getAudioTracks()) peer.addTrack(track, outgoing.stream);
    await peer.setRemoteDescription({ type: "offer", sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    await gathered(peer);
    api.answer({ sdp: peer.localDescription?.sdp ?? "" });
  } catch (err) {
    api.answer({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.onSend((msg) => {
  if (channel?.readyState === "open") channel.send(JSON.stringify(msg));
});

api.onHangup(() => close());
