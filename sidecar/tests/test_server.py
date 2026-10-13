"""The app <-> sidecar protocol, with fake engines."""

import base64
import io
import json
import struct
import threading

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server
from engines import EngineManager

from .fakes import FakeTTS, factories


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    with TestClient(server.app) as c:
        server.state.manager = EngineManager(str(tmp_path), factories())
        FakeTTS.spoken = []
        FakeTTS.gate = None
        yield c


def test_health_and_config(client):
    body = client.get("/health").json()
    assert body["ok"] is True and body["sampleRate"] == 24000
    assert isinstance(body["installed"], list)
    out = client.post(
        "/config",
        json={"tts": {"engine": "kokoro", "model": "v1.0", "voice": "im_nicola"}, "stt": {"engine": "faster-whisper"}, "ocr": {"engine": "windows"}, "preload": False},
    ).json()
    assert {e["kind"] for e in out["engines"]} == {"tts", "stt", "ocr"}
    # Remote speech recognition needs nothing here
    out = client.post("/config", json={"stt": {"engine": "groq"}}).json()
    assert {e["kind"] for e in out["engines"]} == {"tts", "ocr"}


def test_token_is_required(client, monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "segreto")
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer sbagliato"}).status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer segreto"}).status_code == 200
    with pytest.raises(Exception):
        with client.websocket_connect("/tts") as ws:
            ws.receive_text()
    with client.websocket_connect("/tts?token=segreto") as ws:
        ws.send_text(json.dumps({"id": 1, "text": ""}))
        assert json.loads(ws.receive_text())["done"] is True


def read_until_done(ws, wanted_id):
    audio = b""
    events = []
    while True:
        message = ws.receive()
        if message.get("bytes") is not None:
            (sid,) = struct.unpack("<I", message["bytes"][:4])
            assert sid == wanted_id
            audio += message["bytes"][4:]
            continue
        data = json.loads(message["text"])
        events.append(data)
        if data.get("done") and data["id"] == wanted_id:
            return audio, events


def test_tts_streams_normalized_text_with_ids(client):
    client.post("/config", json={"tts": {"engine": "kokoro"}, "preload": False})
    with client.websocket_connect("/tts") as ws:
        ws.send_text(json.dumps({"id": 7, "text": "Sono le 15:30, costa 12,50 €", "emotion": "gioia", "intensity": 0.8}))
        audio, events = read_until_done(ws, 7)
    assert events[0] == {"id": 7, "start": True, "sampleRate": 24000}
    assert len(audio) == 3 * 240 * 2
    done = events[-1]
    assert done["cancelled"] is False and done["audioMs"] == 30 and "error" not in done
    assert FakeTTS.spoken == [("Sono le quindici e trenta, costa dodici euro e cinquanta", "gioia", 0.8)]


def test_tts_cancel_stops_a_running_sentence_and_drops_queued_ones(client):
    client.post("/config", json={"tts": {"engine": "kokoro"}, "preload": False})
    FakeTTS.gate = threading.Event()
    with client.websocket_connect("/tts") as ws:
        ws.send_text(json.dumps({"id": 1, "text": "Prima frase.", "emotion": "neutra"}))
        ws.send_text(json.dumps({"id": 2, "text": "Seconda frase.", "emotion": "neutra"}))
        assert json.loads(ws.receive_text())["start"] is True
        first = ws.receive()
        assert first["bytes"][:4] == struct.pack("<I", 1)
        ws.send_text(json.dumps({"cancel": "all"}))
        FakeTTS.gate.set()
        _audio, events = read_until_done(ws, 1)
        assert events[-1]["cancelled"] is True
        ws.send_text(json.dumps({"id": 3, "text": "Terza.", "emotion": "neutra"}))
        _audio, events = read_until_done(ws, 3)
    assert [s[0] for s in FakeTTS.spoken] == ["Prima frase.", "Terza."]


