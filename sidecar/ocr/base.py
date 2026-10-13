"""OCR engines: an image in, lines and words with their rectangles out
(in the image's pixel coordinates)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field

from PIL import Image


@dataclass
class Box:
    x: float
    y: float
    width: float
    height: float

    def union(self, other: Box) -> Box:
        x0, y0 = min(self.x, other.x), min(self.y, other.y)
        x1 = max(self.x + self.width, other.x + other.width)
        y1 = max(self.y + self.height, other.y + other.height)
        return Box(x0, y0, x1 - x0, y1 - y0)


@dataclass
class OcrWord:
    text: str
    rect: Box


@dataclass
class OcrLine:
    text: str
    rect: Box
    words: list[OcrWord] = field(default_factory=list)


def lines_to_json(lines: list[OcrLine]) -> list[dict]:
    out = []
    for line in lines:
        d = asdict(line)
        d["rect"] = {k: round(v, 1) for k, v in d["rect"].items()}
        for w in d["words"]:
            w["rect"] = {k: round(v, 1) for k, v in w["rect"].items()}
        out.append(d)
    return out


class OCREngine(ABC):
    name = "base"
    device = "cpu"

    @abstractmethod
    def load(self) -> None: ...

    def unload(self) -> None:
        """Frees memory."""

    @abstractmethod
    def recognize(self, image: Image.Image, lang: str = "it") -> list[OcrLine]: ...
