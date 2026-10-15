"""Pronunciation lexicon: words the voice gets wrong, respelled as they sound.

The text-based engines (Qwen3-TTS, Chatterbox) read text tokens, not
phonemes: IPA would be read as symbols. What works for every engine is
respelling a word in plain Italian letters ("VS Code" -> "vi es code").
The user's entries (settings, `tts.lexicon`) apply to every engine.
Kokoro also gets ESPEAK_LOANWORDS: it phonemizes with espeak-ng in
Italian, which reads English loanwords letter by letter ("mouse" ->
"mo-u-se"), while the other engines already know them. Pure: no I/O.
"""

from __future__ import annotations

import re
from functools import lru_cache

# English words common in a desk assistant's talk, as an Italian reads them aloud.
# "file" alone is also the plural of "fila": only the computer sense, by its article.
ESPEAK_LOANWORDS: dict[str, str] = {
    "il file": "il fail",
    "un file": "un fail",
    "i file": "i fail",
    "del file": "del fail",
    "dei file": "dei fail",
    "nel file": "nel fail",
    "questo file": "questo fail",
    "quel file": "quel fail",
    "mouse": "maus",
    "download": "daunlod",
    "upload": "aplod",
    "browser": "brauser",
    "computer": "compiuter",
    "software": "softuer",
    "hardware": "arduer",
    "online": "onlain",
    "offline": "oflain",
    "email": "imeil",
    "e-mail": "imeil",
    "chat": "ciat",
    "web": "ueb",
    "Windows": "uindous",
    "YouTube": "iutiub",
    "Google": "gugol",
    "WhatsApp": "uotsap",
    "Spotify": "spotifai",
    "Steam": "stim",
    "iPhone": "aifon",
    "Wi-Fi": "uaifai",
    "password": "pasuord",
    "smartphone": "smartfon",
    "playlist": "pleilist",
    "meeting": "miting",
    "team": "tim",
    "weekend": "uichend",
    "feedback": "fidbec",
    "update": "apdeit",
    "router": "ruter",
    "cloud": "claud",
    "bug": "bag",
    "debug": "dibag",
    "streaming": "striming",
    "screenshot": "scrinsciot",
}

#: Engines that phonemize Italian with espeak-ng.
ESPEAK_ENGINES = {"kokoro"}


def parse_entries(lines: list[str]) -> list[tuple[str, str]]:
    """Lexicon entries from "parola = pronuncia" lines; malformed lines are skipped."""
    out: list[tuple[str, str]] = []
    for line in lines:
        if "=" not in line:
            continue
        word, _, say = line.partition("=")
        word, say = " ".join(word.split()), " ".join(say.split())
        if word and say and len(word) <= 80 and len(say) <= 120:
            out.append((word, say))
    return out


def lexicon_for(config) -> tuple[tuple[str, str], ...]:
    """The entries for a TTS configuration: the user's first (they win), then the engine's defaults."""
    if config is None:
        return ()
    entries: list[tuple[str, str]] = []
    for item in getattr(config, "lexicon", None) or []:
        if isinstance(item, (list, tuple)) and len(item) == 2 and all(isinstance(x, str) for x in item):
            entries.append((item[0], item[1]))
        elif isinstance(item, str):
            entries.extend(parse_entries([item]))
    if getattr(config, "engine", "") in ESPEAK_ENGINES:
        entries.extend(ESPEAK_LOANWORDS.items())
    return tuple(entries)


def _key(text: str) -> str:
    return " ".join(text.split()).lower()


@lru_cache(maxsize=16)
def _compile(entries: tuple[tuple[str, str], ...]) -> tuple[re.Pattern[str], dict[str, str]] | None:
    table: dict[str, str] = {}
    for word, say in entries:
        table.setdefault(_key(word), say)
    if not table:
        return None
    # Longest first, so "il file" wins over "file"; spaces match any whitespace
    words = sorted(table, key=len, reverse=True)
    alternation = "|".join(re.escape(w).replace(r"\ ", r"\s+") for w in words)
    return re.compile(rf"(?<![\w-])(?:{alternation})(?![\w-])", re.IGNORECASE), table


def apply_lexicon(text: str, entries: tuple[tuple[str, str], ...]) -> str:
    """Replaces whole words and phrases (case-insensitive) with their pronunciation."""
    compiled = _compile(entries) if entries else None
    if not compiled:
        return text
    pattern, table = compiled

    def replace(match: re.Match[str]) -> str:
        found = match.group(0)
        say = table[_key(found)]
        # Keep a capital at the start of a sentence (not for "VS Code" in the middle of one)
        before = text[: match.start()].rstrip()
        if found[:1].isupper() and say[:1].islower() and (not before or before[-1] in ".!?"):
            say = say[:1].upper() + say[1:]
        return say

    return pattern.sub(replace, text)
