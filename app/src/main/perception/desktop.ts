// Windows desktop through koffi (user32, dwmapi, kernel32): the window in
// the foreground (title, process, frame), the system caret (GetGUIThreadInfo,
// for classic Win32 apps; Chrome, VS Code and Electron apps expose theirs
// through UI Automation instead) and the keyboard state for push-to-talk.
// Any failure (another OS, a missing native binary) degrades to "unknown".
import { log } from "../log";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ForegroundWindow {
  handle: string;
  title: string;
  /** Executable name, e.g. "Code.exe". */
  process: string;
  pid: number;
  /** Visible frame in physical screen pixels. */
  rect: Rect | null;
}

type Handle = unknown;

interface Api {
  GetForegroundWindow(): Handle;
  GetWindowTextW(hwnd: Handle, buffer: Buffer, max: number): number;
  GetWindowThreadProcessId(hwnd: Handle, pid: number[]): number;
  GetGUIThreadInfo(thread: number, info: GuiThreadInfo): boolean;
  ClientToScreen(hwnd: Handle, point: { x: number; y: number }): boolean;
  GetAsyncKeyState(key: number): number;
  DwmGetWindowAttribute(hwnd: Handle, attribute: number, out: Buffer, size: number): number;
  OpenProcess(access: number, inherit: boolean, pid: number): Handle;
  QueryFullProcessImageNameW(process: Handle, flags: number, buffer: Buffer, size: number[]): boolean;
  CloseHandle(handle: Handle): boolean;
  GetCurrentProcessId(): number;
}

interface GuiThreadInfo {
  cbSize: number;
  flags: number;
  hwndActive: Handle;
  hwndFocus: Handle;
  hwndCapture: Handle;
  hwndMenuOwner: Handle;
  hwndMoveSize: Handle;
  hwndCaret: Handle;
  rcCaret: { left: number; top: number; right: number; bottom: number };
}

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GUI_THREAD_INFO_SIZE = 72;

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
    const RECT = koffi.struct("LUMI_RECT", { left: "long", top: "long", right: "long", bottom: "long" });
    const POINT = koffi.struct("LUMI_POINT", { x: "long", y: "long" });
    koffi.struct("LUMI_GUITHREADINFO", {
      cbSize: "uint32_t",
      flags: "uint32_t",
      hwndActive: "void *",
      hwndFocus: "void *",
      hwndCapture: "void *",
      hwndMenuOwner: "void *",
      hwndMoveSize: "void *",
      hwndCaret: "void *",
      rcCaret: RECT,
    });
    void POINT;
    api = {
      GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
      GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hWnd, _Out_ void *lpString, int nMaxCount)"),
      GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)"),
      GetGUIThreadInfo: user32.func("bool __stdcall GetGUIThreadInfo(uint32_t idThread, _Inout_ LUMI_GUITHREADINFO *pgui)"),
      ClientToScreen: user32.func("bool __stdcall ClientToScreen(void *hWnd, _Inout_ LUMI_POINT *lpPoint)"),
      GetAsyncKeyState: user32.func("int16_t __stdcall GetAsyncKeyState(int vKey)"),
      DwmGetWindowAttribute: dwmapi.func("int32_t __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ void *pvAttribute, uint32_t cbAttribute)"),
      OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)"),
      QueryFullProcessImageNameW: kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, _Out_ void *lpExeName, _Inout_ uint32_t *lpdwSize)"),
      CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *hObject)"),
      GetCurrentProcessId: kernel32.func("uint32_t __stdcall GetCurrentProcessId()"),
    };
  } catch (err) {
    log.warn("Can't read the desktop through koffi: caret, foreground window and push-to-talk release won't work", err);
  }
  return api;
}

export function desktopAvailable(): boolean {
  return load() !== null;
}

const processNames = new Map<number, string>();

function processName(w: Api, pid: number): string {
  const cached = processNames.get(pid);
  if (cached !== undefined) return cached;
  let name = "";
  const handle = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (handle) {
    const buffer = Buffer.alloc(1024);
    const size = [512];
    if (w.QueryFullProcessImageNameW(handle, 0, buffer, size)) name = buffer.toString("utf16le", 0, size[0] * 2).split("\\").pop() ?? "";
    w.CloseHandle(handle);
  }
  if (processNames.size > 500) processNames.clear();
  processNames.set(pid, name);
  return name;
}

