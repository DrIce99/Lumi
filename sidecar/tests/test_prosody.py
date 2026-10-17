import sys
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from prosody import f1_at, stressed, syllables, vowel_f1  # noqa: E402

RATE = 24000


def vowel(seconds: float, f1: float, f2: float = 1500, f0: float = 120, gain: float = 1.0) -> np.ndarray:
    """Impulse train through two formant resonators: a crude but real vowel."""
    n = int(seconds * RATE)
    source = np.zeros(n)
    source[:: int(RATE / f0)] = 1.0
    out = source
    for f, bw in ((f1, 80), (f2, 120)):
        r = np.exp(-np.pi * bw / RATE)
        theta = 2 * np.pi * f / RATE
        out = lfilter([1 - r], [1, -2 * r * np.cos(theta), r * r], out)
    ramp = np.minimum(1, np.minimum(np.arange(n), np.arange(n)[::-1]) / (0.015 * RATE))
    return out / np.abs(out).max() * gain * 0.5 * ramp


def gap(seconds: float = 0.05) -> np.ndarray:
    return np.random.default_rng(1).normal(0, 0.002, int(seconds * RATE))


def word(stress: int) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """Three consonant+vowel syllables, the stressed one longer, louder and higher."""
    parts, spans, t = [], [], 0.0
    for i in range(3):
        long = i == stress
        v = vowel(0.16 if long else 0.08, 700, f0=150 if long else 120, gain=1.0 if long else 0.5)
        g = gap()
        spans.append((t, t + (len(g) + len(v)) / RATE))
        t = spans[-1][1]
        parts += [g, v]
    return np.concatenate(parts), spans


def test_stressed_syllable_is_the_longest_loudest_and_highest():
    for s in range(3):
        audio, spans = word(s)
        found = syllables(audio, RATE, spans)
        assert len(found) == 3
        assert stressed(found) == s
        assert found[s].pitch > 140


def test_f1_tells_open_from_closed():
    open_e, closed_e = vowel(0.2, 600, 1800), vowel(0.2, 400, 2100)
    f_open, f_closed = f1_at(open_e, RATE, 0.1), f1_at(closed_e, RATE, 0.1)
    assert abs(f_open - 600) < 80
    assert abs(f_closed - 400) < 80
    audio = np.concatenate([gap(), open_e, gap()])
    assert vowel_f1(audio, RATE, 0.05, 0.25) > f_closed + 100


def test_no_syllables_no_stress():
    assert stressed(syllables(np.zeros(RATE // 2), RATE, [])) is None


def test_accent_pairs_are_consistent():
    from accenti import PAIRS, plain, read_pairs

    pairs = read_pairs(PAIRS)
    assert len(pairs) >= 30
    for item in pairs:
        assert len(item["variants"]) == 2
        for spelling, expected in item["variants"].items():
            if item["kind"].endswith("ctx"):
                assert spelling.count("{}") == 1, spelling
            else:
                assert plain(spelling) == item["word"], spelling
                assert spelling != item["word"], "a variant must carry an accent"
            if item["kind"].startswith("stress"):
                assert 0 <= expected < len(item["parts"])
            else:
                assert expected in ("open", "closed")
        if item["kind"].startswith("vowel"):
            assert sorted(item["variants"].values()) == ["closed", "open"]
