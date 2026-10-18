"""CPU embeddings for the memory (roadmap 10.6): pooling, and /embed with a fake model."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

import server
from embed import onnx_embed
from embed.onnx_embed import MODELS, pool


def test_pooling_is_cls_or_masked_mean_and_unit_length():
    hidden = np.array([[[3.0, 4.0], [1.0, 0.0], [100.0, 100.0]]])
    mask = np.array([[1, 1, 0]])
    assert np.allclose(pool(hidden, mask, "cls"), [[0.6, 0.8]])
    # The padding token (mask 0) doesn't count
    mean = pool(hidden, mask, "mean")
    assert np.allclose(mean, np.array([[2.0, 2.0]]) / np.sqrt(8))
    assert np.allclose(np.linalg.norm(mean, axis=1), 1)


def test_default_model_is_bge_m3_so_its_similarity_floor_applies():
    # The app's floors match on /^bge-m3/: the name must start like that
    assert onnx_embed.DEFAULT_MODEL.startswith("bge-m3")
    assert MODELS[onnx_embed.DEFAULT_MODEL].pooling == "cls"


class FakeEmbedder:
    def __init__(self, name):
        self.name = name
        self.loaded = False
        self.calls = []

    def embed(self, texts, kind):
        self.loaded = True
        self.calls.append((list(texts), kind))
        return np.array([[1.0, 0.0] if kind == "query" else [0.0, 1.0] for _ in texts], dtype=np.float32)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(server, "TOKEN", "")
    monkeypatch.setattr(onnx_embed, "OnnxEmbedder", FakeEmbedder)
    server.state.embedder = None
    with TestClient(server.app) as c:
        yield c
    server.state.embedder = None


def test_embed_endpoint(client):
    out = client.post("/embed", json={"texts": ["ciao", "gatto"], "kind": "query"}).json()
    assert out["model"] == onnx_embed.DEFAULT_MODEL
    assert out["vectors"] == [[1.0, 0.0], [1.0, 0.0]]
    assert client.post("/embed", json={"texts": ["x"]}).json()["vectors"] == [[0.0, 1.0]]
    engines = client.get("/health").json()["engines"]
    assert any(e["kind"] == "embed" and e["state"] == "ready" and e["device"] == "cpu" for e in engines)
    assert client.post("/embed", json={"texts": ["x"] * 65}).status_code == 413