def test_stt_partials_and_final(client):
    client.post("/config", json={"stt": {"engine": "faster-whisper"}, "preload": False})
    pcm = (np.zeros(16000, dtype="<i2")).tobytes()
    with client.websocket_connect("/stt") as ws:
        ws.send_text(json.dumps({"type": "start", "id": 5, "vocabulary": ["Lumi"], "partials": True}))
        for i in range(0, len(pcm), 3200):
            ws.send_bytes(struct.pack("<I", 5) + pcm[i : i + 3200])
        partial = json.loads(ws.receive_text())
        assert partial["id"] == 5 and partial["partial"].startswith("parziale")
        ws.send_text(json.dumps({"type": "end", "id": 5}))
        while True:
            data = json.loads(ws.receive_text())
            if "final" in data:
                break
    assert data["final"] == "ciao Lumi"
    assert data["durationMs"] == 1000
    assert data["words"][1] == {"word": "Lumi", "start": 0.45, "end": 0.9, "p": 1.0}


def test_stt_ignores_tiny_segments(client):
    client.post("/config", json={"stt": {"engine": "faster-whisper"}, "preload": False})
    with client.websocket_connect("/stt") as ws:
        ws.send_text(json.dumps({"type": "start", "id": 9, "partials": False}))
        ws.send_bytes(struct.pack("<I", 9) + b"\0" * 1000)
        ws.send_text(json.dumps({"type": "end", "id": 9}))
        data = json.loads(ws.receive_text())
    assert data == {"id": 9, "final": "", "words": [], "durationMs": 31, "ms": 0}


def test_ocr_png_and_raw(client):
    client.post("/config", json={"ocr": {"engine": "windows"}, "preload": False})
    buf = io.BytesIO()
    Image.new("RGB", (100, 20), "white").save(buf, format="PNG")
    out = client.post("/ocr", json={"image": base64.b64encode(buf.getvalue()).decode()}).json()
    assert out["lines"][0]["text"] == "Errore alla riga 3"
    assert out["lines"][0]["rect"] == {"x": 1.0, "y": 2.0, "width": 98.0, "height": 10.0}
    raw = bytes(40 * 10 * 4)
    out = client.post("/ocr", json={"image": base64.b64encode(raw).decode(), "format": "bgra", "width": 40, "height": 10}).json()
    assert out["lines"][0]["rect"]["width"] == 38.0


def test_screen_luma_frames(client, monkeypatch):
    import screen

    assert screen.thumbnail_size(3440, 1440, 640) == (640, 268)
    assert screen.thumbnail_size(1080, 1920, 640) == (360, 640)
    assert screen.thumbnail_size(300, 200, 640) == (300, 200)
    asked = []

    def fake(x, y, width, height, max_side):
        asked.append((x, y, width, height, max_side))
        w, h = screen.thumbnail_size(width, height, max_side)
        return w, h, bytes([len(asked)]) * (w * h)

    monkeypatch.setattr(screen, "grab_luma", fake)
    regions = [{"x": 0, "y": 0, "width": 3440, "height": 1440}, {"x": 3440, "y": -232, "width": 1080, "height": 1920}]
    res = client.post("/screen/luma", json={"regions": regions})
    assert res.headers["x-sizes"] == "640x268,360x640"
    assert res.content == bytes([1]) * (640 * 268) + bytes([2]) * (360 * 640)
    assert asked == [(0, 0, 3440, 1440, 640), (3440, -232, 1080, 1920, 640)]


@pytest.mark.skipif(not hasattr(__import__("ctypes"), "windll"), reason="Windows only")
def test_screen_luma_real_capture():
    import ctypes

    import screen

    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    w, h, luma = screen.grab_luma(0, 0, 800, 400, 200)
    assert (w, h) == (200, 100) and len(luma) == 200 * 100


@pytest.mark.skipif(not hasattr(__import__("ctypes"), "windll"), reason="Windows only")
def test_screen_jpeg(client):
    import ctypes

    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    res = client.post("/screen/jpeg", json={"region": {"x": 0, "y": 0, "width": 800, "height": 400}, "size": 400})
    assert res.headers["x-size"] == "400x200"
    assert Image.open(io.BytesIO(res.content)).size == (400, 200)
