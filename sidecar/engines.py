"""Loads, keeps and swaps the engines chosen in the settings.

Only the selected STT, TTS and OCR engines are kept in memory (VRAM is the
constraint): changing engine unloads the previous one. Loading happens in
the background; every engine reports its state for /health.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field

from stt.base import STTConfig, STTEngine
from tts.base import EngineUnavailable, TTSConfig, TTSEngine

log = logging.getLogger("lumi.engines")


@dataclass
class EngineState:
    kind: str
    name: str
    state: str = "idle"  # missing | idle | loading | ready | error
    device: str | None = None
    detail: str | None = None
    loaded_at: float = 0.0

    def to_json(self) -> dict:
        out = {"kind": self.kind, "name": self.name, "state": self.state}
        if self.device:
            out["device"] = self.device
        if self.detail:
            out["detail"] = self.detail
        return out


def make_tts(config: TTSConfig, models_dir: str) -> TTSEngine:
    if config.engine == "qwen3":
        from tts.qwen3 import Qwen3Engine

        return Qwen3Engine(config, models_dir)
    if config.engine == "chatterbox":
        from tts.chatterbox import ChatterboxEngine

        return ChatterboxEngine(config, models_dir)
    if config.engine == "kokoro":
        from tts.kokoro import KokoroEngine

        return KokoroEngine(config, models_dir)
    raise EngineUnavailable(f"Motore di sintesi sconosciuto: {config.engine}")


def make_stt(config: STTConfig, models_dir: str) -> STTEngine:
    if config.engine == "faster-whisper":
        from stt.faster_whisper import FasterWhisperEngine

        return FasterWhisperEngine(config, models_dir)
    if config.engine == "parakeet":
        from stt.parakeet import ParakeetEngine

        return ParakeetEngine(config, models_dir)
    if config.engine == "whisper-cpp":
        from stt.whisper_cpp import WhisperCppEngine

        return WhisperCppEngine(config, models_dir)
    raise EngineUnavailable(f"Motore di riconoscimento sconosciuto: {config.engine}")


@dataclass
class Slot:
    """One engine kind (stt, tts, ocr): its config, instance, state and the thread that runs it."""

    kind: str
    executor: ThreadPoolExecutor
    config: object = None
    engine: object = None
    state: EngineState | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


#: Preloading order: the voice first (the greeting), then hearing, then OCR.
PRELOAD_ORDER = ("tts", "stt", "ocr")


class EngineManager:
    def __init__(self, models_dir: str, factories: dict | None = None):
        self.models_dir = models_dir
        self.factories = factories or {"tts": make_tts, "stt": make_stt, "ocr": self._make_ocr}
        # GPU work of each kind runs on its own single thread, in order
        self.slots = {kind: Slot(kind, ThreadPoolExecutor(1, thread_name_prefix=f"lumi-{kind}")) for kind in ("tts", "stt", "ocr")}
        self.extra: dict[str, EngineState] = {}
        # One engine loads at a time: CUDA initialization in two libraries at
        # once (torch, CTranslate2) can crash the process
        self.load_lock = threading.Lock()
        # Set while an engine captures CUDA graphs (Qwen3-TTS): no other GPU
        # work may run meanwhile, or the capture fails or hangs
        self.exclusive = threading.Event()
        self._preload: list[str] = []
        self._preload_lock = threading.Lock()
        self._preloader: threading.Thread | None = None

    # ---- configuration ----

    def configure(self, kind: str, config, preload: bool) -> None:
        slot = self.slots[kind]
        with slot.lock:
            same = slot.config is not None and _key(slot.config) == _key(config)
            slot.config = config
            if same and slot.engine is not None:
                # Same engine: only light settings changed (speed, seed, vocabulary...)
                slot.engine.config = config
                return
            if slot.engine is not None:
                old = slot.engine
                slot.engine = None
                slot.executor.submit(_unload, old)
            slot.state = EngineState(kind, _name(config))
        if preload:
            self.preload(kind)

    def preload(self, kind: str) -> None:
        """Loads in the background, one engine after the other in PRELOAD_ORDER."""
        with self._preload_lock:
            if kind not in self._preload:
                self._preload.append(kind)
            if self._preloader and self._preloader.is_alive():
                return
            self._preloader = threading.Thread(target=self._run_preload, name="lumi-preload", daemon=True)
            self._preloader.start()

    def _run_preload(self) -> None:
        while True:
            with self._preload_lock:
                pending = sorted(self._preload, key=lambda k: PRELOAD_ORDER.index(k) if k in PRELOAD_ORDER else 99)
                if not pending:
                    return
                kind = pending[0]
                self._preload.remove(kind)
            try:
                self.load_async(kind).result()
            except Exception:
                pass  # reported in the engine's state

    def disable(self, kind: str) -> None:
        slot = self.slots[kind]
        with slot.lock:
            if slot.engine is not None:
                slot.executor.submit(_unload, slot.engine)
            slot.engine = None
            slot.config = None
            slot.state = None

    def load_async(self, kind: str) -> Future:
        return self.slots[kind].executor.submit(self.get, kind)

    # ---- use (only from the slot's own thread) ----

    def get(self, kind: str):
        """The loaded engine of a kind, loading it if needed. Call on the slot's executor."""
        slot = self.slots[kind]
        with slot.lock:
            if slot.engine is not None:
                return slot.engine
            config = slot.config
            if config is None:
                raise EngineUnavailable(f"Nessun motore {kind} configurato")
            state = slot.state = EngineState(kind, _name(config), "loading")
        started = time.monotonic()
        try:
            with self.load_lock:
                engine = self.factories[kind](config, self.models_dir)
                exclusive = getattr(engine, "exclusive_load", False)
                if exclusive:
                    self.exclusive.set()
                try:
                    engine.load()
                finally:
                    if exclusive:
                        self.exclusive.clear()
        except EngineUnavailable as err:
            state.state, state.detail = "missing", str(err)
            log.warning("%s engine %s unavailable: %s", kind, state.name, err)
            raise
        except Exception as err:
            state.state, state.detail = "error", f"{type(err).__name__}: {err}"[:300]
            log.exception("%s engine %s failed to load", kind, state.name)
            raise
        with slot.lock:
            if slot.config is not config:
                # Reconfigured while loading: this engine is already stale
                _unload(engine)
                return self.get(kind) if slot.config is not None else None
            slot.engine = engine
            state.state, state.device, state.detail = "ready", getattr(engine, "device", None), None
            state.loaded_at = time.time()
        log.info("%s engine %s ready on %s in %.1f s", kind, state.name, state.device, time.monotonic() - started)
        return engine

    def submit(self, kind: str, fn, *args) -> Future:
        """Runs fn(engine, *args) on the slot's thread."""

        def run():
            engine = self.get(kind)
            # Never touch the GPU while another engine captures its CUDA graphs
            while self.exclusive.is_set() and kind != "ocr":
                time.sleep(0.05)
            return fn(engine, *args)

        return self.slots[kind].executor.submit(run)

    def engine(self, kind: str):
        return self.slots[kind].engine

    def config(self, kind: str):
        return self.slots[kind].config

    def statuses(self) -> list[dict]:
        out = [slot.state.to_json() for slot in self.slots.values() if slot.state is not None]
        out.extend(state.to_json() for state in self.extra.values())
        return out

    def shutdown(self) -> None:
        for slot in self.slots.values():
            slot.executor.shutdown(wait=False, cancel_futures=True)

    @staticmethod
    def _make_ocr(config, models_dir):
        from ocr.engines import make_ocr

        return make_ocr(config)


def _key(config) -> tuple:
    key = getattr(config, "key", None)
    return key() if callable(key) else (repr(config),)


def _name(config) -> str:
    engine = getattr(config, "engine", str(config))
    model = getattr(config, "model", "")
    return f"{engine} {model}".strip()


def _unload(engine) -> None:
    try:
        engine.unload()
    except Exception:
        log.exception("Unloading %s failed", getattr(engine, "name", engine))
