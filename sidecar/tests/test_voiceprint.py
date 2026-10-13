"""Voiceprints: the Kaldi features match torchaudio's, the STT final carries the voiceprint when asked."""

import json
import struct

import numpy as np
import pytest

import server
import voiceprint
from engines import EngineManager

from .fakes import factories


def test_fbank_matches_torchaudio_kaldi():
    kaldi = pytest.importorskip("torchaudio.compliance.kaldi")
    import torch

    rng = np.random.default_rng(1)
    t = np.arange(16000 * 2) / 16000
    audio = (0.3 * np.sin(2 * np.pi * 180 * t) + 0.1 * np.sin(2 * np.pi * 2300 * t) + 0.05 * rng.standard_normal(len(t))).astype(np.float32)
    reference = kaldi.fbank(
        torch.from_numpy(audio).unsqueeze(0) * 32768,
        num_mel_bins=80,
        frame_length=25,
        frame_shift=10,
        dither=0.0,
        sample_frequency=16000,
        window_type="hamming",
        energy_floor=0.0,
    ).numpy()
    ours = voiceprint.fbank(audio)
    assert ours.shape == reference.shape
    assert np.abs(ours - reference).max() < 2e-3


def test_trim_keeps_the_speech_and_short_audio_has_no_voiceprint():
    silence = np.zeros(16000, dtype=np.float32)
    speech = (0.2 * np.sin(2 * np.pi * 200 * np.arange(8000) / 16000)).astype(np.float32)
    assert len(voiceprint.trim(np.concatenate([silence, speech, silence]))) == 8000
    assert voiceprint.embed(np.concatenate([silence, speech, silence])) is None, "half a second of speech is too little"


def test_stt_final_carries_the_voiceprint_when_asked(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server, "TOKEN", "")
    monkeypatch.setattr(voiceprint, "embed", lambda audio: [0.6, 0.8])
    with TestClient(server.app) as client:
        server.state.manager = EngineManager(str(tmp_path), factories())
        client.post("/config", json={"stt": {"engine": "faster-whisper"}, "preload": False})
        pcm = np.zeros(16000, dtype="<i2").tobytes()
        finals = []
        with client.websocket_connect("/stt") as ws:
            for sid, wanted in ((1, True), (2, False)):
                ws.send_text(json.dumps({"type": "start", "id": sid, "partials": False, "voiceprint": wanted}))
                ws.send_bytes(struct.pack("<I", sid) + pcm)
                ws.send_text(json.dumps({"type": "end", "id": sid}))
                while True:
                    data = json.loads(ws.receive_text())
                    if "final" in data:
                        finals.append(data)
                        break
    assert finals[0]["voiceprint"] == [0.6, 0.8]
    assert "voiceprint" not in finals[1]


@pytest.mark.model
def test_voiceprint_model_separates_voices():
    """Two Kokoro voices: the same voice is closer to itself than to the other."""
    import soxr

    from tts.base import TTSConfig
    from tts.kokoro import KokoroEngine
    import paths

    engine = KokoroEngine(TTSConfig(engine="kokoro", model="v1.0", voice="im_nicola"), str(paths.models_dir()))
    engine.load()

    def say(text, voice):
        audio, rate = engine.kokoro.create(text, voice=voice, speed=1.0, lang="it")
        return np.array(voiceprint.embed(soxr.resample(audio, rate, 16000)))

    a1 = say("Ciao, stasera giochiamo ancora sul server?", "im_nicola")
    a2 = say("Secondo me il problema è nella configurazione.", "im_nicola")
    b1 = say("Secondo me il problema è nella configurazione.", "if_sara")
    assert len(a1) == 256
    assert a1 @ a2 > 0.55
    assert a1 @ b1 < 0.4
