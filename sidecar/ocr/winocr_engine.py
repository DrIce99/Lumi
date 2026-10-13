"""Windows OCR (Windows.Media.Ocr through WinRT): fast, local, word boxes.

Uses the Italian recognizer when its language pack is installed, otherwise
the user's profile languages (English is always good for Latin text).
"""

from __future__ import annotations

import asyncio
import logging

from PIL import Image

from tts.base import EngineUnavailable

from .base import Box, OCREngine, OcrLine, OcrWord

log = logging.getLogger("lumi.ocr.windows")


class WindowsOcrEngine(OCREngine):
    name = "windows"

    def __init__(self):
        self.engines: dict[str, object] = {}
        self.language = ""

    def load(self) -> None:
        try:
            from winrt.windows.globalization import Language
            from winrt.windows.media.ocr import OcrEngine
        except ImportError as err:
            raise EngineUnavailable("Windows OCR non è disponibile (pacchetti winrt mancanti).") from err
        self._Language = Language
        self._OcrEngine = OcrEngine
        engine = self._engine("it")
        if engine is None:
            raise EngineUnavailable("Windows OCR non ha nessuna lingua installata: aggiungi l'italiano da Impostazioni → Lingua.")

    def _engine(self, lang: str):
        if lang in self.engines:
            return self.engines[lang]
        engine = None
        try:
            if self._OcrEngine.is_language_supported(self._Language(lang)):
                engine = self._OcrEngine.try_create_from_language(self._Language(lang))
        except Exception:
            engine = None
        if engine is None:
            engine = self._OcrEngine.try_create_from_user_profile_languages()
        if engine is not None:
            self.language = engine.recognizer_language.language_tag
            log.info("Windows OCR language: %s (asked %s)", self.language, lang)
        self.engines[lang] = engine
        return engine

    def recognize(self, image: Image.Image, lang: str = "it") -> list[OcrLine]:
        from winrt.windows.graphics.imaging import BitmapPixelFormat, SoftwareBitmap
        from winrt.windows.storage.streams import DataWriter

        engine = self._engine(lang)
        # Windows OCR refuses images larger than OcrEngine.max_image_dimension
        limit = int(getattr(self._OcrEngine, "max_image_dimension", 10000) or 10000)
        scale = 1.0
        if max(image.width, image.height) > limit:
            scale = limit / max(image.width, image.height)
            image = image.resize((int(image.width * scale), int(image.height * scale)))
        rgba = image.convert("RGBA")
        writer = DataWriter()
        writer.write_bytes(rgba.tobytes())
        bitmap = SoftwareBitmap.create_copy_from_buffer(writer.detach_buffer(), BitmapPixelFormat.RGBA8, rgba.width, rgba.height)

        async def run():
            return await engine.recognize_async(bitmap)

        result = asyncio.run(run())
        lines: list[OcrLine] = []
        for line in result.lines:
            words = []
            box: Box | None = None
            for word in line.words:
                r = word.bounding_rect
                b = Box(r.x / scale, r.y / scale, r.width / scale, r.height / scale)
                words.append(OcrWord(word.text, b))
                box = b if box is None else box.union(b)
            if box is not None and line.text.strip():
                lines.append(OcrLine(line.text, box, words))
        return lines
