// Exposes the face window's IPC as `window.lumi`.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { FaceBridge } from "../shared/types";

const listen =
  <T>(channel: string) =>
  (cb: (payload: T) => void): void => {
    ipcRenderer.on(channel, (_event, payload: T) => cb(payload));
  };

const bridge: FaceBridge = {
  onLayout: listen(IPC.layout),
  onState: listen(IPC.state),
  onGaze: listen(IPC.gaze),
  onGesture: listen(IPC.gesture),
  onBubbleStart: listen(IPC.bubbleStart),
  onBubbleChunk: listen(IPC.bubbleChunk),
  onBubbleEnd: listen(IPC.bubbleEnd),
  onBubbleHide: listen(IPC.bubbleHide),
  onInputOpen: listen(IPC.inputOpen),
  onInputClose: listen(IPC.inputClose),
  onAudioBegin: listen(IPC.audioBegin),
  onAudioChunk: listen(IPC.audioChunk),
  onAudioEnd: listen(IPC.audioEnd),
  onAudioStop: listen(IPC.audioStop),
  onAudioLocal: listen(IPC.audioLocal),
  onMicControl: listen(IPC.micControl),
  ready: () => ipcRenderer.send(IPC.ready),
  setInteractive: (interactive) => ipcRenderer.send(IPC.interactive, interactive),
  click: () => ipcRenderer.send(IPC.click),
  dragStart: () => ipcRenderer.send(IPC.dragStart),
  dragEnd: () => ipcRenderer.send(IPC.dragEnd),
  contextMenu: () => ipcRenderer.send(IPC.contextMenu),
  send: (text) => ipcRenderer.send(IPC.send, text),
  closeInput: () => ipcRenderer.send(IPC.closeInput),
  bubbleClicked: () => ipcRenderer.send(IPC.bubbleClicked),
  bubbleChoice: (bubbleId, choice) => ipcRenderer.send(IPC.bubbleChoice, bubbleId, choice),
  playback: (event) => ipcRenderer.send(IPC.playback, event),
  mic: (event) => ipcRenderer.send(IPC.mic, event),
};

contextBridge.exposeInMainWorld("lumi", bridge);
