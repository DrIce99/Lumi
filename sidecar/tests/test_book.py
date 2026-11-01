import time
import wave
import zipfile
from concurrent.futures import Future
from types import SimpleNamespace

import numpy as np
from fastapi.testclient import TestClient

import server
from book.audio import acceptable, level, tidy
from book.batch import BatchJob, BatchRunner, ffmetadata
from book.parse import PAUSE_PARAGRAPH_MS, PAUSE_SCENE_MS, PAUSE_SENTENCE_MS, PAUSE_TURN_MS, load_book, parse_text, pieces, sentences, voice_parts
from engines import EngineManager
from stt.base import STTConfig, Transcript
from tts.base import SAMPLE_RATE, TTSConfig, to_pcm16

from .fakes import FakeTTS, factories


def tone(seconds: float, amplitude: float = 0.3) -> np.ndarray:
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.zeros(int(SAMPLE_RATE * seconds), np.float32)


def seconds_of(pcm: bytes) -> float:
    return len(pcm) / (2 * SAMPLE_RATE)


def test_text_chapters():
    book = parse_text("Capitolo 1\nC'era una volta.\n\nCapitolo 2\nFine.\n", "Fiaba")
    assert book.title == "Fiaba"
    assert [c.title for c in book.chapters] == ["Capitolo 1", "Capitolo 2"]
    assert book.chapters[1].text == "Fine."
    plain = parse_text("Solo testo senza capitoli.")
    assert len(plain.chapters) == 1


def test_epub_chapters_in_spine_order(tmp_path):
    path = tmp_path / "libro.epub"
    body = "<p>" + "Una frase del capitolo. " * 20 + "</p>"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr(
            "OEBPS/content.opf",
            '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Il libro</dc:title></metadata>'
            '<manifest><item id="a" href="uno.xhtml"/><item id="b" href="due.xhtml"/><item id="c" href="cover.xhtml"/></manifest>'
            '<spine><itemref idref="c"/><itemref idref="b"/><itemref idref="a"/></spine></package>',
        )
        z.writestr("OEBPS/cover.xhtml", "<html><body><p>Copertina</p></body></html>")
        z.writestr("OEBPS/uno.xhtml", f"<html><body><h1>Primo</h1>{body}</body></html>")
        z.writestr("OEBPS/due.xhtml", f"<html><head><style>p{{}}</style></head><body><h2>Secondo</h2>{body}</body></html>")
    book = load_book(path)
    assert book.title == "Il libro"
    assert [c.title for c in book.chapters] == ["Secondo", "Primo"]
    assert "Copertina" not in book.chapters[0].text


W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'


def docx(path, body: str, styles: bool = True, title: str | None = None) -> None:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", f"<w:document {W_NS}><w:body>{body}</w:body></w:document>")
        if styles:
            # An Italian Word: ids are Italian, names English
            z.writestr(
                "word/styles.xml",
                f'<w:styles {W_NS}><w:style w:styleId="Titolo"><w:name w:val="Title"/></w:style>'
                '<w:style w:styleId="Titolo1"><w:name w:val="heading 1"/></w:style>'
                '<w:style w:styleId="Titolo2"><w:name w:val="heading 2"/></w:style></w:styles>',
            )
        if title is not None:
            z.writestr("docProps/core.xml", f'<cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title></cp:coreProperties>')


def para(text: str, style: str | None = None) -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>"


def test_docx_chapters_from_word_headings(tmp_path):
    path = tmp_path / "romanzo.docx"
    docx(
        path,
        para("Il romanzo", "Titolo")
        + para("Parte prima", "Titolo1")
        + para("Capitolo 1", "Titolo2")
        # A word split in runs, a deleted word, a text box (with its copy for old Words)
        + '<w:p><w:r><w:t xml:space="preserve">C\'era </w:t></w:r><w:r><w:t>una vol</w:t></w:r><w:r><w:t>ta.</w:t></w:r>'
        '<w:del><w:r><w:delText>cancellato</w:delText></w:r></w:del>'
        "<w:r><mc:AlternateContent><mc:Choice><w:txbxContent>" + para("Casella") + "</w:txbxContent></mc:Choice>"
        "<mc:Fallback><w:txbxContent>" + para("Casella") + "</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>"
        + para("«Chi sei?» chiese lei.")
        + para("Capitolo 2", "Titolo2")
        + para("[Illustrazione: il gatto.]")
        + para("Fine."),
    )
    book = load_book(path)
    assert book.title == "Il romanzo"
    assert [c.title for c in book.chapters] == ["Parte prima - Capitolo 1", "Capitolo 2"]
    assert book.chapters[0].text == "Parte prima\n\nCapitolo 1\n\nC'era una volta.\n\n«Chi sei?» chiese lei."
    assert [p.text for p in pieces(book.chapters[1].text)] == ["Capitolo 2", "Fine."]


