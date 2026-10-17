"""Pure helpers for the LoRA dataset (roadmap 17.5): which stretches of an
audiobook become training clips and how their text is cleaned.

The audio is split at its pauses (>= 0.25 s of silence, found in the
signal: Whisper's word timestamps leave no gaps), Whisper's words go to
the stretch of speech they end in, and stretches are merged into clips
of 3-15 s whose audio starts and stops inside the pauses. Cutting at
Whisper's segment ends instead left the start of the next word in a
quarter of the clips: the model learned to say a word past the end of
the text. LibriVox's spoken preamble ("Questa è una registrazione
LibriVox...", "Registrato da...", chapter titles) and anything that looks
like a hallucination is left out.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

MIN_SECONDS = 3.0
MAX_SECONDS = 15.0
# Silence that makes a clean cut
PAUSE = 0.25
# Audio kept around a clip's words, at most half of the pause on each side
LEAD = 0.05
TAIL = 0.12

SKIP = re.compile(
    r"librivox|pubblico dominio|registrat[oa] da|per maggiori informazioni|volontari|fine (del )?capitolo|"
    r"^\s*capitol[oi]\b|sottotitoli|grazie a tutti|amara\.org",
    re.IGNORECASE,
)


@dataclass
class Word:
    start: float
    end: float
    text: str
    probability: float = 1.0
    # Whisper's no-speech probability of the segment the word came from
    no_speech_prob: float = 0.0


@dataclass
class Segment:
    start: float
    end: float
    text: str
    # Whisper's confidence: mean log-probability of the words, and no-speech probability
    avg_logprob: float = 0.0
    no_speech_prob: float = 0.0
    # Silence before the first word and after the last one (inf at the edges of the audio)
    before: float = math.inf
    after: float = math.inf


@dataclass
class Clip:
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return self.end - self.start


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace("’", "'").replace("«", '"').replace("»", '"')
    return text


def silences(audio, rate: int, min_pause: float = PAUSE, below_db: float = 35.0) -> list[tuple[float, float]]:
    """Stretches of at least `min_pause` s quieter than the loud speech by `below_db` dB.

    Whisper's word timestamps can't find pauses (each word runs into the
    next), so they come from the audio: 10 ms frames, threshold relative to
    the 95th percentile of the frame energy."""
    import numpy as np

    hop = rate // 100
    frames = len(audio) // hop
    if frames == 0:
        return []
    power = (np.asarray(audio[: frames * hop], dtype=np.float64).reshape(frames, hop) ** 2).mean(axis=1)
    db = 10 * np.log10(power + 1e-12)
    quiet = db < np.percentile(db, 95) - below_db
    out, start = [], None
    for i, q in enumerate([*quiet, False]):
        if q and start is None:
            start = i
        elif not q and start is not None:
            if (i - start) / 100 >= min_pause:
                out.append((start / 100, i / 100))
            start = None
    return out


def phrases(words: list[Word], pauses: list[tuple[float, float]], duration: float) -> list[Segment]:
    """Words grouped into the stretches of speech between pauses, by where each word ends:
    Whisper stretches a word's start back into the pause before it, its end is right.
    A phrase spans its speech region, so cutting at its edges never cuts a word."""
    import bisect

    starts = [0.0, *(b for _a, b in pauses)]
    ends = [*(a for a, _b in pauses), duration]
    groups: dict[int, list[Word]] = {}
    for word in words:
        region = bisect.bisect_right(starts, word.end - 0.01) - 1
        groups.setdefault(max(region, 0), []).append(word)
    out = []
    for region, group in sorted(groups.items()):
        before = starts[region] - ends[region - 1] if region > 0 else math.inf
        after = starts[region + 1] - ends[region] if region + 1 < len(starts) else math.inf
        out.append(
            Segment(
                max(starts[region], group[0].start - 0.3) if region == 0 else starts[region],
                ends[region],
                clean_text(" ".join(w.text.strip() for w in group)),
                sum(math.log(max(w.probability, 1e-6)) for w in group) / len(group),
                max(w.no_speech_prob for w in group),
                before=before,
                after=after,
            )
        )
    return out


def usable(segment: Segment) -> bool:
    """A phrase worth training on: real speech, confidently transcribed, not the preamble."""
    text = clean_text(segment.text)
    if len(text) < 2 or SKIP.search(text):
        return False
    if segment.no_speech_prob > 0.5 or segment.avg_logprob < -0.8:
        return False
    # Whisper repeating itself is a hallucination
    words = text.lower().split()
    return not (len(words) >= 6 and len(set(words)) < len(words) / 3)


def plan_clips(segments: list[Segment], min_s: float = MIN_SECONDS, max_s: float = MAX_SECONDS) -> list[Clip]:
    """Merges consecutive usable phrases into clips of min_s..max_s seconds of speech.

    Every phrase boundary is a pause, so a clip may end after any phrase; it
    breaks at an unusable phrase, before a phrase that would make it too long,
    and once it is long enough and the next phrase would take it past 70% of
    the limit. The audio runs a little past the words, never into the next ones.
    """
    clips: list[Clip] = []
    current: list[Segment] = []

    def flush() -> None:
        if current:
            first, last = current[0], current[-1]
            start = first.start - min(LEAD, first.before / 2)
            end = last.end + min(TAIL, last.after / 2)
            if min_s <= last.end - first.start <= max_s:
                clips.append(Clip(start, end, clean_text(" ".join(s.text for s in current))))
        current.clear()

    for seg in segments:
        if not usable(seg) or seg.end - seg.start > max_s:
            flush()
            continue
        if current:
            length = seg.end - current[0].start
            if length > max_s or (current[-1].end - current[0].start >= min_s and length > max_s * 0.7):
                flush()
        current.append(seg)
    flush()
    return clips


def total_hours(clips: list[Clip]) -> float:
    return sum(c.duration for c in clips) / 3600
