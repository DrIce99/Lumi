import pytest

from engines import EngineManager
from stt.base import clean_transcript, pcm16_to_float, vocabulary_prompt
from tts.base import EngineUnavailable, TTSConfig, chunked, to_pcm16

from .fakes import FakeTTS, MissingTTS, factories


def test_load_once_and_report_ready(tmp_path):
    FakeTTS.loads = FakeTTS.unloads = 0
    m = EngineManager(str(tmp_path), factories())
    m.configure("tts", TTSConfig(engine="kokoro", model="v1.0"), preload=True)
    m.load_async("tts").result(5)
    m.submit("tts", lambda e: e).result(5)
    assert FakeTTS.loads == 1
    [status] = m.statuses()
    assert status["kind"] == "tts" and status["state"] == "ready" and status["name"] == "kokoro v1.0"
    m.shutdown()


def test_light_changes_keep_the_engine_and_new_engines_replace_it(tmp_path):
    FakeTTS.loads = FakeTTS.unloads = 0
    m = EngineManager(str(tmp_path), factories())
    m.configure("tts", TTSConfig(engine="qwen3", speed=1.0), preload=True)
    m.load_async("tts").result(5)
    m.configure("tts", TTSConfig(engine="qwen3", speed=1.2), preload=True)
    m.load_async("tts").result(5)
    assert FakeTTS.loads == 1
    assert m.engine("tts").config.speed == 1.2
    m.configure("tts", TTSConfig(engine="kokoro"), preload=True)
    m.load_async("tts").result(5)
    assert FakeTTS.loads == 2 and FakeTTS.unloads == 1
    m.shutdown()


def test_missing_engines_are_reported(tmp_path):
    m = EngineManager(str(tmp_path), factories(MissingTTS))
    m.configure("tts", TTSConfig(engine="qwen3"), preload=False)
    with pytest.raises(EngineUnavailable):
        m.load_async("tts").result(5)
    [status] = m.statuses()
    assert status["state"] == "missing" and status["detail"] == "non installato"
    m.disable("tts")
    assert m.statuses() == []
    m.shutdown()


def test_pcm_helpers():
    import numpy as np

    pcm = to_pcm16(np.array([0.0, 0.5, -1.5], dtype=np.float32), 24000)
    assert len(pcm) == 6
    back = pcm16_to_float(pcm)
    assert back[0] == 0 and abs(back[1] - 0.5) < 1e-3 and back[2] < -0.99
    resampled = to_pcm16(np.zeros(48000, dtype=np.float32), 48000)
    assert len(resampled) == 24000 * 2
    assert sum(len(c) for c in chunked(b"\0" * 10000, 24000, 100)) == 10000


def test_whisper_hallucinations_are_dropped():
    assert clean_transcript("Sottotitoli creati dalla comunità Amara.org", 2.0) == ""
    assert clean_transcript(" Grazie per la visione! ", 3.0) == ""
    assert clean_transcript("Grazie.", 0.3) == ""
    assert clean_transcript("Grazie.", 1.0) == "Grazie."
    assert clean_transcript("  apri   il file  ", 1.0) == "apri il file"
    assert vocabulary_prompt([]) is None
    assert vocabulary_prompt(["Sme.UP", " RPG "]) == "Glossario: Sme.UP, RPG."
