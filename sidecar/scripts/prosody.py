"""Acoustic measures for the accent test (scripts/accenti.py): which syllable
of a word is stressed and how open its vowel is. Pure numpy/scipy on a
mono float signal and syllable time spans (from a forced alignment), so
they can be checked on synthetic audio.

- Stress: each syllable gets a prominence from its duration, energy and
  pitch (z-scores within the word: Italian stress makes the syllable
  longer, louder and usually higher). The stressed syllable is the most
  prominent one.
- Openness: F1 of a vowel, from LPC roots. Open è/ò have a higher F1 than
  closed é/ó of the same speaker; only the difference between two
  readings of the same word by the same voice is meaningful.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import butter, lfilter, resample_poly, sosfiltfilt


@dataclass
class Syllable:
    start: float  # seconds
    end: float
    energy: float = 0.0  # peak voiced-band energy, dB
    pitch: float = 0.0  # highest F0 inside, Hz (0 when unvoiced)
    score: float = 0.0  # prominence within the word

    @property
    def duration(self) -> float:
        return self.end - self.start


def band_energy(audio: np.ndarray, rate: int, start: float, end: float) -> float:
    """Peak energy (dB) of the voiced band (300-3000 Hz) in 20 ms frames between start and end."""
    a, b = int(start * rate), int(end * rate)
    segment = audio[a:b].astype(np.float64)
    if len(segment) < rate // 50:
        return -100.0
    sos = butter(4, [300, 3000], btype="band", fs=rate, output="sos")
    band = sosfiltfilt(sos, segment) if len(segment) > 30 else segment
    hop = rate // 50
    frames = len(band) // hop
    power = (band[: frames * hop].reshape(frames, hop) ** 2).mean(axis=1)
    return float(10 * np.log10(power.max() + 1e-10))


def pitch_at(audio: np.ndarray, rate: int, t: float, window: float = 0.04) -> float:
    """F0 by autocorrelation around t (75-500 Hz), 0 when the frame isn't periodic."""
    half = int(rate * window / 2)
    c = int(t * rate)
    frame = audio[max(0, c - half) : c + half].astype(np.float64)
    if len(frame) < half:
        return 0.0
    frame = frame - frame.mean()
    ac = np.correlate(frame, frame, mode="full")[len(frame) - 1 :]
    if ac[0] <= 0:
        return 0.0
    lo, hi = int(rate / 500), min(int(rate / 75), len(ac) - 1)
    if hi <= lo:
        return 0.0
    lag = lo + int(np.argmax(ac[lo:hi]))
    return rate / lag if ac[lag] / ac[0] > 0.4 else 0.0


def max_pitch(audio: np.ndarray, rate: int, start: float, end: float) -> float:
    values = [pitch_at(audio, rate, float(t)) for t in np.arange(start + 0.01, end - 0.01, 0.01)]
    voiced = [v for v in values if v > 0]
    # The upper quartile, not the max: one octave error would decide alone
    return float(np.percentile(voiced, 75)) if voiced else 0.0


def _z(values: list[float]) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    sd = v.std()
    return (v - v.mean()) / sd if sd > 1e-9 else np.zeros_like(v)


def syllables(audio: np.ndarray, rate: int, spans: list[tuple[float, float]]) -> list[Syllable]:
    """Measures each syllable span and scores its prominence:
    z(duration) + z(energy) + z(pitch), pitch left out when a syllable is unvoiced."""
    out = [Syllable(s, e, band_energy(audio, rate, s, e), max_pitch(audio, rate, s, e)) for s, e in spans]
    if not out:
        return out
    total = _z([s.duration for s in out]) + _z([s.energy for s in out])
    if all(s.pitch > 0 for s in out):
        total = total + _z([s.pitch for s in out])
    for s, value in zip(out, total):
        s.score = float(value)
    return out


def stressed(found: list[Syllable]) -> int | None:
    return int(np.argmax([s.score for s in found])) if found else None


def f1_at(audio: np.ndarray, rate: int, t: float, window: float = 0.03) -> float:
    """First formant around t, from the roots of a 10 kHz LPC fit (0 when none is found)."""
    target = 10000
    half_in = int(rate * (window / 2 + 0.01))
    c_in = int(t * rate)
    a = max(0, c_in - half_in)
    piece = audio[a : c_in + half_in].astype(np.float64)
    x = resample_poly(piece, target, rate) if rate != target else piece
    half = int(target * window / 2)
    c = int((t - a / rate) * target)
    frame = x[max(0, c - half) : c + half]
    if len(frame) < half:
        return 0.0
    frame = lfilter([1, -0.63], [1], frame) * np.hamming(len(frame))
    lpc = _lpc(frame, 12)
    if lpc is None:
        return 0.0
    found = []
    for r in np.roots(lpc):
        if np.imag(r) <= 0:
            continue
        freq = np.angle(r) * target / (2 * np.pi)
        bandwidth = -np.log(abs(r)) * target / np.pi
        if 200 < freq < 1200 and bandwidth < 400:
            found.append(freq)
    return float(min(found)) if found else 0.0


def _lpc(frame: np.ndarray, order: int) -> np.ndarray | None:
    """Autocorrelation LPC by Levinson-Durbin."""
    r = np.correlate(frame, frame, mode="full")[len(frame) - 1 : len(frame) + order]
    if r[0] <= 0:
        return None
    a = np.zeros(order + 1)
    a[0] = 1.0
    err = r[0]
    for i in range(1, order + 1):
        k = -(r[i] + np.dot(a[1:i], r[i - 1 : 0 : -1])) / err
        a[1:i] = a[1:i] + k * a[i - 1 : 0 : -1]
        a[i] = k
        err *= 1 - k * k
        if err <= 0:
            return None
    return a


def peak_time(audio: np.ndarray, rate: int, start: float, end: float) -> float:
    """Where the voiced band is loudest between start and end: the vowel of a syllable."""
    a, b = int(start * rate), int(end * rate)
    segment = audio[a:b].astype(np.float64)
    hop = rate // 100
    if len(segment) < 4 * hop:
        return (start + end) / 2
    sos = butter(4, [300, 3000], btype="band", fs=rate, output="sos")
    band = sosfiltfilt(sos, segment)
    frames = len(band) // hop
    power = np.convolve((band[: frames * hop].reshape(frames, hop) ** 2).mean(axis=1), np.ones(3) / 3, mode="same")
    return start + (int(np.argmax(power)) + 0.5) * hop / rate


def vowel_f1(audio: np.ndarray, rate: int, start: float, end: float) -> float:
    """Median F1 around the loudest moment of a syllable (the vowel's steady part)."""
    peak = peak_time(audio, rate, start, end)
    times = np.clip(np.linspace(peak - 0.025, peak + 0.025, 5), start, end)
    values = [f for f in (f1_at(audio, rate, float(t)) for t in times) if f > 0]
    return float(np.median(values)) if values else 0.0
