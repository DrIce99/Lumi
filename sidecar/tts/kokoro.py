"""Kokoro (82M) through kokoro-onnx: light, Italian voices, runs on the CPU.

No emotional control: emotions only nudge the speaking rate. The two
Italian voices are `im_nicola` (male) and `if_sara` (female).
"""

from __future__ import annotations

from collections.abc import Iterator

from paths import download, models_dir

from .base import Cancel, EngineUnavailable, TTSEngine, chunked, to_pcm16
from .emotions import speed_factor

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"
ITALIAN_VOICES = ["im_nicola", "if_sara"]


class KokoroEngine(TTSEngine):
    name = "kokoro"

    def __init__(self, config, models_dir_path: str):
        super().__init__(config, models_dir_path)
        self.kokoro = None

    def load(self) -> None:
        try:
            from kokoro_onnx import Kokoro
        except ImportError as err:
            raise EngineUnavailable("Kokoro non è installato nel sidecar (pacchetto kokoro-onnx).") from err
        folder = models_dir() / "kokoro"
        model = download(f"{RELEASE}/{MODEL_FILE}", folder / MODEL_FILE)
        voices = download(f"{RELEASE}/{VOICES_FILE}", folder / VOICES_FILE)
        self.kokoro = Kokoro(str(model), str(voices))
        self.device = "cpu"

    def unload(self) -> None:
        self.kokoro = None

    def voices(self) -> list[str]:
        if not self.kokoro:
            return ITALIAN_VOICES
        try:
            available = list(self.kokoro.get_voices())
        except Exception:
            return ITALIAN_VOICES
        # Italian first, then the rest (they speak Italian with an accent)
        return ITALIAN_VOICES + sorted(v for v in available if v not in ITALIAN_VOICES)

    def stream(self, text: str, emotion: str, intensity: float, voice: str, cancel: Cancel | None = None) -> Iterator[bytes]:
        if not self.kokoro:
            self.load()
        name = voice if voice and voice in self.voices() else ITALIAN_VOICES[0]
        speed = max(0.6, min(1.6, self.config.speed * speed_factor(emotion, intensity)))
        samples, rate = self.kokoro.create(text, voice=name, speed=speed, lang="it")
        if cancel and cancel.cancelled:
            return
        yield from chunked(to_pcm16(samples, rate))
