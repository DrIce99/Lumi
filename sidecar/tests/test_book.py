import time
import wave
import zipfile

from fastapi.testclient import TestClient

import server
from book.batch import ffmetadata
from book.parse import load_book, parse_text, sentences, voice_parts
from engines import EngineManager

from .fakes import FakeTTS, factories


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