/** The window the user is working in, or null when unknown (or it is Lumi itself). */
export function foregroundWindow(): ForegroundWindow | null {
  const w = load();
  if (!w) return null;
  try {
    const hwnd = w.GetForegroundWindow();
    if (!hwnd) return null;
    const pid = [0];
    w.GetWindowThreadProcessId(hwnd, pid);
    if (pid[0] === w.GetCurrentProcessId()) return null;
    const title = Buffer.alloc(512 * 2);
    const length = w.GetWindowTextW(hwnd, title, 512);
    const frame = Buffer.alloc(16);
    let rect: Rect | null = null;
    if (w.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, frame, 16) === 0) {
      const left = frame.readInt32LE(0);
      const top = frame.readInt32LE(4);
      rect = { x: left, y: top, width: frame.readInt32LE(8) - left, height: frame.readInt32LE(12) - top };
    }
    return { handle: String(hwnd), title: title.toString("utf16le", 0, length * 2), process: processName(w, pid[0]), pid: pid[0], rect };
  } catch (err) {
    log.warn("Reading the foreground window failed", err);
    return null;
  }
}

/** The system caret of the foreground thread, in physical screen pixels (classic Win32 apps). */
export function systemCaret(): Rect | null {
  const w = load();
  if (!w) return null;
  try {
    const hwnd = w.GetForegroundWindow();
    if (!hwnd) return null;
    const thread = w.GetWindowThreadProcessId(hwnd, [0]);
    const info: GuiThreadInfo = {
      cbSize: GUI_THREAD_INFO_SIZE,
      flags: 0,
      hwndActive: null,
      hwndFocus: null,
      hwndCapture: null,
      hwndMenuOwner: null,
      hwndMoveSize: null,
      hwndCaret: null,
      rcCaret: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    if (!w.GetGUIThreadInfo(thread, info) || !info.hwndCaret) return null;
    const r = info.rcCaret;
    if (r.bottom - r.top <= 0) return null;
    const origin = { x: r.left, y: r.top };
    if (!w.ClientToScreen(info.hwndCaret, origin)) return null;
    return { x: origin.x, y: origin.y, width: Math.max(1, r.right - r.left), height: r.bottom - r.top };
  } catch {
    return null;
  }
}

/** Whether a virtual key is held down right now. */
export function keyDown(virtualKey: number): boolean {
  const w = load();
  if (!w) return false;
  try {
    return (w.GetAsyncKeyState(virtualKey) & 0x8000) !== 0;
  } catch {
    return false;
  }
}

/** Private browsing windows show it in their title (Edge, Firefox); perception pauses there. */
export function isPrivateWindow(title: string): boolean {
  return /\bInPrivate\b|\bIncognito\b|in incognito|Navigazione anonima|Navigazione privata|Private Browsing/i.test(title);
}

/** Whether perception must pause for this window (password managers and apps the user listed). */
export function pausedFor(window: ForegroundWindow, pauseInApps: string[]): boolean {
  if (isPrivateWindow(window.title)) return true;
  const haystack = `${window.process} ${window.title}`.toLowerCase();
  return pauseInApps.some((app) => app.trim() && haystack.includes(app.trim().toLowerCase()));
}

/** Virtual key of the main (non-modifier) key of an Electron accelerator, e.g. "Control+Alt+Space" -> VK_SPACE. */
export function acceleratorKey(accelerator: string): number | null {
  const parts = accelerator.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.filter((p) => !["control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "shift", "super", "meta", "command", "cmd", "altgr"].includes(p)).pop();
  if (!key) return null;
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (f) return 0x6f + Number(f[1]);
  const named: Record<string, number> = {
    space: 0x20,
    enter: 0x0d,
    return: 0x0d,
    tab: 0x09,
    backspace: 0x08,
    escape: 0x1b,
    esc: 0x1b,
    insert: 0x2d,
    delete: 0x2e,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pagedown: 0x22,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
    capslock: 0x14,
    scrolllock: 0x91,
    pause: 0x13,
  };
  return named[key] ?? null;
}
