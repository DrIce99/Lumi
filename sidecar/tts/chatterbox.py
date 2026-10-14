"""Chatterbox Multilingual (Resemble AI): zero-shot voice cloning from a
reference clip, emotions through the `exaggeration` parameter.

No native streaming: each sentence is synthesized whole, then sent in
chunks. The same reference clip is used for every sentence so the voice
stays the same.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from pathlib import Path

from devices import prepare_cuda_dlls, resolve_device

from .base import Cancel, EngineUnavailable, TTSEngine, chunked, to_pcm16
from .emotions import chatterbox_exaggeration

log = logging.getLogger("lumi.tts.chatterbox")


class ChatterboxEngine(TTSEngine):
    name = "chatterbox"

    def __init__(self, config, models_dir_path: str):
        super().__init__(config, models_dir_path)
        self.model = None
        self.clip: str | None = None
        self._lock = threading.Lock()

    def load(self) -> None:
        prepare_cuda_dlls()
        try:
            import torch
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        except ImportError as err:
            raise EngineUnavailable("Chatterbox non è installato nel sidecar: esegui `uv sync --extra chatterbox` nella cartella sidecar.") from err
        self.device = resolve_device(self.config.device)
        log.info("Loading Chatterbox Multilingual on %s", self.device)
        self.model = ChatterboxMultilingualTTS.from_pretrained(device=torch.device(self.device))
        clip = self.config.voice
        self.clip = clip if clip and Path(clip).is_file() else None
        if self.clip:
            self.model.prepare_conditionals(self.clip, exaggeration=0.5)

    def unload(self) -> None:
        self.model = None
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass

    def voices(self) -> list[str]:
        return ["predefinita"]

    def stream(self, text: str, emotion: str, intensity: float, voice: str, cancel: Cancel | None = None) -> Iterator[bytes]:
        import torch

        if self.model is None:
            self.load()
        with self._lock, torch.inference_mode():
            torch.manual_seed(self.config.seed)
            wav = self.model.generate(
                text,
                language_id="it",
                exaggeration=chatterbox_exaggeration(emotion, intensity),
                cfg_weight=0.4 if intensity > 0.7 else 0.5,
                temperature=0.8,
            )
        if cancel and cancel.cancelled:
            return
        audio = wav.squeeze().detach().cpu().float().numpy()
        yield from chunked(to_pcm16(audio, self.model.sr))
