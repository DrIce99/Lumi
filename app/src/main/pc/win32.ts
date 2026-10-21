// The Windows calls behind "Usare il PC" (roadmap 16), through koffi: the
// open top-level windows, showing, focusing and closing them (WM_CLOSE, so
// the app can ask to save: never a kill), media keys, and the time of the
// last keyboard or mouse input (the user taking over stops Lumi). All calls
// are quick and synchronous: no waiting on the main thread. Without koffi
// (or off Windows) nothing works and every function says so.
import { log } from "../log";
import { processImage } from "../perception/desktop";
import type { MediaAction } from "./policy";
import type { WindowInfo } from "./match";

type Handle = unknown;

interface Api {
  EnumWindows(callback: (hwnd: Handle, param: number) => boolean, param: number): boolean;
  IsWindowVisible(hwnd: Handle): boolean;
  IsWindow(hwnd: Handle): boolean;
  IsIconic(hwnd: Handle): boolean;
  IsZoomed(hwnd: Handle): boolean;
  GetWindow(hwnd: Handle, cmd: number): Handle;
  GetWindowLongPtrW(hwnd: Handle, index: number): number | bigint;
  GetWindowTextW(hwnd: Handle, buffer: Buffer, max: number): number;
  GetClassNameW(hwnd: Handle, buffer: Buffer, max: number): number;
  GetWindowThreadProcessId(hwnd: Handle, pid: number[] | null): number;
  DwmGetWindowAttribute(hwnd: Handle, attribute: number, out: Buffer, size: number): number;
  ShowWindow(hwnd: Handle, cmd: number): boolean;
  SetForegroundWindow(hwnd: Handle): boolean;
  BringWindowToTop(hwnd: Handle): boolean;
  GetForegroundWindow(): Handle;
  AttachThreadInput(attach: number, to: number, on: boolean): boolean;
  GetCurrentThreadId(): number;
  GetCurrentProcessId(): number;
  PostMessageW(hwnd: Handle, msg: number, wParam: number, lParam: number): boolean;
  keybd_event(vk: number, scan: number, flags: number, extra: number): void;
  GetLastInputInfo(info: { cbSize: number; dwTime: number }): boolean;
  GetTickCount(): number;
  address(handle: Handle): bigint;
}

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const DWMWA_CLOAKED = 14;
const SW_MAXIMIZE = 3;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const WM_CLOSE = 0x10;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
/** Desktop, taskbar and shell surfaces: never "apps". */
const SHELL_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow"]);

const MEDIA_KEYS: Record<MediaAction, number> = {
  play_pause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  volume_up: 0xaf,
  volume_down: 0xae,
  mute: 0xad,
};
/** One volume key press moves 2%: a request moves 10%. */
const VOLUME_PRESSES = 5;

let api: Api | null | undefined;

function load(): Api | null {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== "win32") return api;
  try {
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const dwmapi = koffi.load("dwmapi.dll");
    const kernel32 = koffi.load("kernel32.dll");
    koffi.proto("bool __stdcall LUMI_PC_ENUMPROC(void *hwnd, intptr_t lParam)");
    koffi.struct("LUMI_PC_LASTINPUTINFO", { cbSize: "uint32_t", dwTime: "uint32_t" });
    api = {
      EnumWindows: user32.func("bool __stdcall EnumWindows(LUMI_PC_ENUMPROC *lpEnumFunc, intptr_t lParam)"),
      IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(void *hWnd)"),
      IsWindow: user32.func("bool __stdcall IsWindow(void *hWnd)"),
      IsIconic: user32.func("bool __stdcall IsIconic(void *hWnd)"),
      IsZoomed: user32.func("bool __stdcall IsZoomed(void *hWnd)"),
      GetWindow: user32.func("void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)"),
      GetWindowLongPtrW: user32.func("intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)"),
      GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hWnd, _Out_ void *lpString, int nMaxCount)"),
      GetClassNameW: user32.func("int __stdcall GetClassNameW(void *hWnd, _Out_ void *lpClassName, int nMaxCount)"),
      GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)"),
      DwmGetWindowAttribute: dwmapi.func("int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ void *pvAttribute, uint32_t cbAttribute)"),
      ShowWindow: user32.func("bool __stdcall ShowWindow(void *hWnd, int nCmdShow)"),
      SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(void *hWnd)"),
      BringWindowToTop: user32.func("bool __stdcall BringWindowToTop(void *hWnd)"),
      GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
      AttachThreadInput: user32.func("bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)"),
      GetCurrentThreadId: kernel32.func("uint32_t __stdcall GetCurrentThreadId()"),
      GetCurrentProcessId: kernel32.func("uint32_t __stdcall GetCurrentProcessId()"),
      PostMessageW: user32.func("bool __stdcall PostMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)"),
      keybd_event: user32.func("void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)"),
      GetLastInputInfo: user32.func("bool __stdcall GetLastInputInfo(_Inout_ LUMI_PC_LASTINPUTINFO *plii)"),
      GetTickCount: kernel32.func("uint32_t __stdcall GetTickCount()"),
      address: (handle) => (handle ? (koffi.address(handle) as bigint) : 0n),
    };
  } catch (err) {
    log.warn("Can't act on the desktop through koffi: using the PC won't work", err);
  }
  return api;
}

export function win32Available(): boolean {
  return load() !== null;
}

function text(read: (buffer: Buffer, max: number) => number, max = 256): string {
  const buffer = Buffer.alloc(max * 2);
  const length = read(buffer, max);
  return length > 0 ? buffer.toString("utf16le", 0, length * 2) : "";
}

