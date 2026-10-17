"""Listening to other apps (a Discord call): their audio only, transcribed here.

Windows 10 2004+ can capture the audio of one process tree ("process
loopback", ActivateAudioInterfaceAsync on VAD\\Process_Loopback): only the
chosen apps are heard, never Lumi's own voice, music or videos. The audio
is cut into utterances at pauses (an energy gate is enough: call audio is
already denoised), each one is transcribed by the local speech recognizer
and gets a voiceprint, so the app can tell the friends apart. Audio and
transcripts never leave the computer from here.
"""

from __future__ import annotations

import ctypes
import functools
import logging
import sys
import threading
import time
from collections.abc import Callable
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

log = logging.getLogger("lumi.appaudio")

RATE = 16000
# Sound above this level counts as the app playing something; this long without it is "silence" in the status
SOUND_LEVEL = 0.004
QUIET_AFTER_S = 20.0


# ---------------------------------------------------------------- processes


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def processes() -> list[tuple[int, int, str]]:
    """(pid, parent pid, exe name) of every process."""
    if sys.platform != "win32":
        return []
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        return []
    out = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = k.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
            ok = k.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k.CloseHandle(snap)
    return out


def exe_stem(app: str) -> str:
    """"Discord" -> "discord"; "Discord.exe" -> "discord"."""
    name = app.strip().lower()
    return name[:-4] if name.endswith(".exe") else name


# One name, several programs: "Discord" is also its test builds and the clients that wrap its web app
VARIANTS = {
    "discord": {"discord", "discordptb", "discordcanary", "discorddevelopment", "vesktop", "legcord", "armcord", "webcord"},
}


def exe_stems(app: str) -> set[str]:
    """Every executable name an app goes by."""
    stem = exe_stem(app)
    return VARIANTS.get(stem, {stem})


def app_roots(app: str, table: list[tuple[int, int, str]] | None = None) -> list[int]:
    """The topmost processes of an app (the capture includes their children)."""
    table = processes() if table is None else table
    stems = exe_stems(app)
    pids = {pid for pid, _, exe in table if Path(exe).stem.lower() in stems}
    return sorted(pid for pid, parent, exe in table if pid in pids and parent not in pids)


# ---------------------------------------------------------------- utterances


