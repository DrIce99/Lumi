"""Wake word detector and the /wake socket, with a fake openWakeWord model."""

import json
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient

import server
from wake import detector as wake
from wake.detector import CHUNK, WakeDetector, WakeModelMissing


class FakeModel:
    """Scores 0.9 for loud chunks, 0.01 for quiet ones; counts resets."""

    def __init__(self) -> None:
        self.resets = 0
        self.chunks: list[int] = []

    def predict(self, chunk: np.ndarray) -> dict[str, float]:
        self.chunks.append(len(chunk))
        return {"lumi": 0.9 if np.abs(chunk).mean() > 1000 else 0.01}

    def reset(self) -> None:
        self.resets += 1


def pcm(samples: int, level: int = 0) -> bytes:
    return np.full(samples, level, dtype=np.int16).tobytes()


@pytest.fixture(autouse=True)
def clean_cache():
    WakeDetector._cache.clear()
    yield
    WakeDetector._cache.clear()


def test_audio_is_scored_in_80_ms_chunks_across_frames():
    model = FakeModel()
    d = WakeDetector("lumi", model)
    assert d.feed(pcm(512)) == []
    assert d.feed(pcm(512)) == []
    scores = d.feed(pcm(512 + CHUNK, 3000))
    assert len(scores) == 2 and model.chunks == [CHUNK, CHUNK]
    # 512 * 3 + 1280 = 2816 samples: 256 wait for the next frame
    assert len(d._pending) == 256
    assert scores[1] == pytest.approx(0.9)
    d.reset()
    assert len(d._pending) == 0 and model.resets == 1
    assert d.feed(pcm(100)[:-1]) == []  # an odd byte count is tolerated


def test_trained_model_must_exist_and_is_loaded_once(monkeypatch, tmp_path):
    monkeypatch.setattr(wake, "wake_dir", lambda: tmp_path)
    with pytest.raises(WakeModelMissing):
        WakeDetector.load("lumi", factory=lambda _p: FakeModel())
    (tmp_path / "lumi.onnx").write_bytes(b"onnx")
    loads = []

    def factory(path):
        loads.append(path.name)
        return FakeModel()

    a = WakeDetector.load("lumi", factory=factory)
    b = WakeDetector.load("lumi", factory=factory)
    assert loads == ["lumi.onnx"] and a.model is b.model
    assert a.model.resets == 2, "each stream starts clean"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    with TestClient(server.app) as c:
        server.state.wake_state = "idle"
        yield c


def test_wake_socket_scores_speech(client, monkeypatch):
    model = FakeModel()
    monkeypatch.setattr(WakeDetector, "load", classmethod(lambda cls, name: cls(name, model)))
    with client.websocket_connect("/wake") as ws:
        ws.send_text(json.dumps({"model": "lumi"}))
        assert json.loads(ws.receive_text()) == {"type": "ready", "model": "lumi"}
        ws.send_bytes(struct.pack("<I", 0) + pcm(CHUNK * 2, 4000))
        assert json.loads(ws.receive_text()) == {"type": "scores", "scores": [0.9, 0.9]}
        ws.send_text(json.dumps({"reset": True}))
        ws.send_bytes(struct.pack("<I", 0) + pcm(CHUNK))
        assert json.loads(ws.receive_text()) == {"type": "scores", "scores": [0.01]}
    assert model.resets == 1
    engines = client.get("/health").json()["engines"]
    assert {"kind": "wake", "state": "ready"}.items() <= next(e for e in engines if e["kind"] == "wake").items()


def test_wake_socket_reports_a_missing_model(client, monkeypatch):
    def missing(cls, name):
        raise WakeModelMissing("lumi.onnx not found")

    monkeypatch.setattr(WakeDetector, "load", classmethod(missing))
    with client.websocket_connect("/wake") as ws:
        ws.send_text(json.dumps({"model": "lumi"}))
        reply = json.loads(ws.receive_text())
        assert reply["type"] == "error" and reply["missing"] is True


def test_training_augmentation_keeps_the_name_at_the_end_of_a_2_s_window():
    from wake import train

    rng = np.random.default_rng(1)
    word = np.concatenate([np.zeros(4000), np.sin(np.arange(8000) / 5) * 0.5, np.zeros(4000)]).astype(np.float32)
    assert len(train.vary_speed(word, 1.25)) == pytest.approx(len(word) / 1.25, abs=2)
    placed = train.fit_window(train.trim_silence(word), rng)
    assert len(placed) == train.WINDOW
    loud = np.flatnonzero(np.abs(placed) > 0.01)
    assert train.WINDOW - loud[-1] <= 0.2 * train.RATE + 1, "the word ends within 200 ms of the window's end"
    clip = train.augment(word, rng, [])
    assert clip.dtype == np.int16 and len(clip) == train.WINDOW
    noisy = train.add_noise(word, np.ones(10, dtype=np.float32), snr_db=10)
    assert len(noisy) == len(word)
    assert np.abs(train.room_response(rng, 0.3)).sum() == pytest.approx(4, rel=1e-3)
