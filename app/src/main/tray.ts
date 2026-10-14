// System tray icon and the menu shared with the right-click on the eyes.
import { Menu, nativeImage, Tray, type BrowserWindow, type MenuItemConstructorOptions, type NativeImage } from "electron";
import type { ListenMode } from "../shared/types";
import { drawEyesIcon, encodePng } from "./png";

export interface TrayState {
  visible: boolean;
  doNotDisturb: boolean;
  muted: boolean;
  perception: boolean;
  listenMode: ListenMode;
  /** One line about the brain and the voice, shown disabled in the menu. */
  status: string;
  /** Voice engines are up. */
  voiceReady: boolean;
  online: boolean;
  chatHotkey: string;
  talkHotkey: string;
  /** Progress of an audiobook being made, or null. */
  audiobook: string | null;
}

export interface TrayActions {
  talk(): void;
  /** Opens the command bar. */
  ask(): void;
  toggleVisible(): void;
  toggleDoNotDisturb(): void;
  toggleMuted(): void;
  togglePerception(): void;
  setListenMode(mode: ListenMode): void;
  createAudiobook(): void;
  cancelAudiobook(): void;
  openSettings(): void;
  openDataFolder(): void;
  quit(): void;
}

export function lumiIcon(dim = false): NativeImage {
  const image = nativeImage.createFromBuffer(encodePng(16, 16, drawEyesIcon(16, { dim })), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: encodePng(32, 32, drawEyesIcon(32, { dim })) });
  return image;
}

const LISTEN_LABELS: Record<ListenMode, string> = {
  "push-to-talk": "Tieni premuto per parlare",
  "wake-word": "Parola di attivazione",
  continuous: "Ascolto continuo",
};

export class LumiTray {
  private readonly tray: Tray;
  private dim: boolean;

  constructor(
    private readonly actions: TrayActions,
    private readonly state: () => TrayState,
  ) {
    const initial = state();
    this.dim = !initial.online;
    this.tray = new Tray(lumiIcon(this.dim));
    this.tray.on("click", () => actions.talk());
    this.refresh();
  }

  refresh(): void {
    const s = this.state();
    const dim = !s.online || s.doNotDisturb;
    if (dim !== this.dim) {
      this.dim = dim;
      this.tray.setImage(lumiIcon(dim));
    }
    this.tray.setToolTip(`Lumi - ${s.status}`);
    this.tray.setContextMenu(this.menu());
  }

  popup(window: BrowserWindow): void {
    this.menu().popup({ window });
  }

  dispose(): void {
    this.tray.destroy();
  }

  private menu(): Menu {
    const s = this.state();
    const a = this.actions;
    const modes: MenuItemConstructorOptions[] = (Object.keys(LISTEN_LABELS) as ListenMode[]).map((mode) => ({
      label: mode === "push-to-talk" && s.talkHotkey ? `${LISTEN_LABELS[mode]} (${s.talkHotkey})` : LISTEN_LABELS[mode],
      type: "radio",
      checked: s.listenMode === mode,
      click: () => a.setListenMode(mode),
    }));
    return Menu.buildFromTemplate([
      { label: "Chiedi a Lumi…", accelerator: s.chatHotkey || undefined, registerAccelerator: false, click: () => a.ask() },
      { label: "Chat con Lumi", click: () => a.talk() },
      { label: "Come ti ascolto", submenu: modes, enabled: s.voiceReady },
      { type: "separator" },
      { label: "Mostra Lumi", type: "checkbox", checked: s.visible, click: () => a.toggleVisible() },
      { label: "Non disturbare", type: "checkbox", checked: s.doNotDisturb, click: () => a.toggleDoNotDisturb() },
      { label: "Voce disattivata (solo testo)", type: "checkbox", checked: s.muted, click: () => a.toggleMuted() },
      { label: "Guarda lo schermo", type: "checkbox", checked: s.perception, click: () => a.togglePerception() },
      { type: "separator" },
      s.audiobook
        ? { label: `${s.audiobook} - annulla`, click: () => a.cancelAudiobook() }
        : { label: "Crea un audiolibro…", enabled: s.voiceReady, click: () => a.createAudiobook() },
      { type: "separator" },
      { label: s.status, enabled: false },
      { label: "Impostazioni…", click: () => a.openSettings() },
      { label: "Apri la cartella dei dati", click: () => a.openDataFolder() },
      { type: "separator" },
      { label: "Esci", click: () => a.quit() },
    ]);
  }
}
