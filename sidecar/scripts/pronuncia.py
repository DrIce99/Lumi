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
not every wrong accent). `--lexicon` adds "parola = pronuncia" lines, like
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


def words(text: str) -> list[str]:
    return re.sub(r"[^\w\s]", " ", text.lower()).split()


def score(expected: str, heard: str) -> float:
    """Word similarity 0..1 between what should be said and what was heard."""
    return difflib.SequenceMatcher(a=words(expected), b=words(heard)).ratio()


def save_wav(path: Path, pcm: bytes, rate: int = 24000) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


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
    parser.add_argument("--out", default="pronuncia")
    args = parser.parse_args()
    url, token = args.url.rstrip("/"), args.token
    ws = url.replace("http", "ws", 1)
    traps = read_traps(Path(args.sentences))
    lexicon = [line for line in Path(args.lexicon).read_text(encoding="utf8").splitlines() if "=" in line] if args.lexicon else []
    rows: list[dict] = []

    for variant in [v.strip() for v in args.voices.split(",") if v.strip()]:
        engine, model, voice = (variant.split(":", 2) + ["", ""])[:3]
        name = re.sub(r"[^\w.-]+", "_", f"{engine}_{model}_{Path(voice).stem if voice else 'default'}")
        folder = Path(args.out) / name
        folder.mkdir(parents=True, exist_ok=True)
        config = {"tts": {"engine": engine, "model": model, "voice": voice, "lexicon": lexicon}, "preload": True}
        kinds = {"tts"}
        if args.asr:
            config["stt"] = {"engine": args.stt}
            kinds.add("stt")
        http(url, token, "/config", config)
        print(f"\n== {variant}: loading...")
        wait_ready(url, token, kinds, timeout=1800)
        for i, (text, note) in enumerate(traps, 1):
            pcm, first, total = asyncio.run(speak(f"{ws}/tts?token={token}", text, args.emotion))
            file = folder / f"{i:02d}.wav"
            save_wav(file, pcm)
            row = {"variant": variant, "n": i, "text": text, "listen_for": note, "file": str(file), "first_ms": round(first * 1000)}
            if args.asr:
                import soxr

                pcm16k = (np.clip(soxr.resample(np.frombuffer(pcm, "<i2").astype(np.float32) / 32768, 24000, 16000), -1, 1) * 32767).astype("<i2").tobytes()
                final, _partials, _after = asyncio.run(listen(f"{ws}/stt?token={token}", pcm16k))
                heard = final.get("final", "")
                # Compare with what the voice was asked to say (numbers already in words)
                row["heard"] = heard
                row["score"] = round(score(normalize(text), normalize(heard)), 2)
            rows.append(row)
            print(f"{i:02d} {row.get('score', ''):>5} {text}")

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