@dataclass
class Segmenter:
    """Cuts a stream of 16 kHz float audio into utterances at pauses. Pure, tested."""

    frame: int = RATE * 30 // 1000
    # Speech starts after this much sound and ends after this much quiet
    start_ms: int = 150
    end_ms: int = 600
    preroll_ms: int = 300
    max_ms: int = 15000
    min_ms: int = 600
    # Absolute floor (call audio is quiet when nobody talks) and margin over the noise
    floor: float = 0.006
    margin: float = 3.0
    _noise: float = 0.002
    _pending: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    _history: list = field(default_factory=list)
    _speech: list = field(default_factory=list)
    _loud: int = 0
    _quiet: int = 0
    _active: bool = False

    def push(self, audio: np.ndarray) -> list[np.ndarray]:
        out = []
        data = np.concatenate([self._pending, np.asarray(audio, np.float32)])
        whole = len(data) - len(data) % self.frame
        self._pending = data[whole:]
        for i in range(0, whole, self.frame):
            seg = self._frame(data[i : i + self.frame])
            if seg is not None:
                out.append(seg)
        return out

    def flush(self) -> list[np.ndarray]:
        if not self._active:
            return []
        return [s for s in [self._close()] if s is not None]

    def _frame(self, f: np.ndarray) -> np.ndarray | None:
        ms = 1000 * self.frame // RATE
        rms = float(np.sqrt(np.mean(f.astype(np.float64) ** 2)))
        loud = rms > max(self.floor, self._noise * self.margin)
        if not loud:
            # The noise floor follows the quiet parts only
            self._noise = 0.95 * self._noise + 0.05 * rms
        if not self._active:
            self._history.append(f)
            self._history = self._history[-max(1, self.preroll_ms // ms) :]
            self._loud = self._loud + 1 if loud else 0
            if self._loud * ms >= self.start_ms:
                self._active = True
                self._speech = list(self._history)
                self._history = []
                self._quiet = 0
            return None
        self._speech.append(f)
        self._quiet = 0 if loud else self._quiet + 1
        if self._quiet * ms >= self.end_ms or len(self._speech) * ms >= self.max_ms:
            return self._close()
        return None

    def _close(self) -> np.ndarray | None:
        ms = 1000 * self.frame // RATE
        frames = self._speech[: len(self._speech) - self._quiet] if self._quiet else self._speech
        self._active, self._speech, self._loud, self._quiet = False, [], 0, 0
        if len(frames) * ms < self.min_ms:
            return None
        return np.concatenate(frames)


# ---------------------------------------------------------------- capture


@functools.cache
def _com():
    """comtypes interfaces for process loopback (defined once, on first use: Windows only).
    Importing comtypes initializes COM on the importing thread, so this runs before the capture thread starts."""
    import comtypes
    from comtypes import COMMETHOD, GUID, HRESULT, IUnknown

    class WAVEFORMATEX(ctypes.Structure):
        _fields_ = [
            ("wFormatTag", wintypes.WORD),
            ("nChannels", wintypes.WORD),
            ("nSamplesPerSec", wintypes.DWORD),
            ("nAvgBytesPerSec", wintypes.DWORD),
            ("nBlockAlign", wintypes.WORD),
            ("wBitsPerSample", wintypes.WORD),
            ("cbSize", wintypes.WORD),
        ]

    class IAudioCaptureClient(IUnknown):
        _iid_ = GUID("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")
        _methods_ = [
            COMMETHOD(
                [],
                HRESULT,
                "GetBuffer",
                (["out"], ctypes.POINTER(ctypes.c_void_p), "data"),
                (["out"], ctypes.POINTER(ctypes.c_uint32), "frames"),
                (["out"], ctypes.POINTER(wintypes.DWORD), "flags"),
                (["out"], ctypes.POINTER(ctypes.c_uint64), "position"),
                (["out"], ctypes.POINTER(ctypes.c_uint64), "qpc"),
            ),
            COMMETHOD([], HRESULT, "ReleaseBuffer", (["in"], ctypes.c_uint32, "frames")),
            COMMETHOD([], HRESULT, "GetNextPacketSize", (["out"], ctypes.POINTER(ctypes.c_uint32), "frames")),
        ]

    class IAudioClient(IUnknown):
        _iid_ = GUID("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")
        _methods_ = [
            COMMETHOD(
                [],
                HRESULT,
                "Initialize",
                (["in"], ctypes.c_int, "mode"),
                (["in"], wintypes.DWORD, "flags"),
                (["in"], ctypes.c_longlong, "duration"),
                (["in"], ctypes.c_longlong, "periodicity"),
                (["in"], ctypes.POINTER(WAVEFORMATEX), "format"),
                (["in"], ctypes.POINTER(GUID), "session"),
            ),
            COMMETHOD([], HRESULT, "GetBufferSize", (["out"], ctypes.POINTER(ctypes.c_uint32), "frames")),
            COMMETHOD([], HRESULT, "GetStreamLatency", (["out"], ctypes.POINTER(ctypes.c_longlong), "latency")),
            COMMETHOD([], HRESULT, "GetCurrentPadding", (["out"], ctypes.POINTER(ctypes.c_uint32), "frames")),
            COMMETHOD(
                [],
                HRESULT,
                "IsFormatSupported",
                (["in"], ctypes.c_int, "mode"),
                (["in"], ctypes.POINTER(WAVEFORMATEX), "format"),
                (["out"], ctypes.POINTER(ctypes.POINTER(WAVEFORMATEX)), "closest"),
            ),
            COMMETHOD([], HRESULT, "GetMixFormat", (["out"], ctypes.POINTER(ctypes.POINTER(WAVEFORMATEX)), "format")),
            COMMETHOD([], HRESULT, "GetDevicePeriod", (["out"], ctypes.POINTER(ctypes.c_longlong), "default"), (["out"], ctypes.POINTER(ctypes.c_longlong), "minimum")),
            COMMETHOD([], HRESULT, "Start"),
            COMMETHOD([], HRESULT, "Stop"),
            COMMETHOD([], HRESULT, "Reset"),
            COMMETHOD([], HRESULT, "SetEventHandle", (["in"], wintypes.HANDLE, "event")),
            COMMETHOD([], HRESULT, "GetService", (["in"], ctypes.POINTER(GUID), "iid"), (["out"], ctypes.POINTER(ctypes.POINTER(IUnknown)), "service")),
        ]

    class IActivateAudioInterfaceAsyncOperation(IUnknown):
        _iid_ = GUID("{72A22D78-CDE4-431D-B8CC-843A71199B6D}")
        _methods_ = [
            COMMETHOD(
                [],
                HRESULT,
                "GetActivateResult",
                (["out"], ctypes.POINTER(HRESULT), "result"),
                (["out"], ctypes.POINTER(ctypes.POINTER(IUnknown)), "interface"),
            ),
        ]

    class IActivateAudioInterfaceCompletionHandler(IUnknown):
        _iid_ = GUID("{41D949AB-9862-444A-80F6-C261334DA5EB}")
        _methods_ = [
            COMMETHOD([], HRESULT, "ActivateCompleted", (["in"], ctypes.POINTER(IActivateAudioInterfaceAsyncOperation), "operation")),
        ]

    class IAgileObject(IUnknown):
        _iid_ = GUID("{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}")
        _methods_ = []

    class Handler(comtypes.COMObject):
        _com_interfaces_ = [IActivateAudioInterfaceCompletionHandler, IAgileObject]

        def __init__(self):
            super().__init__()
            self.done = threading.Event()

        def ActivateCompleted(self, operation):  # noqa: N802 - COM name
            self.done.set()
            return 0

    class BLOB(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.ULONG), ("pBlobData", ctypes.c_void_p)]

    class PROPVARIANT(ctypes.Structure):
        _fields_ = [("vt", ctypes.c_ushort), ("r1", wintypes.WORD), ("r2", wintypes.WORD), ("r3", wintypes.WORD), ("blob", BLOB), ("pad", ctypes.c_ulonglong)]

    class LOOPBACK_PARAMS(ctypes.Structure):
        _fields_ = [("activation", ctypes.c_int), ("pid", wintypes.DWORD), ("mode", ctypes.c_int)]

    return {
        "comtypes": comtypes,
        "GUID": GUID,
        "WAVEFORMATEX": WAVEFORMATEX,
        "IAudioClient": IAudioClient,
        "IAudioCaptureClient": IAudioCaptureClient,
        "IActivateAudioInterfaceAsyncOperation": IActivateAudioInterfaceAsyncOperation,
        "IActivateAudioInterfaceCompletionHandler": IActivateAudioInterfaceCompletionHandler,
        "Handler": Handler,
        "PROPVARIANT": PROPVARIANT,
        "LOOPBACK_PARAMS": LOOPBACK_PARAMS,
    }


LOOPBACK = 0x00020000
EVENTCALLBACK = 0x00040000
AUTOCONVERTPCM = 0x80000000
SRC_DEFAULT_QUALITY = 0x08000000
BUFFER_SILENT = 0x2
VT_BLOB = 65
INCLUDE_TREE = 0
RPC_E_CHANGED_MODE = 0x80010106


class ProcessCapture:
    """Captures one process tree's audio as 16 kHz mono float chunks, on its own thread."""

    def __init__(self, pid: int, on_audio: Callable[[np.ndarray], None]):
        self.pid = pid
        self.on_audio = on_audio
        self.error: str | None = None
        self.started = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"capture-{pid}", daemon=True)

    def start(self, timeout: float = 5.0) -> bool:
        _com()
        self._thread.start()
        self.started.wait(timeout)
        return self.started.is_set() and self.error is None

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive() and threading.current_thread() is not self._thread:
            self._thread.join(2)

    @property
    def alive(self) -> bool:
        return self._thread.is_alive()

    def _run(self) -> None:
        try:
            self._capture()
        except Exception as err:  # noqa: BLE001 - reported to the app as the app's status
            self.error = str(err)
            log.warning("Capturing process %d failed: %s", self.pid, err)
        finally:
            self.started.set()

    def _capture(self) -> None:
        c = _com()
        comtypes = c["comtypes"]
        try:
            comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
        except OSError as err:
            # Already initialized on this thread (another apartment): the agile handler works there too
            if (err.winerror or 0) & 0xFFFFFFFF != RPC_E_CHANGED_MODE:
                raise
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateEventW.restype = wintypes.HANDLE
        event = k.CreateEventW(None, False, False, None)
        try:
            params = c["LOOPBACK_PARAMS"](1, self.pid, INCLUDE_TREE)  # AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            prop = c["PROPVARIANT"]()
            prop.vt = VT_BLOB
            prop.blob.cbSize = ctypes.sizeof(params)
            prop.blob.pBlobData = ctypes.cast(ctypes.pointer(params), ctypes.c_void_p)
            handler = c["Handler"]()
            operation = ctypes.POINTER(c["IActivateAudioInterfaceAsyncOperation"])()
            activate = ctypes.WinDLL("Mmdevapi").ActivateAudioInterfaceAsync
            activate.restype = ctypes.HRESULT
            iid = c["IAudioClient"]._iid_
            activate(
                ctypes.c_wchar_p("VAD\\Process_Loopback"),
                ctypes.byref(iid),
                ctypes.byref(prop),
                handler.QueryInterface(c["IActivateAudioInterfaceCompletionHandler"]),
                ctypes.byref(operation),
            )
            if not handler.done.wait(5):
                raise RuntimeError("audio activation timed out")
            result, unknown = operation.GetActivateResult()
            if result < 0:
                raise OSError(f"audio activation failed (0x{result & 0xFFFFFFFF:08X})")
            client = unknown.QueryInterface(c["IAudioClient"])
            fmt = c["WAVEFORMATEX"](1, 1, RATE, RATE * 2, 2, 16, 0)  # PCM 16-bit mono 16 kHz, converted by Windows
            client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 200 * 10_000, 0, ctypes.byref(fmt), None)
            client.SetEventHandle(event)
            capture = client.GetService(ctypes.byref(c["IAudioCaptureClient"]._iid_)).QueryInterface(c["IAudioCaptureClient"])
            client.Start()
            self.started.set()
            log.info("Capturing the audio of process %d", self.pid)
            try:
                while not self._stop.is_set():
                    k.WaitForSingleObject(event, 100)
                    while not self._stop.is_set():
                        if capture.GetNextPacketSize() == 0:
                            break
                        data, frames, flags, _, _ = capture.GetBuffer()
                        if flags & BUFFER_SILENT or not data:
                            chunk = np.zeros(frames, np.float32)
                        else:
                            chunk = np.frombuffer(ctypes.string_at(data, frames * 2), dtype="<i2").astype(np.float32) / 32768.0
                        capture.ReleaseBuffer(frames)
                        if frames:
                            self.on_audio(chunk)
            finally:
                client.Stop()
        finally:
            k.CloseHandle(event)
            comtypes.CoUninitialize()


