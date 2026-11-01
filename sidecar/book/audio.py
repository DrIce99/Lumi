"""Audiobook takes: tidy each piece's audio (trim its edges, shorten stray long
silences, even out the level) and check what the voice said against the text,
so a flawed take can be generated again. Pure numpy, no engine here.
"""

from __future__ import annotations

import difflib
import re
import unicodedata

import numpy as np

from tts.base import SAMPLE_RATE

FRAME_MS = 10
FLOOR_DB = -45.0  # quieter frames count as silence
LEAD_MS = 30  # kept before the first sound
TAIL_MS = 80  # kept after the last one (the decay of the last syllable)
MAX_GAP_MS = 900  # a silence inside a piece longer than this...
GAP_MS = 450  # ...is shortened to this
TARGET_DB = -17.0  # RMS of the voiced frames: about -22 LUFS for the whole book
MAX_GAIN_DB = 9.0
PEAK_DB = -1.0


def _frames(audio: np.ndarray, rate: int) -> tuple[np.ndarray, int]:
    size = rate * FRAME_MS // 1000
    n = len(audio) // size
    frames = audio[: n * size].reshape(n, size) if n else np.zeros((0, size), np.float32)
    return np.sqrt(np.mean(frames**2, axis=1)), size


def tidy(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    """Trims silence at the edges (the book adds its own pauses) and shortens long
    silences inside, which the models sometimes leave mid-sentence. Silence only: b""."""
    audio = np.frombuffer(pcm, "<i2").astype(np.float32) / 32768.0
    rms, size = _frames(audio, rate)
    loud = np.flatnonzero(rms > 10 ** (FLOOR_DB / 20))
    if not loud.size:
        return b""
    start = max(0, loud[0] * size - rate * LEAD_MS // 1000)
    end = min(len(audio), (loud[-1] + 1) * size + rate * TAIL_MS // 1000)
    keep = [(start, end)]
    gaps = np.diff(loud) - 1
    max_gap = MAX_GAP_MS // FRAME_MS
    half = GAP_MS // FRAME_MS // 2
    for i in np.flatnonzero(gaps > max_gap):
        # Silent frames loud[i]+1 .. loud[i+1]-1: keep `half` on each side
        cut_from = (loud[i] + 1 + half) * size
        cut_to = (loud[i + 1] - half) * size
        last_start, _ = keep.pop()
        keep += [(last_start, cut_from), (cut_to, end)]
    out = np.concatenate([audio[a:b] for a, b in keep])
    return (out * 32768.0).clip(-32768, 32767).astype("<i2").tobytes()


def level(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    """Brings the voiced part to TARGET_DB (within +-MAX_GAIN_DB, peaks under PEAK_DB),
    so takes and voices don't jump in loudness from one piece to the next."""
    audio = np.frombuffer(pcm, "<i2").astype(np.float32) / 32768.0
    rms, _ = _frames(audio, rate)
    voiced = rms[rms > 10 ** (FLOOR_DB / 20)]
    if not voiced.size:
        return pcm
    current = 20 * np.log10(np.sqrt(np.mean(voiced**2)))
    gain = float(np.clip(TARGET_DB - current, -MAX_GAIN_DB, MAX_GAIN_DB))
    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        gain = min(gain, PEAK_DB - 20 * np.log10(peak))
    out = audio * 10 ** (gain / 20)
    return (out * 32768.0).clip(-32768, 32767).astype("<i2").tobytes()


def letters(text: str) -> str:
    """Lowercase letters and digits only: accents and word breaks are the recognizer's
    spelling, not the voice's pronunciation (as in scripts/pronuncia.py)."""
    text = "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", text)


def similarity(expected: str, heard: str) -> float:
    return difflib.SequenceMatcher(a=letters(expected), b=letters(heard), autojunk=False).ratio()


def acceptable(expected: str, heard: str, seconds: float) -> tuple[bool, float]:
    """(good enough, score). A take passes with at most ~4% of its letters wrong
    (3 for short pieces: one name misheard by the recognizer is not the voice's fault)
    and no stretch of babbling or silence longer than the text could need."""
    a, b = letters(expected), letters(heard)
    score = difflib.SequenceMatcher(a=a, b=b, autojunk=False).ratio()
    if seconds > 1.5 + 0.16 * len(a):
        return False, score * 0.5
    errors = (1 - score) * (len(a) + len(b)) / 2
    return errors <= max(3.0, 0.04 * len(a)), score
