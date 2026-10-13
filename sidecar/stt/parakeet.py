"""Parakeet TDT 0.6B v3 (NVIDIA, multilingual European) through onnx-asr.

Very fast, also on the CPU; no vocabulary hints and no word times.
"""

from __future__ import annotations

import numpy as np

from paths import models_dir

from .base import SAMPLE_RATE, STTEngine, Transcript, clean_transcript, is_silence

MODEL = "nemo-parakeet-tdt-0.6b-v3"


class ParakeetEngine(STTEngine):
    name = "parakeet"

    def __init__(self, config, models_dir_path: str):
        super().__init__(config, models_dir_path)
        self.model = None

    def load(self) -> None:
        import onnx_asr
        import onnxruntime

        providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in onnxruntime.get_available_providers()]
        if self.config.device == "cpu":
            providers = ["CPUExecutionProvider"]
        name = self.config.model if self.config.model.startswith("nemo-") else MODEL
        self.model = onnx_asr.load_model(name, str(models_dir() / "parakeet" / name), quantization="int8", providers=providers)
        self.device = "cuda" if providers and providers[0] == "CUDAExecutionProvider" else "cpu"

    def unload(self) -> None:
        self.model = None

    @property
    def fast(self) -> bool:
        return True

    def transcribe(self, audio: np.ndarray, vocabulary: list[str], partial: bool) -> Transcript:
        if self.model is None:
            self.load()
        if is_silence(audio):
            return Transcript("")
        text = self.model.recognize(audio.astype(np.float32), sample_rate=SAMPLE_RATE)
        if not isinstance(text, str):
            text = getattr(text, "text", "") or ""
        return Transcript(clean_transcript(text, len(audio) / SAMPLE_RATE))