def test_docx_without_headings_reads_like_text(tmp_path):
    path = tmp_path / "racconto.docx"
    docx(path, para("Capitolo 1") + para("Prima.") + para("Capitolo 2") + para("Seconda."), styles=False, title="Un racconto")
    book = load_book(path)
    assert book.title == "Un racconto"
    assert [(c.title, c.text) for c in book.chapters] == [("Capitolo 1", "Prima."), ("Capitolo 2", "Seconda.")]


def test_sentences_and_dialogue():
    assert sentences("Ciao! Come stai? Bene.\n\nNuovo paragrafo.") == ["Ciao!", "Come stai?", "Bene.", "Nuovo paragrafo."]
    long = "parola " * 100
    assert all(len(s) <= 300 for s in sentences(long))
    assert voice_parts("«Vieni qui» disse Marco, «subito».") == [("Vieni qui", True), ("disse Marco", False), ("subito", True)]
    assert voice_parts("— Chi è? chiese lei.") == [("Chi è? chiese lei.", True)]
    assert voice_parts("Solo narrazione.") == [("Solo narrazione.", False)]


def test_ffmetadata_chapters():
    meta = ffmetadata("Libro; uno", [{"title": "Capitolo 1", "startMs": 0, "endMs": 1500}])
    assert meta.startswith(";FFMETADATA1\ntitle=Libro\\; uno")
    assert "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=Capitolo 1" in meta


