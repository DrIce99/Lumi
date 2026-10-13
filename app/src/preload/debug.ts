// Exposes the gaze debug overlay's single channel as `window.debugGaze`.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("debugGaze", {
  onFrame: (cb: (frame: unknown) => void) => {
    ipcRenderer.on("debug:gaze", (_event, frame) => cb(frame));
  },
});
