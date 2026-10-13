"""faster-whisper (CTranslate2): large-v3-turbo in int8, excellent Italian.

On the GPU it is fast enough for partial results while the user speaks;
on the CPU only final results are computed.
"""

from __future__ import annotations

import logging

import numpy as np

from devices import prepare_cuda_dlls, resolve_device
from paths import models_dir

from .base import SAMPLE_RATE, STTEngine, Transcript, Word, clean_transcript, is_silence, vocabulary_prompt

log = logging.getLogger("lumi.stt.whisper")


class FasterWhisperEngine(STTEngine):
    name = "faster-whisper"

    def __init__(self, config, models_dir_path: str):
        super().__init__(config, models_dir_path)
        self.model = None

    def load(self) -> None:
        prepare_cuda_dlls()
        from faster_whisper import WhisperModel

        device = resolve_device(self.config.device)
        compute = "int8_float16" if device == "cuda" else "int8"
        try:
            self.model = WhisperModel(self.config.model, device=device, compute_type=compute, download_root=str(models_dir() / "whisper"))
        except Exception as err:
            if device != "cuda":
                raise
            # A broken CUDA setup (missing cuBLAS) must not leave Lumi deaf
            log.warning("faster-whisper can't use the GPU (%s): falling back to the CPU", err)
            device, compute = "cpu", "int8"
            self.model = WhisperModel(self.config.model, device=device, compute_type=compute, download_root=str(models_dir() / "whisper"))
        self.device = device
        # The first call allocates buffers: do it now (on faint noise), not on the user's first sentence
        noise = np.random.default_rng(0).normal(0, 0.02, SAMPLE_RATE // 2).astype(np.float32)
        self.transcribe(noise, [], partial=True)

    def unload(self) -> None:
        self.model = None

    def transcribe(self, audio: np.ndarray, vocabulary: list[str], partial: bool) -> Transcript:
        if self.model is None:
            self.load()
        if is_silence(audio):
            return Transcript("")
        segments, _info = self.model.transcribe(
            audio,
            language=self.config.language,
            beam_size=1 if partial else 5,
            temperature=0.0 if partial else [0.0, 0.2, 0.4],
            initial_prompt=vocabulary_prompt(vocabulary),
            condition_on_previous_text=False,
            vad_filter=False,
            word_timestamps=not partial,
            without_timestamps=partial,
            no_speech_threshold=0.6,
        )
        words: list[Word] = []
        texts: list[str] = []
        for segment in segments:
            # A segment that is probably not speech is dropped
            if segment.no_speech_prob > 0.6 and segment.avg_logprob < -0.5:
                continue
            texts.append(segment.text)
            for w in segment.words or []:
                words.append(Word(w.word.strip(), round(w.start, 3), round(w.end, 3), round(w.probability, 3)))
        text = clean_transcript("".join(texts), len(audio) / SAMPLE_RATE)
        return Transcript(text, words if text else [])
