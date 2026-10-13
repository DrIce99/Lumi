"""RapidOCR (PP-OCR on onnxruntime): the fallback when Windows OCR is not
available. Latin recognition model; word boxes are estimated from the line
box in proportion to the characters.
"""

from __future__ import annotations

import logging

import numpy as np
from PIL import Image

from paths import models_dir

from .base import Box, OCREngine, OcrLine, OcrWord

log = logging.getLogger("lumi.ocr.rapidocr")


def split_words(text: str, box: Box) -> list[OcrWord]:
    """Word boxes proportional to their position in the line (monospace estimate)."""
    words = []
    total = max(1, len(text))
    pos = 0
    for token in text.split(" "):
        if token:
            x = box.x + box.width * pos / total
            w = box.width * len(token) / total
            words.append(OcrWord(token, Box(x, box.y, w, box.height)))
        pos += len(token) + 1
    return words


class RapidOcrEngine(OCREngine):
    name = "rapidocr"

    def __init__(self):
        self.engine = None

    def load(self) -> None:
        from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

        folder = models_dir() / "rapidocr"
        folder.mkdir(parents=True, exist_ok=True)
        self.engine = RapidOCR(
            params={
                "Global.model_root_dir": str(folder),
                "Global.log_level": "warning",
                "Rec.lang_type": LangRec.LATIN,
                "Rec.ocr_version": OCRVersion.PPOCRV5,
                "Rec.model_type": ModelType.MOBILE,
            }
        )

    def recognize(self, image: Image.Image, lang: str = "it") -> list[OcrLine]:
        if self.engine is None:
            self.load()
        result = self.engine(np.array(image.convert("RGB")))
        if result is None or result.boxes is None or result.txts is None:
            return []
        lines: list[OcrLine] = []
        for poly, text, score in zip(result.boxes, result.txts, result.scores or [], strict=False):
            if not text.strip() or score < 0.5:
                continue
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            box = Box(float(min(xs)), float(min(ys)), float(max(xs) - min(xs)), float(max(ys) - min(ys)))
            lines.append(OcrLine(text, box, split_words(text, box)))
        # Reading order: top to bottom, then left to right
        lines.sort(key=lambda l: (round(l.rect.y / max(8.0, l.rect.height * 0.6)), l.rect.x))
        return lines
