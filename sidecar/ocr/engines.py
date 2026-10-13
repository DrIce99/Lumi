"""OCR engine selection: Windows OCR first, RapidOCR as the fallback."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass

from tts.base import EngineUnavailable

from .base import OCREngine

log = logging.getLogger("lumi.ocr")


@dataclass
class OCRConfig:
    engine: str = "windows"

    def key(self) -> tuple:
        return (self.engine,)

    @property
    def model(self) -> str:
        return ""


def make_ocr(config: OCRConfig) -> OCREngine:
    if config.engine == "windows" and sys.platform == "win32":
        from .winocr_engine import WindowsOcrEngine

        engine = WindowsOcrEngine()
        try:
            engine.load()
            return _Loaded(engine)
        except EngineUnavailable as err:
            log.warning("%s: using RapidOCR", err)
    from .rapidocr_engine import RapidOcrEngine

    return RapidOcrEngine()


class _Loaded(OCREngine):
    """An engine that was already loaded while choosing it."""

    def __init__(self, inner: OCREngine):
        self.inner = inner
        self.name = inner.name
        self.device = "cpu"

    def load(self) -> None:
        pass

    def unload(self) -> None:
        pass

    def recognize(self, image, lang="it"):
        return self.inner.recognize(image, lang)
