import json
from pathlib import Path

from tts.emotions import chatterbox_exaggeration, entry, qwen_instruct, speed_factor

APP_EMOTIONS = ["neutra", "gioia", "tristezza", "sorpresa", "rabbia", "pensiero", "imbarazzo", "sonno"]


def test_every_app_emotion_has_an_entry():
    table = json.loads((Path(__file__).resolve().parents[1] / "tts" / "emotions.json").read_text(encoding="utf-8"))
    assert set(table) == set(APP_EMOTIONS)
    for name, values in table.items():
        assert values["qwen_instruct"].startswith("Parla"), name
        assert 0.25 <= values["chatterbox_exaggeration"] <= 1.0, name


def test_readme_values():
    assert entry("gioia")["qwen_instruct"] == "Parla con tono allegro e vivace"
    assert entry("gioia")["chatterbox_exaggeration"] == 0.7
    assert entry("sconosciuta") == entry("neutra")


def test_intensity_modulates_the_instruction():
    assert qwen_instruct("gioia", 0.6) == "Parla con tono allegro e vivace."
    assert qwen_instruct("gioia", 0.2).endswith("ma solo leggermente.")
    assert qwen_instruct("gioia", 0.9).endswith("in modo molto marcato.")
    assert qwen_instruct("neutra", 0.9) == "Parla in modo naturale e colloquiale."
    assert "più veloce" in qwen_instruct("neutra", 0.5, speed=1.2)
    assert "lentamente" in qwen_instruct("neutra", 0.5, speed=0.8)


def test_intensity_scales_chatterbox_and_speed():
    assert chatterbox_exaggeration("neutra", 1.0) == 0.5
    assert chatterbox_exaggeration("gioia", 0.5) == 0.7
    assert chatterbox_exaggeration("gioia", 1.0) > chatterbox_exaggeration("gioia", 0.0) > 0.5
    assert chatterbox_exaggeration("sonno", 1.0) == 0.25
    assert speed_factor("neutra", 1.0) == 1.0
    assert speed_factor("tristezza", 1.0) < speed_factor("tristezza", 0.0) < 1.0
