// Exposes the phone bridge's IPC as `window.bridge` (hidden window).
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { PhoneBridgeApi } from "../shared/types";

const listen =
  <T>(channel: string) =>
  (cb: (payload: T) => void): void => {
    ipcRenderer.on(channel, (_event, payload: T) => cb(payload));
  };

const api: PhoneBridgeApi = {
  onOffer: listen(IPC.bridgeOffer),
  onSend: listen(IPC.bridgeSend),
  onHangup: listen(IPC.bridgeHangup),
  onAudioBegin: listen(IPC.audioBegin),
  onAudioChunk: listen(IPC.audioChunk),
  onAudioEnd: listen(IPC.audioEnd),
  onAudioStop: listen(IPC.audioStop),
  onMicControl: listen(IPC.micControl),
  answer: (result) => ipcRenderer.send(IPC.bridgeAnswer, result),
  message: (msg) => ipcRenderer.send(IPC.bridgeMessage, msg),
  connection: (state) => ipcRenderer.send(IPC.bridgeConnection, state),
  mic: (event) => ipcRenderer.send(IPC.mic, event),
  playback: (event) => ipcRenderer.send(IPC.playback, event),
  log: (text) => ipcRenderer.send(IPC.bridgeLog, text),
};

contextBridge.exposeInMainWorld("bridge", api);
