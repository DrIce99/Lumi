"""Real engines with real models: `uv run pytest -m model -s`.

Downloads the models (several GB the first time) into the models folder
(LUMI_MODELS_DIR, or %APPDATA%\\Lumi\\models when run by hand). Speech
synthesis is checked by transcribing it back with Whisper.
"""

import os
import re
import time
from pathlib import Path

import numpy as np
import pytest

import paths
from stt.base import STTConfig
from tts.base import SAMPLE_RATE, TTSConfig

pytestmark = pytest.mark.model

if os.environ.get("LUMI_MODELS_DIR", "").startswith(os.environ.get("TEMP", "~~")):
    # conftest points tests to a temp folder; real model tests reuse the user's models
    os.environ["LUMI_MODELS_DIR"] = str(paths.default_models_dir())
paths._models_dir = None
paths.configure(os.environ["LUMI_MODELS_DIR"])

SENTENCE = "Ciao! Sono Lumi, e oggi ti aiuto volentieri."
OUT = Path(os.environ.get("LUMI_TEST_AUDIO", str(Path(__file__).parent / "_audio")))


def words(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


def pcm_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def save(name: str, audio: np.ndarray, rate: int) -> None:
    import soundfile as sf

    OUT.mkdir(exist_ok=True)
    sf.write(OUT / name, audio, rate)


@pytest.fixture(scope="module")
def whisper():
    from stt.faster_whisper import FasterWhisperEngine

    engine = FasterWhisperEngine(STTConfig(model="large-v3-turbo"), str(paths.models_dir()))
    engine.load()
    yield engine
    engine.unload()


def roundtrip(whisper, pcm: bytes, rate: int = SAMPLE_RATE) -> str:
    import soxr

    audio = soxr.resample(pcm_to_float(pcm), rate, 16000)
    return whisper.transcribe(audio, ["Lumi"], partial=False).text


def synth(engine, text, emotion="gioia", intensity=0.7):
    started = time.monotonic()
    first = None
    chunks = []
    for chunk in engine.stream(text, emotion, intensity, engine.config.voice):
        if first is None:
            first = time.monotonic() - started
        chunks.append(chunk)
    total = time.monotonic() - started
    pcm = b"".join(chunks)
    seconds = len(pcm) / 2 / SAMPLE_RATE
    return pcm, first, total, seconds


def test_whisper_transcribes_italian(whisper):
    assert whisper.device == "cuda"
    silence = np.zeros(16000, dtype=np.float32)
    assert whisper.transcribe(silence, [], partial=False).text == ""


def test_kokoro(whisper):
    from tts.kokoro import KokoroEngine

    engine = KokoroEngine(TTSConfig(engine="kokoro", model="v1.0", voice="im_nicola"), str(paths.models_dir()))
    engine.load()
    pcm, first, total, seconds = synth(engine, SENTENCE, "neutra")
    save("kokoro.wav", pcm_to_float(pcm), SAMPLE_RATE)
    heard = roundtrip(whisper, pcm)
    print(f"\nKokoro: {seconds:.1f} s of audio in {total:.2f} s (first chunk {first:.2f} s): {heard!r}")
    assert seconds > 1.0
    assert {"ciao", "lumi"} & words(heard)


def test_qwen3_custom_voice_streams_fast(whisper):
    from tts.qwen3 import Qwen3Engine

    engine = Qwen3Engine(TTSConfig(engine="qwen3", model="1.7B-CustomVoice", voice="ryan", seed=7), str(paths.models_dir()))
    started = time.monotonic()
    engine.load()
    print(f"\nQwen3-TTS 1.7B loaded in {time.monotonic() - started:.1f} s; speakers: {engine.voices()}")
    for emotion in ("neutra", "gioia", "tristezza"):
        pcm, first, total, seconds = synth(engine, SENTENCE, emotion)
        save(f"qwen3_{emotion}.wav", pcm_to_float(pcm), SAMPLE_RATE)
        heard = roundtrip(whisper, pcm)
        print(f"Qwen3 {emotion}: {seconds:.1f} s of audio in {total:.2f} s (RTF {seconds / total:.2f}x, first chunk {first:.2f} s): {heard!r}")
        assert seconds > 1.0
        assert first < 1.5, "the first chunk must come quickly"
        assert {"ciao", "lumi", "aiuto"} & words(heard), heard
        # The style instruction must never be read out loud
        assert "parla" not in words(heard)
    engine.unload()


def test_chatterbox_multilingual(whisper):
    import importlib.util

    if importlib.util.find_spec("chatterbox") is None:
        pytest.skip("chatterbox extra not installed")
    from tts.chatterbox import ChatterboxEngine

    engine = ChatterboxEngine(TTSConfig(engine="chatterbox", model="multilingual", voice="", seed=7), str(paths.models_dir()))
    started = time.monotonic()
    engine.load()
    print(f"\nChatterbox loaded in {time.monotonic() - started:.1f} s on {engine.device}")
    pcm, first, total, seconds = synth(engine, SENTENCE, "gioia", 0.8)
    save("chatterbox_gioia.wav", pcm_to_float(pcm), SAMPLE_RATE)
    heard = roundtrip(whisper, pcm)
    print(f"Chatterbox: {seconds:.1f} s of audio in {total:.2f} s: {heard!r}")
    assert seconds > 1.0
    assert {"ciao", "lumi", "aiuto"} & words(heard), heard
    engine.unload()


def test_smart_turn_runs_quickly():
    from turn.smart_turn import SmartTurn

    turn = SmartTurn()
    turn.load()
    rng = np.random.default_rng(0)
    speech_like = (np.sin(2 * np.pi * 180 * np.arange(32000) / 16000) * rng.uniform(0.2, 0.5, 32000)).astype(np.float32)
    started = time.monotonic()
    p = turn.probability(speech_like)
    ms = (time.monotonic() - started) * 1000
    print(f"\nSmart Turn: p={p:.3f} in {ms:.0f} ms")
    assert 0.0 <= p <= 1.0
    assert ms < 500


def test_windows_ocr_reads_rendered_text():
    from PIL import Image, ImageDraw, ImageFont

    from ocr.engines import OCRConfig, make_ocr

    image = Image.new("RGB", (640, 80), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("segoeui.ttf", 32)
    except OSError:
        font = ImageFont.load_default()
    draw.text((10, 18), "Errore alla riga 42: file non trovato", fill="black", font=font)
    engine = make_ocr(OCRConfig(engine="windows"))
    engine.load()
    lines = engine.recognize(image, "it")
    text = " ".join(line.text for line in lines)
    print(f"\nOCR ({engine.name}): {text!r}")
    assert "Errore" in text and "42" in text
    assert lines[0].rect.x < 30 and lines[0].words
