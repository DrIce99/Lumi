"""The interface every TTS engine implements.

    class TTSEngine:
        def stream(self, text, emotion, intensity, voice) -> Iterator[bytes]: ...
        # PCM 16-bit mono 24 kHz, in chunks

Engines are loaded lazily and only one is kept in memory: VRAM is the
constraint. Text arrives already normalized to spoken Italian.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field

import numpy as np

SAMPLE_RATE = 24_000


@dataclass
class TTSConfig:
    engine: str = "qwen3"
    model: str = "1.7B-CustomVoice"
    voice: str = "ryan"
    speed: float = 1.0
    seed: int = 7
    device: str = "auto"
    #: ["parola", "pronuncia"] pairs (text/lexicon_it.py); a light setting, no reload
    lexicon: list = field(default_factory=list)

    def key(self) -> tuple:
        """Settings that need a new engine instance when they change."""
        return (self.engine, self.model, self.device) + ((self.voice,) if self.engine == "chatterbox" else ())


@dataclass
class Cancel:
    """Set when the request is cancelled: engines check it between chunks."""

    event: threading.Event = field(default_factory=threading.Event)

    @property
    def cancelled(self) -> bool:
        return self.event.is_set()


class EngineUnavailable(RuntimeError):
    """The engine's packages or hardware are missing (shown to the user)."""


class TTSEngine(ABC):
    name = "base"
    sample_rate = SAMPLE_RATE

    def __init__(self, config: TTSConfig, models_dir: str):
        self.config = config
        self.models_dir = models_dir
        self.device = "cpu"

    @abstractmethod
    def load(self) -> None: ...

    def unload(self) -> None:
        """Frees memory (and VRAM)."""

    @abstractmethod
    def stream(self, text: str, emotion: str, intensity: float, voice: str, cancel: Cancel | None = None) -> Iterator[bytes]:
        """Synthesizes `text`, yielding PCM 16-bit mono chunks at `sample_rate` as soon as they are ready."""

    def voices(self) -> list[str]:
        return []

    def warmup(self) -> None:
        """Runs a first tiny synthesis so the first real sentence is fast."""
        for _ in self.stream("Pronto.", "neutra", 0.5, self.config.voice):
            pass


def to_pcm16(audio: np.ndarray, source_rate: int, target_rate: int = SAMPLE_RATE) -> bytes:
    """Float audio (-1..1) to PCM 16-bit little endian at `target_rate`."""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if source_rate != target_rate and samples.size:
        import soxr

        samples = soxr.resample(samples, source_rate, target_rate)
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def chunked(pcm: bytes, sample_rate: int = SAMPLE_RATE, ms: int = 200) -> Iterator[bytes]:
    """Splits a finished synthesis into ~`ms` chunks (engines without native streaming)."""
    step = max(2, int(sample_rate * ms / 1000) * 2)
    for i in range(0, len(pcm), step):
        yield pcm[i : i + step]
