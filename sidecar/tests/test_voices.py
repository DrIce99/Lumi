from pathlib import Path

import soundfile as sf

from tts.base import BUNDLED_VOICES, TTSConfig, bundled_voice
from tts.qwen3 import clip_path


def test_bundled_clips_exist_and_fit_cloning():
    for name in BUNDLED_VOICES:
        info = sf.info(bundled_voice(name))
        assert info.channels == 1
        assert 10 <= info.duration <= 20


def test_bundled_voice_names():
    assert bundled_voice("Italiana").endswith("italiana.flac")
    assert bundled_voice("ryan") is None
    assert bundled_voice("") is None


def test_base_clip_defaults_to_the_italian_voice():
    assert Path(clip_path("")).name == "italiana.flac"
    assert Path(clip_path("italiano")).name == "italiano.flac"
    assert clip_path(r"C:\voci\mia.wav") == r"C:\voci\mia.wav"


def test_default_config_is_the_italian_clone():
    config = TTSConfig()
    assert (config.engine, config.model, config.voice) == ("qwen3", "1.7B-Base", "")


def test_trained_model_is_found_in_the_lora_folder(tmp_path):
    import json

    import pytest

    from tts.base import EngineUnavailable
    from tts.qwen3 import Qwen3Engine

    engine = Qwen3Engine(TTSConfig(model="1.7B-Italiano"), str(tmp_path))
    with pytest.raises(EngineUnavailable):
        engine._trained("italiano")
    folder = tmp_path / "lora" / "italiano" / "model"
    folder.mkdir(parents=True)
    (folder / "config.json").write_text(json.dumps({"lumi_finetune": {"speaker": "lettrice"}}), encoding="utf8")
    assert engine._trained("italiano") == str(folder)
    assert (engine.kind, engine.speakers) == ("trained", ["lettrice"])
