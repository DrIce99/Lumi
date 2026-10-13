"""whisper.cpp through pywhispercpp: for PCs without a GPU (optional extra
`whispercpp`). Final results only.
"""

from __future__ import annotations

import os

import numpy as np

from paths import models_dir

from .base import SAMPLE_RATE, STTEngine, Transcript, clean_transcript, is_silence, vocabulary_prompt


class WhisperCppEngine(STTEngine):
    name = "whisper-cpp"

    def __init__(self, config, models_dir_path: str):
        super().__init__(config, models_dir_path)
        self.model = None

    def load(self) -> None:
        try:
            from pywhispercpp.model import Model
        except ImportError as err:
            from tts.base import EngineUnavailable

            raise EngineUnavailable("whisper.cpp non è installato: nel sidecar esegui `uv sync --extra whispercpp`.") from err
        folder = models_dir() / "whisper-cpp"
        folder.mkdir(parents=True, exist_ok=True)
        self.model = Model(self.config.model, models_dir=str(folder), n_threads=max(1, (os.cpu_count() or 4) - 1), print_progress=False, print_realtime=False)
        self.device = "cpu"

    def unload(self) -> None:
        self.model = None

    @property
    def fast(self) -> bool:
        return False

    def transcribe(self, audio: np.ndarray, vocabulary: list[str], partial: bool) -> Transcript:
        if self.model is None:
            self.load()
        if is_silence(audio):
            return Transcript("")
        prompt = vocabulary_prompt(vocabulary)
        segments = self.model.transcribe(audio.astype(np.float32), language=self.config.language, **({"initial_prompt": prompt} if prompt else {}))
        text = " ".join(s.text for s in segments)
        return Transcript(clean_transcript(text, len(audio) / SAMPLE_RATE))
