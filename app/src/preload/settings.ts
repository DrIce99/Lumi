// Exposes the settings window's IPC as `window.settingsApi`.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type { RuntimeSetupState, SettingsBridge, SidecarStatus } from "../shared/types";

const bridge: SettingsBridge = {
  load: () => ipcRenderer.invoke(IPC.settingsLoad),
  save: (settings, keys) => ipcRenderer.invoke(IPC.settingsSave, settings, keys),
  testConnection: () => ipcRenderer.invoke(IPC.settingsTest),
  listModels: (provider) => ipcRenderer.invoke(IPC.settingsListModels, provider),
  listVisionModels: (provider) => ipcRenderer.invoke(IPC.settingsListVisionModels, provider),
  testVoice: (text) => ipcRenderer.invoke(IPC.settingsTestVoice, text),
  applyProfile: (profile) => ipcRenderer.invoke(IPC.settingsProfile, profile),
  pickVoiceFile: () => ipcRenderer.invoke(IPC.settingsPickVoice),
  forgetMemory: (id) => ipcRenderer.invoke(IPC.settingsForget, id),
  clearMemory: () => ipcRenderer.invoke(IPC.settingsClear),
  forgetVoice: (id) => ipcRenderer.invoke(IPC.settingsForgetVoice, id),
  setDiscordToken: (token) => ipcRenderer.invoke(IPC.settingsDiscordToken, token),
  openDataFolder: () => ipcRenderer.invoke(IPC.settingsOpenData),
  restartSidecar: () => ipcRenderer.invoke(IPC.settingsRestartSidecar),
  installRuntime: () => ipcRenderer.invoke(IPC.settingsInstall),
  findForget: (query) => ipcRenderer.invoke(IPC.settingsFindForget, query),
  forgetItems: (selection) => ipcRenderer.invoke(IPC.settingsForgetItems, selection),
  habit: (id, action) => ipcRenderer.invoke(IPC.settingsHabit, id, action),
  rerollMood: () => ipcRenderer.invoke(IPC.settingsRerollMood),
  pickModelFile: () => ipcRenderer.invoke(IPC.settingsPickModel),
  consolidateMemory: () => ipcRenderer.invoke(IPC.settingsConsolidate),
  phonePair: () => ipcRenderer.invoke(IPC.settingsPhonePair),
  phoneRevoke: (id) => ipcRenderer.invoke(IPC.settingsPhoneRevoke, id),
  onRefresh: (cb) => {
    ipcRenderer.on(IPC.settingsRefresh, () => cb());
  },
  onForgetQuery: (cb) => {
    ipcRenderer.on(IPC.settingsForgetQuery, (_event, query: string) => cb(query));
  },
  onStatus: (cb) => {
    ipcRenderer.on(IPC.settingsStatus, (_event, status: SidecarStatus) => cb(status));
  },
  onSetup: (cb) => {
    ipcRenderer.on(IPC.settingsSetup, (_event, state: RuntimeSetupState) => cb(state));
  },
};

contextBridge.exposeInMainWorld("settingsApi", bridge);
