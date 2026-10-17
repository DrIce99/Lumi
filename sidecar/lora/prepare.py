"""Builds the LoRA dataset (roadmap 17.5): hours of ONE Italian reader,
cut into 3-15 s clips with their text and Qwen3-TTS codec codes.

    uv run python -m lora.prepare --librivox i_malavoglia_1303_librivox --hours 8
    uv run python -m lora.prepare --audio D:\\letture\\*.mp3 --hours 6

LibriVox recordings are public domain; pick a book read by a single person
(the item page says "Read by ..."). Common Voice is no good: thousands of
voices. Everything goes to %APPDATA%\\Lumi\\models\\lora\\<name>\\data:
raw/ (the downloads), clips/ (24 kHz WAV), ref.wav (the voice the model
will keep), clips.jsonl (audio, text), train.jsonl (+ audio_codes). Run
again without --librivox/--audio to redo only the codes. Needs
ffmpeg and a GPU (Whisper large-v3-turbo and the codec run on CUDA when
available; the CPU works but takes many hours).
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import paths  # noqa: E402

paths.configure()

import numpy as np  # noqa: E402

from lora.data import Clip, Word, phrases, plan_clips, silences, total_hours  # noqa: E402

log = logging.getLogger("lumi.lora")
RATE = 24000
BASE_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


def lora_dir(name: str) -> Path:
    return paths.models_dir() / "lora" / name


def librivox_files(item: str) -> list[str]:
    """The chapter MP3s of a LibriVox item on archive.org, best quality, in order."""
    with urllib.request.urlopen(f"https://archive.org/metadata/{item}", timeout=60) as res:
        meta = json.loads(res.read())
    names = sorted(f["name"] for f in meta.get("files", []) if f["name"].endswith(".mp3") and not f["name"].endswith("_64kb.mp3"))
    return [f"https://archive.org/download/{item}/{name}" for name in names]


def decode(ffmpeg: str, source: Path) -> np.ndarray:
    """Any audio file -> float32 mono 24 kHz."""
    out = subprocess.run(
        [ffmpeg, "-loglevel", "error", "-i", str(source), "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype="<f4")


def transcribe(whisper, audio: np.ndarray) -> list[Word]:
    """Every word with its timing: clips are cut at the pauses between words."""
    import soxr

    pcm16k = soxr.resample(audio, RATE, 16000).astype(np.float32)
    segments, _ = whisper.transcribe(pcm16k, language="it", beam_size=5, vad_filter=True, condition_on_previous_text=False, word_timestamps=True)
    return [Word(w.start, w.end, w.word, w.probability, s.no_speech_prob) for s in segments for w in s.words or []]


def write_clip(path: Path, audio: np.ndarray, clip: Clip) -> None:
    import soundfile as sf

    # The clip's bounds already hold a margin inside the pauses: fade it
    a, b = max(0, int(clip.start * RATE)), min(len(audio), int(clip.end * RATE))
    piece = audio[a:b].copy()
    fade = min(len(piece) // 4, int(0.02 * RATE))
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        piece[:fade] *= ramp
        piece[-fade:] *= ramp[::-1]
    peak = float(np.abs(piece).max()) or 1.0
    sf.write(str(path), piece * min(1.0, 0.9 / peak), RATE, subtype="PCM_16")


def pick_reference(clips: list[tuple[Path, Clip]]) -> Path:
    """A 8-15 s clip from the middle of the book: the voice the trained model keeps."""
    good = [p for p, c in clips if 8 <= c.duration <= 15] or [p for p, _ in clips]
    return good[len(good) // 2]


def encode_codes(rows: list[dict], device: str) -> None:
    """Adds the 12 Hz codec codes of each clip (the targets the model learns to produce)."""
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSTokenizer

    from tts.qwen3 import patch_rope_registry

    patch_rope_registry()

    folder = Path(snapshot_download(BASE_REPO, allow_patterns=["speech_tokenizer/*"])) / "speech_tokenizer"
    tokenizer = Qwen3TTSTokenizer.from_pretrained(str(folder), device_map=device)
    batch = 16
    for i in range(0, len(rows), batch):
        part = rows[i : i + batch]
        encoded = tokenizer.encode([r["audio"] for r in part])
        for row, codes in zip(part, encoded.audio_codes):
            row["audio_codes"] = codes.cpu().tolist()
        print(f"  codes {min(i + batch, len(rows))}/{len(rows)}", end="\r")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--librivox", action="append", default=[], help="archive.org item id of a LibriVox book (repeatable)")
    parser.add_argument("--audio", action="append", default=[], help="audio files or a glob (repeatable)")
    parser.add_argument("--name", default="italiano", help="folder name under models/lora")
    parser.add_argument("--hours", type=float, default=8.0, help="stop after this much usable speech")
    parser.add_argument("--device", default="auto", help="cuda, cpu or auto")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ffmpeg non trovato: installalo e mettilo nel PATH.")
        return 1
    import torch
    from faster_whisper import WhisperModel

    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    data = lora_dir(args.name) / "data"
    raw, clips_dir = data / "raw", data / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    listing = data / "clips.jsonl"
    if not args.librivox and not args.audio and listing.exists():
        rows = [json.loads(line) for line in listing.read_text(encoding="utf8").splitlines()]
        return finish(rows, data, device)

    sources: list[Path] = []
    for item in args.librivox:
        for url in librivox_files(item):
            sources.append(paths.download(url, raw / item / url.rsplit("/", 1)[1]))
    for pattern in args.audio:
        sources += [Path(p) for p in sorted(glob.glob(pattern))]
    if not sources:
        print("Nessun audio: usa --librivox o --audio.")
        return 1

    whisper = WhisperModel("large-v3-turbo", device=device, compute_type="float16" if device == "cuda" else "int8", download_root=str(paths.models_dir() / "whisper"))
    written: list[tuple[Path, Clip]] = []
    for n, source in enumerate(sources):
        if total_hours([c for _, c in written]) >= args.hours:
            break
        audio = decode(ffmpeg, source)
        planned = plan_clips(phrases(transcribe(whisper, audio), silences(audio, RATE), len(audio) / RATE))
        for k, clip in enumerate(planned):
            path = clips_dir / f"{n:03d}_{k:04d}.wav"
            write_clip(path, audio, clip)
            written.append((path, clip))
        print(f"{source.name}: {len(planned)} clip, {total_hours([c for _, c in written]):.2f} h in tutto")
    del whisper
    if not written:
        print("Nessuna clip utilizzabile.")
        return 1

    ref = data / "ref.wav"
    shutil.copyfile(pick_reference(written), ref)
    rows = [{"audio": str(p), "text": c.text, "ref_audio": str(ref), "language": "Italian", "seconds": round(c.duration, 2)} for p, c in written]
    write_jsonl(listing, rows)
    return finish(rows, data, device)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def finish(rows: list[dict], data: Path, device: str) -> int:
    encode_codes(rows, device)
    out = data / "train.jsonl"
    write_jsonl(out, rows)
    hours = sum(r.get("seconds", 0) for r in rows) / 3600
    print(f"{len(rows)} clip, {hours:.2f} h -> {out}")
    print(f"Ora: uv run python -m lora.train --name {data.parent.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