/**
 * The windows the user sees in Alt+Tab, topmost first: visible, titled,
 * not owned, not tool windows, not cloaked (suspended Store apps, other
 * virtual desktops), not Lumi's.
 */
export function listWindows(): WindowInfo[] {
  const w = load();
  if (!w) return [];
  const me = w.GetCurrentProcessId();
  const out: WindowInfo[] = [];
  try {
    w.EnumWindows((hwnd) => {
      try {
        if (!w.IsWindowVisible(hwnd) || w.GetWindow(hwnd, GW_OWNER)) return true;
        if (Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;
        const cloaked = Buffer.alloc(4);
        if (w.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked.readUInt32LE(0) !== 0) return true;
        const title = text((b, n) => w.GetWindowTextW(hwnd, b, n), 512);
        if (!title.trim()) return true;
        if (SHELL_CLASSES.has(text((b, n) => w.GetClassNameW(hwnd, b, n)))) return true;
        const pid = [0];
        w.GetWindowThreadProcessId(hwnd, pid);
        if (pid[0] === me) return true;
        const path = processImage(pid[0]);
        out.push({
          handle: hwnd,
          id: String(w.address(hwnd)),
          title,
          process: path.split("\\").pop() || "",
          pid: pid[0],
          minimized: w.IsIconic(hwnd),
          maximized: w.IsZoomed(hwnd),
        });
      } catch {
        // a window that went away while we looked
      }
      return true;
    }, 0);
  } catch (err) {
    log.warn("Listing the windows failed", err);
  }
  return out;
}

/** The id of the foreground window ("" when none). */
export function foregroundId(): string {
  const w = load();
  if (!w) return "";
  try {
    return String(w.address(w.GetForegroundWindow()));
  } catch {
    return "";
  }
}

/** Whether a window still exists. */
export function windowExists(handle: unknown): boolean {
  const w = load();
  try {
    return !!w && w.IsWindow(handle);
  } catch {
    return false;
  }
}

/**
 * Brings a window to the foreground (restored if minimized). Windows only
 * lets the foreground app hand the focus over: attaching to its input
 * thread for a moment makes the request ours.
 */
export function focus(window: WindowInfo): boolean {
  const w = load();
  if (!w) return false;
  try {
    const hwnd = window.handle;
    if (w.IsIconic(hwnd)) w.ShowWindow(hwnd, SW_RESTORE);
    if (w.SetForegroundWindow(hwnd) && foregroundId() === window.id) return true;
    const foreground = w.GetForegroundWindow();
    const theirs = foreground ? w.GetWindowThreadProcessId(foreground, null) : 0;
    const mine = w.GetCurrentThreadId();
    const attached = theirs && theirs !== mine ? w.AttachThreadInput(mine, theirs, true) : false;
    try {
      w.BringWindowToTop(hwnd);
      w.SetForegroundWindow(hwnd);
    } finally {
      if (attached) w.AttachThreadInput(mine, theirs, false);
    }
    if (foregroundId() === window.id) return true;
    // The foreground lock still holds: a key event with no key (VK 0, no effect in any app)
    // makes this process the one that received the last input, which may set the foreground
    w.keybd_event(0, 0, 0, 0);
    w.keybd_event(0, 0, KEYEVENTF_KEYUP, 0);
    w.SetForegroundWindow(hwnd);
    return foregroundId() === window.id;
  } catch (err) {
    log.warn("Focusing a window failed", err);
    return false;
  }
}

export function show(window: WindowInfo, action: "minimize" | "maximize" | "restore"): void {
  const w = load();
  if (!w) return;
  w.ShowWindow(window.handle, action === "minimize" ? SW_MINIMIZE : action === "maximize" ? SW_MAXIMIZE : SW_RESTORE);
}

/** The window's state now (after an action), or null when it is gone. */
export function windowState(window: WindowInfo): { minimized: boolean; maximized: boolean; foreground: boolean } | null {
  const w = load();
  if (!w || !windowExists(window.handle)) return null;
  return { minimized: w.IsIconic(window.handle), maximized: w.IsZoomed(window.handle), foreground: foregroundId() === window.id };
}

/** Asks the window to close (the app may ask to save first). */
export function requestClose(window: WindowInfo): boolean {
  const w = load();
  if (!w) return false;
  try {
    return w.PostMessageW(window.handle, WM_CLOSE, 0, 0);
  } catch (err) {
    log.warn("Closing a window failed", err);
    return false;
  }
}

/** Presses a media key (volume keys a few times). */
export function mediaKey(action: MediaAction): boolean {
  const w = load();
  if (!w) return false;
  const vk = MEDIA_KEYS[action];
  const presses = action === "volume_up" || action === "volume_down" ? VOLUME_PRESSES : 1;
  for (let i = 0; i < presses; i++) {
    w.keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, 0);
    w.keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
  }
  return true;
}

/** GetTickCount() of the last keyboard or mouse input (ours too), or null when unknown. */
export function lastInputTick(): number | null {
  const w = load();
  if (!w) return null;
  try {
    const info = { cbSize: 8, dwTime: 0 };
    return w.GetLastInputInfo(info) ? info.dwTime : null;
  } catch {
    return null;
  }
}

/** Milliseconds since boot, in the same clock as lastInputTick (wraps every 49 days). */
export function tickNow(): number {
  return load()?.GetTickCount() ?? 0;
}