def test_batch_job_writes_a_wav(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    with TestClient(server.app) as client:
        server.state.manager = EngineManager(str(tmp_path), factories())
        server.state.books.manager = server.state.manager
        FakeTTS.gate = None
        client.post("/config", json={"tts": {"engine": "kokoro"}, "preload": False})
        out = tmp_path / "libro.wav"
        job = client.post("/tts/batch", json={"text": "Capitolo 1\nCiao. «Chi sei?»\nCapitolo 2\nFine.", "output": str(out), "dialogueVoice": "if_sara"}).json()
        for _ in range(100):
            status = client.get(f"/tts/batch/{job['id']}").json()
            if status["state"] in ("done", "error"):
                break
            time.sleep(0.05)
    assert status["state"] == "done", status
    assert status["total"] == 3 and status["done"] == 3
    assert [c["title"] for c in status["chapters"]] == ["Capitolo 1", "Capitolo 2"]
    with wave.open(status["file"]) as w:
        assert w.getframerate() == 24000
        assert w.getnframes() > 24000
    assert status["checked"] is False and status["report"] is None


def test_batch_job_retakes_and_reports_what_it_misread(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    with TestClient(server.app) as client:
        server.state.manager = EngineManager(str(tmp_path), factories())
        server.state.books.manager = server.state.manager
        FakeTTS.gate = None
        client.post("/config", json={"tts": {"engine": "kokoro"}, "stt": {"engine": "faster-whisper"}, "preload": False})
        # FakeSTT always hears "ciao Lumi"
        job = client.post("/tts/batch", json={"text": "Ciao Lumi.\n\nUna frase che la voce sbaglia sempre.", "output": str(tmp_path / "libro.wav")}).json()
        for _ in range(100):
            status = client.get(f"/tts/batch/{job['id']}").json()
            if status["state"] in ("done", "error"):
                break
            time.sleep(0.05)
    assert status["state"] == "done", status
    assert status["checked"] is True
    assert status["retakes"] == 2 and status["doubtful"] == 1
    report = (tmp_path / "libro.da-riascoltare.txt").read_text(encoding="utf-8")
    assert "Una frase che la voce sbaglia sempre." in report and "Ciao Lumi" not in report


def test_pieces_keep_paragraphs_voices_and_scenes():
    text = "Era sera. Pioveva.\n\n«Chi è?» chiese lei. «Io.»\n\n* * *\n\n— Vieni, — disse Marco — subito."
    got = [(p.text, p.dialogue, p.pause_ms) for p in pieces(text)]
    assert got == [
        ("Era sera. Pioveva.", False, PAUSE_PARAGRAPH_MS),
        ("Chi è?", True, PAUSE_TURN_MS),
        ("chiese lei.", False, PAUSE_TURN_MS),
        ("Io.", True, PAUSE_SCENE_MS),
        ("Vieni", True, PAUSE_TURN_MS),
        ("disse Marco", False, PAUSE_TURN_MS),
        ("subito.", True, PAUSE_PARAGRAPH_MS),
    ]
    # Without a dialogue voice a paragraph stays whole
    assert [p.text for p in pieces(text, dialogue=False)][1] == "«Chi è?» chiese lei. «Io.»"
    # Sentences are packed up to the limit, never cut in the middle
    long = " ".join(f"Frase numero {i} del paragrafo." for i in range(30))
    packed = pieces(long, max_chars=120)
    assert all(len(p.text) <= 120 and p.text.endswith(".") for p in packed)
    assert [p.pause_ms for p in packed[:-1]] == [PAUSE_SENTENCE_MS] * (len(packed) - 1)
    # A text without blank lines has a paragraph per line
    assert len(pieces("Uno.\nDue.\nTre.", dialogue=False)) == 3
    # A long sentence cut at a comma flows on; the edition's notes are not read
    cut = pieces("Primo pezzo " * 15 + ", secondo pezzo " * 10 + "fine.\n\n[Illustrazione: un gatto.]", max_chars=200)
    assert [p.pause_ms for p in cut] == [PAUSE_TURN_MS, PAUSE_PARAGRAPH_MS]


def test_tidy_trims_edges_and_long_silences():
    audio = np.concatenate([quiet(0.2), tone(0.5), quiet(1.5), tone(0.5), quiet(0.3)])
    out = tidy(to_pcm16(audio, SAMPLE_RATE))
    assert abs(seconds_of(out) - (0.03 + 0.5 + 0.45 + 0.5 + 0.08)) < 0.03
    # A normal pause stays as it is
    short = np.concatenate([tone(0.5), quiet(0.6), tone(0.5)])
    assert abs(seconds_of(tidy(to_pcm16(short, SAMPLE_RATE))) - 1.6) < 0.01
    assert tidy(to_pcm16(quiet(1.0), SAMPLE_RATE)) == b""


def test_level_evens_out_takes_within_limits():
    def rms_db(pcm: bytes) -> float:
        a = np.frombuffer(pcm, "<i2").astype(np.float32) / 32768
        return 20 * np.log10(np.sqrt(np.mean(a**2)))

    assert abs(rms_db(level(to_pcm16(tone(1.0, 0.07), SAMPLE_RATE))) - -17) < 0.5
    # Very quiet: at most +9 dB
    quiet_take = to_pcm16(tone(1.0, 0.02), SAMPLE_RATE)
    assert abs(rms_db(level(quiet_take)) - rms_db(quiet_take) - 9) < 0.5
    # Loud peaks stay under -1 dBFS
    peaks = np.frombuffer(level(to_pcm16(tone(1.0, 0.99), SAMPLE_RATE)), "<i2")
    assert np.max(np.abs(peaks)) / 32768 < 10 ** (-1 / 20) + 0.01


def test_acceptable_takes():
    text = "Il gatto dorme sul divano mentre fuori piove da tre giorni."
    assert acceptable(text, "Il gatto dorme sul divano, mentre fuori piove da tre giorni!", 4.0)[0]
    assert not acceptable(text, "Il gatto dorme mentre fuori piove.", 4.0)[0]
    assert not acceptable(text, text + " mentre fuori piove da tre giorni", 4.0)[0]
    # One name heard another way in a short piece
    assert acceptable("disse Gianmarco", "disse Gian Marco", 1.0)[0]
    assert acceptable("disse Aurelio", "disse Aurello", 1.0)[0]
    # Too long for its text: babbling or a stuck silence
    assert not acceptable("Sì.", "Sì.", 6.0)[0]


class FakeManager:
    """Engines run inline: the TTS records its seeds, the STT hears `heard` in turn."""

    def __init__(self, heard: list[str] | None, seeded: bool = True):
        self.heard = heard
        self.seeds: list[int | None] = []
        self.tts = SimpleNamespace(config=TTSConfig(seed=7), seeded=seeded, stream=self._stream)
        self.stt = SimpleNamespace(transcribe=lambda audio, vocabulary, partial: Transcript(self.heard.pop(0)))

    def _stream(self, text, emotion, intensity, voice, cancel=None, seed=None):
        self.seeds.append(seed)
        yield to_pcm16(tone(len(text) * 0.07), SAMPLE_RATE)

    def config(self, kind):
        if kind == "tts":
            return self.tts.config
        return STTConfig() if self.heard is not None else None

    def submit(self, kind, fn):
        future = Future()
        future.set_result(fn(self.tts if kind == "tts" else self.stt))
        return future


def test_take_retries_with_other_seeds_until_it_hears_the_text():
    text = "Il gatto dorme sul divano."
    manager = FakeManager(["Il gatto sul divano dorme dorme.", text])
    job = BatchJob("j", output=None)
    audio, ok = BatchRunner(manager)._take(text, None, job, ())
    assert ok and audio and job.checked is True
    assert manager.seeds == [None, 7 + 1009] and job.retakes == 1


def test_take_keeps_the_closest_when_none_is_right():
    text = "Il gatto dorme sul divano."
    manager = FakeManager(["niente", "Il gatto dorme.", "boh"])
    job = BatchJob("j", output=None)
    audio, ok = BatchRunner(manager)._take(text, None, job, ())
    assert not ok and audio and len(manager.seeds) == 3 and job.retakes == 2


def test_take_without_a_recognizer_or_another_seed():
    job = BatchJob("j", output=None)
    manager = FakeManager(None)
    assert BatchRunner(manager)._take("Ciao.", None, job, ())[1]
    assert manager.seeds == [None] and job.checked is False
    # Kokoro says it the same way every time: one take, checked anyway
    job = BatchJob("k", output=None)
    manager = FakeManager(["tutt'altro"], seeded=False)
    assert not BatchRunner(manager)._take("Ciao a tutti.", None, job, ())[1]
    assert manager.seeds == [None]
