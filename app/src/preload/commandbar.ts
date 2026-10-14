// Exposes the command bar's IPC as `window.lumiBar`.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc";
import type { BarBridge, BarOpen } from "../shared/types";

const bridge: BarBridge = {
  onOpen: (cb) => {
    ipcRenderer.on(IPC.barOpen, (_event, msg: BarOpen) => cb(msg));
  },
  onClose: (cb) => {
    ipcRenderer.on(IPC.barClose, () => cb());
  },
  submit: (msg) => ipcRenderer.send(IPC.barSubmit, msg),
  cancel: () => ipcRenderer.send(IPC.barCancel),
  resize: (height) => ipcRenderer.send(IPC.barResize, height),
  typing: () => ipcRenderer.send(IPC.barTyping),
  // Dropped files carry no path in the page: only the preload can ask for it
  pathFor: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("lumiBar", bridge);
