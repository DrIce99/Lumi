"""Emotion -> engine parameters (tts/emotions.json).

The model picks an emotion and an intensity (0-1) for every sentence; each
engine gets them in its own terms: a style instruction for Qwen3-TTS, the
`exaggeration` parameter for Chatterbox, a speed nudge for Kokoro.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DEFAULT = "neutra"


@lru_cache(maxsize=1)
def table() -> dict[str, dict]:
    return json.loads((Path(__file__).with_name("emotions.json")).read_text(encoding="utf-8"))


def entry(emotion: str) -> dict:
    return table().get(emotion) or table()[DEFAULT]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def qwen_instruct(emotion: str, intensity: float, speed: float = 1.0) -> str:
    """A style instruction: the intensity says "leggermente" or "molto", the speed adds a pace hint."""
    base = entry(emotion)["qwen_instruct"]
    intensity = clamp(intensity, 0.0, 1.0)
    if emotion != DEFAULT:
        if intensity < 0.35:
            base = f"{base}, ma solo leggermente"
        elif intensity > 0.75:
            base = f"{base}, in modo molto marcato"
    if speed >= 1.12:
        base += ", a ritmo un po' più veloce"
    elif speed <= 0.88:
        base += ", con calma e più lentamente"
    return base + "."


def chatterbox_exaggeration(emotion: str, intensity: float) -> float:
    """0.5 is neutral; the intensity scales how far the emotion moves away from it."""
    base = float(entry(emotion)["chatterbox_exaggeration"])
    k = 0.5 + clamp(intensity, 0.0, 1.0)
    return round(clamp(0.5 + (base - 0.5) * k, 0.25, 1.0), 3)


def speed_factor(emotion: str, intensity: float) -> float:
    """Engines without emotional control only get a slightly different pace."""
    base = float(entry(emotion).get("speed", 1.0))
    k = 0.5 + clamp(intensity, 0.0, 1.0)
    return round(1.0 + (base - 1.0) * k, 3)
