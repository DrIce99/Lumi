// Exposes the settings window's IPC as `window.settingsApi`.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { SettingsBridge, SidecarStatus } from "../shared/types";

const bridge: SettingsBridge = {
  load: () => ipcRenderer.invoke(IPC.settingsLoad),
  save: (settings, keys) => ipcRenderer.invoke(IPC.settingsSave, settings, keys),
  testConnection: () => ipcRenderer.invoke(IPC.settingsTest),
  listModels: (provider) => ipcRenderer.invoke(IPC.settingsListModels, provider),
  testVoice: (text) => ipcRenderer.invoke(IPC.settingsTestVoice, text),
  applyProfile: (profile) => ipcRenderer.invoke(IPC.settingsProfile, profile),
  pickVoiceFile: () => ipcRenderer.invoke(IPC.settingsPickVoice),
  forgetFact: (id) => ipcRenderer.invoke(IPC.settingsForget, id),
  clearMemory: () => ipcRenderer.invoke(IPC.settingsClear),
  openDataFolder: () => ipcRenderer.invoke(IPC.settingsOpenData),
  restartSidecar: () => ipcRenderer.invoke(IPC.settingsRestartSidecar),
  onStatus: (cb) => {
    ipcRenderer.on(IPC.settingsStatus, (_event, status: SidecarStatus) => cb(status));
  },
};

contextBridge.exposeInMainWorld("settingsApi", bridge);
