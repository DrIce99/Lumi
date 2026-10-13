"""Fake engines for the protocol tests: no model, no GPU."""

from __future__ import annotations

import threading

import numpy as np

from ocr.base import Box, OcrLine, OcrWord
from stt.base import Transcript, Word
from tts.base import EngineUnavailable, TTSEngine, to_pcm16


class FakeTTS(TTSEngine):
    name = "fake-tts"
    loads = 0
    unloads = 0
    gate: threading.Event | None = None
    spoken: list[tuple[str, str, float]] = []

    def load(self):
        FakeTTS.loads += 1
        self.device = "cpu"

    def unload(self):
        FakeTTS.unloads += 1

    def stream(self, text, emotion, intensity, voice, cancel=None):
        FakeTTS.spoken.append((text, emotion, intensity))
        for i in range(3):
            if FakeTTS.gate is not None and i == 1:
                FakeTTS.gate.wait(5)
            if cancel and cancel.cancelled:
                return
            yield to_pcm16(np.full(240, 0.1 * (i + 1), dtype=np.float32), 24000)


class MissingTTS(FakeTTS):
    def load(self):
        raise EngineUnavailable("non installato")


class FakeSTT:
    name = "fake-stt"
    device = "cuda"
    fast = True

    def __init__(self, config, models_dir):
        self.config = config

    def load(self):
        pass

    def unload(self):
        pass

    def transcribe(self, audio, vocabulary, partial):
        seconds = len(audio) / 16000
        if partial:
            return Transcript(f"parziale {seconds:.1f}")
        return Transcript("ciao Lumi", [Word("ciao", 0.0, 0.4), Word("Lumi", 0.45, 0.9)])


class FakeOCR:
    name = "fake-ocr"
    device = "cpu"

    def load(self):
        pass

    def unload(self):
        pass

    def recognize(self, image, lang="it"):
        w, h = image.size
        box = Box(1, 2, w - 2, 10)
        return [OcrLine("Errore alla riga 3", box, [OcrWord("Errore", Box(1, 2, 30, 10))])]


def factories(tts=FakeTTS):
    return {
        "tts": lambda config, models_dir: tts(config, models_dir),
        "stt": lambda config, models_dir: FakeSTT(config, models_dir),
        "ocr": lambda config, models_dir: FakeOCR(),
    }
