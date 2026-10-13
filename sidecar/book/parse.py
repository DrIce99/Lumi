"""Books for the audiobook mode: plain text and EPUB to chapters, chapters
to sentences, and sentences marked as narration or dialogue (dialogue can
get a different voice). Standard library only.
"""

from __future__ import annotations

import html
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree


@dataclass
class Chapter:
    title: str
    text: str


@dataclass
class Book:
    title: str
    chapters: list[Chapter] = field(default_factory=list)


_HEADING = re.compile(r"^\s*((capitolo|chapter|parte|part|prologo|epilogo|prologue|epilogue)\b.*|[IVXLC]+\.?\s*)$", re.IGNORECASE)


def parse_text(text: str, title: str = "") -> Book:
    """Chapters start at lines like "Capitolo 3", "PROLOGO" or a lone roman numeral."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    chapters: list[Chapter] = []
    current_title = ""
    current: list[str] = []
    for line in text.split("\n"):
        if _HEADING.match(line) and len(line.strip()) < 80:
            if "".join(current).strip():
                chapters.append(Chapter(current_title or f"Capitolo {len(chapters) + 1}", "\n".join(current).strip()))
            current_title, current = line.strip(), []
        else:
            current.append(line)
    if "".join(current).strip():
        chapters.append(Chapter(current_title or f"Capitolo {len(chapters) + 1}", "\n".join(current).strip()))
    return Book(title or (chapters[0].title if len(chapters) == 1 else "Audiolibro"), chapters)


class _TextExtractor(HTMLParser):
    BLOCKS = {"p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "section", "tr"}
    SKIP = {"script", "style", "head"}

    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self.heading: list[str] = []
        self._in_heading = False
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        if tag in ("h1", "h2", "h3") and not self.heading:
            self._in_heading = True
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        if tag in ("h1", "h2", "h3"):
            self._in_heading = False
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip:
            return
        self.parts.append(data)
        if self._in_heading:
            self.heading.append(data)

    def text(self) -> str:
        return re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t]+", " ", html.unescape("".join(self.parts)))).strip()


def parse_epub(path: str | Path) -> Book:
    """Chapters in reading order (the OPF spine), one per XHTML document."""
    with zipfile.ZipFile(path) as z:
        container = ElementTree.fromstring(z.read("META-INF/container.xml"))
        rootfile = next(el.get("full-path") for el in container.iter() if el.tag.endswith("rootfile"))
        opf = ElementTree.fromstring(z.read(rootfile))
        base = posixpath.dirname(rootfile)
        manifest = {el.get("id"): el.get("href") for el in opf.iter() if el.tag.endswith("item")}
        spine = [el.get("idref") for el in opf.iter() if el.tag.endswith("itemref")]
        title_el = next((el for el in opf.iter() if el.tag.endswith("title")), None)
        book = Book((title_el.text or "").strip() if title_el is not None else Path(path).stem)
        for idref in spine:
            href = manifest.get(idref)
            if not href:
                continue
            name = posixpath.normpath(posixpath.join(base, href.split("#")[0]))
            try:
                raw = z.read(name).decode("utf-8", errors="replace")
            except KeyError:
                continue
            extractor = _TextExtractor()
            extractor.feed(raw)
            text = extractor.text()
            # Covers, title pages and tables of contents have little text
            if len(text) < 200:
                continue
            heading = " ".join("".join(extractor.heading).split()) or f"Capitolo {len(book.chapters) + 1}"
            book.chapters.append(Chapter(heading[:100], text))
    return book


def load_book(path: str | Path) -> Book:
    p = Path(path)
    if p.suffix.lower() == ".epub":
        return parse_epub(p)
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return parse_text(p.read_text(encoding=encoding), p.stem)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Non riesco a leggere {p.name}")


_SENTENCE_END = re.compile(r"(?<=[.!?…»”\"])\s+(?=[«“\"—–\-A-ZÀ-Ý0-9])")


def sentences(text: str, max_chars: int = 300) -> list[str]:
    """Sentences of a chapter; very long ones are cut at commas or spaces."""
    out: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = " ".join(paragraph.split())
        if not paragraph:
            continue
        for sentence in _SENTENCE_END.split(paragraph):
            while len(sentence) > max_chars:
                cut = sentence.rfind(", ", 0, max_chars)
                cut = cut + 1 if cut > max_chars // 3 else sentence.rfind(" ", 0, max_chars)
                if cut <= 0:
                    cut = max_chars
                out.append(sentence[:cut].strip())
                sentence = sentence[cut:].strip()
            if sentence.strip():
                out.append(sentence.strip())
    return out


_DIALOGUE = re.compile(r"(«[^»]+»|“[^”]+”|\"[^\"]+\")")


def voice_parts(sentence: str) -> list[tuple[str, bool]]:
    """Splits narration from dialogue: [(text, is_dialogue)]. A line opening with a dash is dialogue."""
    s = sentence.strip()
    if re.match(r"^[—–-]\s*\S", s):
        return [(s.lstrip("—–- ").strip(), True)]
    parts: list[tuple[str, bool]] = []
    pos = 0

    def narration(chunk: str) -> None:
        # Commas and dots around the dialogue belong to the quotes, not to the narration
        text = chunk.strip().strip(",;:").strip()
        if re.search(r"\w", text):
            parts.append((text, False))

    for m in _DIALOGUE.finditer(s):
        narration(s[pos : m.start()])
        parts.append((m.group(0)[1:-1].strip(), True))
        pos = m.end()
    narration(s[pos:])
    return [p for p in parts if p[0]] or [(s, False)]
