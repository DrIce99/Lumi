"""The interface every speech recognition engine implements.

Input: PCM 16 kHz mono (float32 -1..1 once decoded). Output: the text and,
for final results, the words with their times.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np

SAMPLE_RATE = 16_000


@dataclass
class STTConfig:
    engine: str = "faster-whisper"
    model: str = "large-v3-turbo"
    device: str = "auto"
    language: str = "it"

    def key(self) -> tuple:
        return (self.engine, self.model, self.device)


@dataclass
class Word:
    word: str
    start: float
    end: float
    probability: float = 1.0


@dataclass
class Transcript:
    text: str
    words: list[Word] = field(default_factory=list)


class STTEngine(ABC):
    name = "base"

    def __init__(self, config: STTConfig, models_dir: str):
        self.config = config
        self.models_dir = models_dir
        self.device = "cpu"

    @abstractmethod
    def load(self) -> None: ...

    def unload(self) -> None:
        """Frees memory (and VRAM)."""

    @abstractmethod
    def transcribe(self, audio: np.ndarray, vocabulary: list[str], partial: bool) -> Transcript:
        """`partial`: a quick look at an utterance still in progress (greedy, no word times)."""

    @property
    def fast(self) -> bool:
        """Fast enough to transcribe partial results while the user speaks."""
        return self.device == "cuda"


def pcm16_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


# Phrases Whisper invents on silence or noise (subtitle credits, video endings)
HALLUCINATIONS = [
    r"sottotitoli (creati|a cura|e revisione)",
    r"amara\.org",
    r"grazie (a tutti )?per (la visione|l'ascolto|l'attenzione|aver guardato)",
    r"^\W*grazie (a tutti|mille)\W*$",
    r"iscriviti al canale",
    r"ci vediamo (al|nel) prossimo",
    r"^\W*(alla prossima|buona visione)\W*$",
    r"^\W*[\[(]?(musica|applausi|risate)[\])]?\W*$",
    r"qtss",
    r"^\W*(grazie|ciao)\W*$",
    r"^\W*(\.\.\.|…)\W*$",
]
_HALLUCINATION = re.compile("|".join(HALLUCINATIONS), re.IGNORECASE)

# Below this loudness (RMS) the audio is silence: nothing to transcribe
SILENCE_RMS = 0.0025


def is_silence(audio: np.ndarray) -> bool:
    return audio.size == 0 or float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) < SILENCE_RMS


def clean_transcript(text: str, audio_seconds: float) -> str:
    """Drops typical hallucinations; a lone "grazie" is kept only when there was enough audio for it."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if _HALLUCINATION.search(text) and not (audio_seconds > 0.6 and re.fullmatch(r"\W*(grazie|ciao)\W*", text, re.IGNORECASE)):
        return ""
    return text


def vocabulary_prompt(vocabulary: list[str]) -> str | None:
    """Whisper's initial_prompt: spelling hints for names and technical terms."""
    words = [w.strip() for w in vocabulary if w.strip()]
    return ("Glossario: " + ", ".join(words[:60]) + ".") if words else None
