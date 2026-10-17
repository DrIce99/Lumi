"""Listening test for Italian pronunciation: the trap sentences
(text/trappole_it.txt) read by several engines and voices, through a
running sidecar, exactly as the app sends them (normalization and lexicon
included).

    uv run python server.py --port 8765 --dev          # in one terminal
    uv run python scripts/pronuncia.py --voices qwen3:1.7B-CustomVoice:ryan,kokoro:v1.0:if_sara --asr

`--voices` is a comma-separated list of engine:model:voice (for Qwen3 Base
and Chatterbox the voice is the path of the reference clip). The WAV files
go to `--out/<variant>/NN.wav`. With `--asr` each sentence is transcribed
back by the sidecar's speech recognizer and compared with the text: a low
score points at the sentences to listen to first (it catches wrong words,
not every wrong accent). `--accent` adds how sure Whisper's language
identification is that the sentence is Italian (local faster-whisper on
the CPU): a foreign accent lowers it even when every word is right.
`--lexicon` adds "parola = pronuncia" lines, like
the settings' Pronuncia field.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import difflib
import os
import re
import sys
import unicodedata
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke import http, listen, speak, wait_ready  # noqa: E402
from text.normalize_it import normalize  # noqa: E402

TRAPS = Path(__file__).resolve().parent.parent / "text" / "trappole_it.txt"


def read_traps(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in path.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        text, _, note = line.partition(" | ")
        out.append((text.strip(), note.strip()))
    return out


def letters(text: str) -> str:
    """Lowercase letters only: written accents (àncora) and word breaks ("chi sa" / "chissà")
    are the recognizer's spelling, not the voice's pronunciation."""
    text = "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", text)


def score(expected: str, heard: str) -> float:
    """Letter similarity 0..1 between what should be said and what was heard."""
    return difflib.SequenceMatcher(a=letters(expected), b=letters(heard), autojunk=False).ratio()


def save_wav(path: Path, pcm: bytes, rate: int = 24000) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def italian(model, pcm: bytes) -> float:
    """Probability that Whisper's language identification gives to Italian."""
    import soxr

    audio = soxr.resample(np.frombuffer(pcm, "<i2").astype(np.float32) / 32768, 24000, 16000)
    _lang, _p, probs = model.detect_language(audio)
    return dict(probs).get("it", 0.0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=os.environ.get("LUMI_SIDECAR_URL", "http://127.0.0.1:8765"))
    parser.add_argument("--token", default=os.environ.get("LUMI_SIDECAR_TOKEN", ""))
    parser.add_argument("--voices", default="qwen3:1.7B-CustomVoice:ryan", help="engine:model:voice, comma-separated")
    parser.add_argument("--sentences", default=str(TRAPS))
    parser.add_argument("--lexicon", default="", help='file with "parola = pronuncia" lines')
    parser.add_argument("--emotion", default="neutra")
    parser.add_argument("--asr", action="store_true", help="transcribe back and score each sentence")
    parser.add_argument("--stt", default="faster-whisper")
    parser.add_argument("--stt-device", default="auto", help="cpu leaves the VRAM to the voice (e.g. while Lumi runs)")
    parser.add_argument("--accent", action="store_true", help="score how Italian each sentence sounds (Whisper language id)")
    parser.add_argument("--out", default="pronuncia")
    args = parser.parse_args()
    url, token = args.url.rstrip("/"), args.token
    ws = url.replace("http", "ws", 1)
    traps = read_traps(Path(args.sentences))
    lexicon = [line for line in Path(args.lexicon).read_text(encoding="utf8").splitlines() if "=" in line] if args.lexicon else []
    rows: list[dict] = []
    lang_id = None
    if args.accent:
        from faster_whisper import WhisperModel

        from paths import models_dir

        lang_id = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", download_root=str(models_dir() / "whisper"))

    for variant in [v.strip() for v in args.voices.split(",") if v.strip()]:
        engine, model, voice = (variant.split(":", 2) + ["", ""])[:3]
        name = re.sub(r"[^\w.-]+", "_", f"{engine}_{model}_{Path(voice).stem if voice else 'default'}")
        folder = Path(args.out) / name
        folder.mkdir(parents=True, exist_ok=True)
        config = {"tts": {"engine": engine, "model": model, "voice": voice, "lexicon": lexicon}, "preload": True}
        kinds = {"tts"}
        if args.asr:
            config["stt"] = {"engine": args.stt, "device": args.stt_device}
            kinds.add("stt")
        http(url, token, "/config", config)
        print(f"\n== {variant}: loading...")
        wait_ready(url, token, kinds, timeout=1800)
        for i, (text, note) in enumerate(traps, 1):
            pcm, first, total = asyncio.run(speak(f"{ws}/tts?token={token}", text, args.emotion))
            file = folder / f"{i:02d}.wav"
            save_wav(file, pcm)
            row = {"variant": variant, "n": i, "text": text, "listen_for": note, "file": str(file), "first_ms": round(first * 1000)}
            if lang_id is not None:
                row["italian"] = round(italian(lang_id, pcm), 3)
            if args.asr:
                import soxr

                pcm16k = (np.clip(soxr.resample(np.frombuffer(pcm, "<i2").astype(np.float32) / 32768, 24000, 16000), -1, 1) * 32767).astype("<i2").tobytes()
                final, _partials, _after = asyncio.run(listen(f"{ws}/stt?token={token}", pcm16k))
                heard = final.get("final", "")
                # Compare with what the voice was asked to say (numbers already in words)
                row["heard"] = heard
                row["score"] = round(score(normalize(text), normalize(heard)), 2)
            rows.append(row)
            print(f"{i:02d} {row.get('score', ''):>5} {row.get('italian', ''):>5} {text}")

    report = Path(args.out) / "report.csv"
    with report.open("w", newline="", encoding="utf8") as f:
        writer = csv.DictWriter(f, fieldnames=list(dict.fromkeys(k for r in rows for k in r)))
        writer.writeheader()
        writer.writerows(rows)
    if args.asr:
        print("\nTo listen to first (lowest scores):")
        for r in sorted(rows, key=lambda r: r["score"])[:8]:
            print(f"  {r['score']:.2f} {r['variant']} #{r['n']:02d}: heard {r['heard']!r} - {r['listen_for']}")
    print(f"\nWAV files in {args.out}, report in {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
