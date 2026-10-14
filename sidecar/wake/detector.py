"""Wake word spotting with openWakeWord on the CPU.

The app streams the microphone's speech (PCM 16-bit, 16 kHz) to /wake; the
detector cuts it into 80 ms chunks (1280 samples, what openWakeWord expects)
and returns one score per chunk. The app decides when it fires (threshold,
two frames in a row, higher while Lumi talks): the logic stays testable there.

Models live in %APPDATA%\\Lumi\\models\\wake: "lumi.onnx" is trained by
wake/train.py; the generic openWakeWord models ("hey_jarvis"...) and the
shared feature models are downloaded on first use, to try the flow before
training.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

import paths

log = logging.getLogger("lumi.wake")

SAMPLE_RATE = 16_000
CHUNK = 1280
RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
FEATURES = ("melspectrogram.onnx", "embedding_model.onnx")
GENERIC = {
    "hey_jarvis": "hey_jarvis_v0.1.onnx",
    "alexa": "alexa_v0.1.onnx",
    "hey_mycroft": "hey_mycroft_v0.1.onnx",
}


class WakeModelMissing(Exception):
    """The requested model isn't there (lumi.onnx not trained yet)."""


class ScoreModel(Protocol):
    def predict(self, chunk: np.ndarray) -> dict[str, float]: ...

    def reset(self) -> None: ...


def wake_dir() -> Path:
    return paths.models_dir() / "wake"


def model_file(name: str) -> Path:
    """The .onnx of a wake word model: generic ones are downloaded, trained ones must exist."""
    if name in GENERIC:
        return paths.download(RELEASE + GENERIC[name], wake_dir() / GENERIC[name])
    path = wake_dir() / f"{name}.onnx"
    if not path.exists():
        raise WakeModelMissing(f"{path} not found: train it with wake/train.py")
    return path


def feature_files() -> tuple[Path, Path]:
    mel, emb = (paths.download(RELEASE + f, wake_dir() / f) for f in FEATURES)
    return mel, emb


def openwakeword_model(path: Path) -> ScoreModel:
    from openwakeword.model import Model

    mel, emb = feature_files()
    return Model(
        wakeword_models=[str(path)],
        inference_framework="onnx",
        melspec_model_path=str(mel),
        embedding_model_path=str(emb),
    )


class WakeDetector:
    """One stream's detector: buffers PCM into 80 ms chunks and scores each one."""

    _cache: dict[str, ScoreModel] = {}
    _lock = threading.Lock()

    def __init__(self, name: str, model: ScoreModel) -> None:
        self.name = name
        self.model = model
        self._pending = np.zeros(0, dtype=np.int16)

    @classmethod
    def load(cls, name: str, factory: Callable[[Path], ScoreModel] = openwakeword_model) -> "WakeDetector":
        """The model is loaded once per process (a few MB, ~50 ms); each stream starts from a clean state."""
        with cls._lock:
            model = cls._cache.get(name)
            if model is None:
                model = factory(model_file(name))
                cls._cache[name] = model
                log.info("Wake word model %s loaded", name)
        detector = cls(name, model)
        detector.reset()
        return detector

    def reset(self) -> None:
        """A new speech segment: no audio or features carried over from the last one."""
        self._pending = np.zeros(0, dtype=np.int16)
        self.model.reset()

    def feed(self, pcm: bytes) -> list[float]:
        """Scores (0..1) for every complete 80 ms chunk now available."""
        if len(pcm) % 2:
            pcm = pcm[:-1]
        samples = np.concatenate([self._pending, np.frombuffer(pcm, dtype=np.int16)])
        scores: list[float] = []
        whole = len(samples) - len(samples) % CHUNK
        for start in range(0, whole, CHUNK):
            result = self.model.predict(samples[start : start + CHUNK])
            scores.append(float(max(result.values())) if result else 0.0)
        self._pending = samples[whole:].copy()
        return scores