# ---------------------------------------------------------------- listener


class AppListener:
    """Keeps a capture running for each chosen app that is open, and cuts its audio into utterances.
    `on_utterance(app, audio)` and `on_status(statuses)` are called from capture threads."""

    def __init__(
        self,
        on_utterance: Callable[[str, np.ndarray], None],
        on_status: Callable[[dict[str, str]], None],
        capture_factory: Callable[..., ProcessCapture] | None = None,
        table: Callable[[], list[tuple[int, int, str]]] | None = None,
        every: float = 3.0,
    ):
        self.on_utterance = on_utterance
        self.on_status = on_status
        # Looked up when used, so tests can replace them
        self.capture_factory = capture_factory or (lambda pid, feed: ProcessCapture(pid, feed))
        self.table = table or (lambda: processes())
        self.every = every
        self.apps: list[str] = []
        self._captures: dict[tuple[str, int], tuple[ProcessCapture, Segmenter]] = {}
        # When each app last made sound (monotonic): "in ascolto" or "in ascolto, silenzio"
        self._sound: dict[str, float] = {}
        self._status: dict[str, str] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def set_apps(self, apps: list[str]) -> None:
        with self._lock:
            self.apps = [a for a in dict.fromkeys(a.strip() for a in apps) if a][:8]
        if self.apps and not self._thread:
            self._stop.clear()
            self._thread = threading.Thread(target=self._watch, name="app-audio", daemon=True)
            self._thread.start()
        else:
            self.scan()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            self.apps = []
        self.scan()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(2)
        self._thread = None

    def _watch(self) -> None:
        while not self._stop.is_set():
            try:
                self.scan()
            except Exception as err:  # noqa: BLE001 - keep watching
                log.warning("App audio scan failed: %s", err)
            self._stop.wait(self.every)

    def scan(self) -> None:
        """Starts captures for apps that opened, stops those of apps that closed."""
        with self._lock:
            apps = list(self.apps)
        table = self.table() if apps else []
        wanted = {(app, pid) for app in apps for pid in app_roots(app, table)}
        status: dict[str, str] = {}
        for key in [k for k in self._captures if k not in wanted or not self._captures[k][0].alive]:
            capture, segmenter = self._captures.pop(key)
            capture.stop()
            for audio in segmenter.flush():
                self.on_utterance(key[0], audio)
            if capture.error:
                status[key[0]] = f"errore: {capture.error}"
        for app, pid in sorted(wanted - set(self._captures)):
            self._sound.setdefault(app, time.monotonic())
            segmenter = Segmenter()
            capture = self.capture_factory(pid, self._feeder(app, segmenter))
            if capture.start():
                self._captures[(app, pid)] = (capture, segmenter)
            else:
                status[app] = f"errore: {capture.error or 'non parte'}"
        now = time.monotonic()
        for app in apps:
            if any(k[0] == app for k in self._captures):
                # An app that makes no sound for a while is open but silent (nobody talks, or its audio doesn't reach us)
                status[app] = "in ascolto, silenzio" if now - self._sound.get(app, now) > QUIET_AFTER_S else "in ascolto"
            else:
                self._sound.pop(app, None)
                status.setdefault(app, "chiusa")
        if status != self._status:
            self._status = status
            self.on_status(dict(status))

    def _feeder(self, app: str, segmenter: Segmenter) -> Callable[[np.ndarray], None]:
        def feed(chunk: np.ndarray) -> None:
            if chunk.size and float(np.abs(chunk).max()) > SOUND_LEVEL:
                self._sound[app] = time.monotonic()
            for audio in segmenter.push(chunk):
                self.on_utterance(app, audio)

        return feed
