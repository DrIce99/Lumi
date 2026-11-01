"""Books for the audiobook mode: plain text, EPUB and DOCX to chapters, chapters
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


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_levels(z: zipfile.ZipFile) -> dict[str, int]:
    """Paragraph style id -> heading level (0 = the document's title). Built-in style
    names are English in every Word ("heading 1"), their ids are not ("Titolo1")."""
    try:
        root = ElementTree.fromstring(z.read("word/styles.xml"))
    except KeyError:
        return {}
    levels: dict[str, int] = {}
    for style in root.iter(f"{_W}style"):
        name_el = style.find(f"{_W}name")
        name = (name_el.get(f"{_W}val") or "").lower() if name_el is not None else ""
        outline = style.find(f"{_W}pPr/{_W}outlineLvl")
        if name == "title":
            levels[style.get(f"{_W}styleId", "")] = 0
        elif m := re.fullmatch(r"heading (\d)", name):
            levels[style.get(f"{_W}styleId", "")] = int(m.group(1))
        elif outline is not None and (outline.get(f"{_W}val") or "").isdigit():
            levels[style.get(f"{_W}styleId", "")] = int(outline.get(f"{_W}val")) + 1
    return levels


def _docx_text(el: ElementTree.Element, out: list[str]) -> None:
    for child in el:
        tag = child.tag
        if tag == f"{_W}t":
            out.append(child.text or "")
        elif tag in (f"{_W}tab", f"{_W}br", f"{_W}cr"):
            out.append(" ")
        elif not _docx_skipped(tag):
            _docx_text(child, out)


def _docx_skipped(tag: str) -> bool:
    """Deleted text (tracked changes) and text boxes (their copy for old Words comes along too)."""
    return tag in (f"{_W}del", f"{_W}txbxContent") or tag.endswith("}AlternateContent")


def _docx_paragraphs(el: ElementTree.Element):
    """The body's paragraphs in order, tables included, text boxes left out."""
    for child in el:
        if child.tag == f"{_W}p":
            yield child
        elif not _docx_skipped(child.tag):
            yield from _docx_paragraphs(child)


def parse_docx(path: str | Path) -> Book:
    """Chapters at Word's headings 1 and 2 (a heading with no text after it joins the next
    one: "Parte prima - Capitolo 1"); without headings, as plain text ("Capitolo 3" lines)."""
    with zipfile.ZipFile(path) as z:
        levels = _docx_levels(z)
        body = ElementTree.fromstring(z.read("word/document.xml")).find(f"{_W}body")
        try:
            core = ElementTree.fromstring(z.read("docProps/core.xml"))
            title_el = next((el for el in core.iter() if el.tag.endswith("}title")), None)
            title = (title_el.text or "").strip() if title_el is not None else ""
        except KeyError:
            title = ""
    paragraphs: list[tuple[int | None, str]] = []
    for p in _docx_paragraphs(body) if body is not None else []:
        parts: list[str] = []
        _docx_text(p, parts)
        text = " ".join("".join(parts).split())
        if not text:
            continue
        style = p.find(f"{_W}pPr/{_W}pStyle")
        level = levels.get(style.get(f"{_W}val", "")) if style is not None else None
        outline = p.find(f"{_W}pPr/{_W}outlineLvl")
        if outline is not None and (outline.get(f"{_W}val") or "").isdigit():
            level = int(outline.get(f"{_W}val")) + 1
        paragraphs.append((level, text))
    if not title:
        title = next((t for level, t in paragraphs if level == 0), "") or Path(path).stem
    paragraphs = [(level, t) for level, t in paragraphs if level != 0]
    if not any(level in (1, 2) for level, _ in paragraphs):
        return parse_text("\n\n".join(t for _, t in paragraphs), title)
    book = Book(title)
    heading, lines, has_text = "", [], False
    for level, text in paragraphs + [(1, "")]:
        if level in (1, 2):
            if has_text:
                book.chapters.append(Chapter(heading[:100] or f"Capitolo {len(book.chapters) + 1}", "\n\n".join(lines)))
                heading, lines, has_text = "", [], False
            # The heading is read too, as in an EPUB
            heading = f"{heading} - {text}" if heading else text
            if text:
                lines.append(text)
        else:
            lines.append(text)
            has_text = True
    return book


def load_book(path: str | Path) -> Book:
    p = Path(path)
    if p.suffix.lower() == ".epub":
        return parse_epub(p)
    if p.suffix.lower() == ".docx":
        return parse_docx(p)
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
# A dash touching a space: "— Vieni, — disse Marco — subito."
_DASH = re.compile(r"\s*(?:\s[—–]|[—–]\s|\s-\s)\s*")


def _clean(chunk: str) -> str:
    """Commas and colons around a switch of voice belong to neither side."""
    return chunk.strip().strip(",;:").strip()


def voice_parts(sentence: str) -> list[tuple[str, bool]]:
    """Splits narration from dialogue: [(text, is_dialogue)]. A line opening with a dash is
    dialogue, and further dashes in it switch between dialogue and narration."""
    s = sentence.strip()
    if re.match(r"^[—–-]\s*\S", s):
        segments = _DASH.split(s.lstrip("—–- "))
        parts = [(_clean(seg), i % 2 == 0) for i, seg in enumerate(segments)]
        return [p for p in parts if re.search(r"\w", p[0])] or [(s.lstrip("—–- ").strip(), True)]
    parts: list[tuple[str, bool]] = []
    pos = 0

    def narration(chunk: str) -> None:
        text = _clean(chunk)
        if re.search(r"\w", text):
            parts.append((text, False))

    for m in _DIALOGUE.finditer(s):
        narration(s[pos : m.start()])
        parts.append((m.group(0)[1:-1].strip(), True))
        pos = m.end()
    narration(s[pos:])
    return [p for p in parts if p[0]] or [(s, False)]


# Silence after a piece: a sentence inside a paragraph, a switch between narrator and
# dialogue voice (or a long sentence cut at a comma), the end of a paragraph, a scene
# break ("* * *")
PAUSE_SENTENCE_MS = 250
PAUSE_TURN_MS = 150
PAUSE_PARAGRAPH_MS = 700
PAUSE_SCENE_MS = 1600


@dataclass
class Piece:
    """One synthesis call: whole sentences of one voice, up to ~250 characters, so the
    intonation carries across them (sentence by sentence every one restarted flat)."""

    text: str
    dialogue: bool
    pause_ms: int


def paragraphs(text: str) -> list[str]:
    """Blank lines separate paragraphs; a text without any has one paragraph per line."""
    text = text.replace("\r\n", "\n").strip()
    blocks = re.split(r"\n\s*\n", text)
    if len(blocks) == 1 and text.count("\n") >= 2:
        blocks = text.split("\n")
    return [" ".join(b.split()) for b in blocks if b.strip()]


# A paragraph in square brackets is the edition's, not the story's: "[Illustrazione: ...]"
_EDITORIAL = re.compile(r"^\[[^\]]*\]$")


def _pack(items: list[str], max_chars: int) -> list[str]:
    out: list[str] = []
    for item in items:
        if out and len(out[-1]) + 1 + len(item) <= max_chars:
            out[-1] += " " + item
        else:
            out.append(item)
    return out


def pieces(text: str, max_chars: int = 250, dialogue: bool = True) -> list[Piece]:
    """A chapter as synthesis pieces with the pause after each. `dialogue`: split the
    dialogue out (it gets another voice)."""
    out: list[Piece] = []
    for paragraph in paragraphs(text):
        if not re.search(r"\w", paragraph):
            # "* * *", "***", "§": a scene break
            if out:
                out[-1].pause_ms = max(out[-1].pause_ms, PAUSE_SCENE_MS)
            continue
        if _EDITORIAL.match(paragraph):
            continue
        parts = voice_parts(paragraph) if dialogue else [(paragraph, False)]
        for part, is_dialogue in parts:
            for chunk in _pack(sentences(part, max_chars), max_chars):
                ended = re.search(r"[.!?…»”\"]$", chunk)
                out.append(Piece(chunk, is_dialogue, PAUSE_SENTENCE_MS if ended else PAUSE_TURN_MS))
            out[-1].pause_ms = PAUSE_TURN_MS
        out[-1].pause_ms = PAUSE_PARAGRAPH_MS
    return out
