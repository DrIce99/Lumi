"""Does a voice follow written accents? (roadmap 17.4)

Every pair in text/accenti_it.txt (àncora/ancóra, pèsca/pésca...) is read
in two neutral carrier sentences, plain and with each accent, through a
running sidecar. Each sentence is aligned letter by letter with
torchaudio's MMS_FA model (downloaded once into the models folder, run on
the CPU), the syllables of the word are cut from the alignment and
measured (scripts/prosody.py): the most prominent syllable for stress
pairs, F1 of the vowel for open/closed pairs.

    uv run python server.py --port 8765                # in one terminal
    uv run python scripts/accenti.py --voices qwen3:1.7B-Base:,kokoro:v1.0:if_sara

A voice "follows" a stress pair when both accented readings put the stress
where the accent is (by chance: about 1 in 9), and an open/closed pair when
the open vowel's F1 is higher by more than 5%. Kokoro reads through
espeak-ng, which honors written accents: it is the check that the
measures work. WAV files and a CSV go to --out, so the doubtful ones can be
listened to; `--analyze` measures the WAV files of an earlier run again.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from prosody import stressed, syllables, vowel_f1  # noqa: E402

PAIRS = Path(__file__).resolve().parent.parent / "text" / "accenti_it.txt"
CARRIERS = ["Ho detto {} due volte.", "La parola {} è scritta qui."]
RATE = 24000


def read_pairs(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cells = [c.strip() for c in line.split("|")]
        kind, parts = cells[0], cells[1].split("-")
        item = {"kind": kind, "word": "".join(parts), "parts": parts}
        if kind in ("stress", "stressctx"):
            item["variants"] = {v.split("=")[0]: int(v.split("=")[1]) for v in cells[2:]}
        else:
            item["vowel"] = int(cells[2])
            item["variants"] = {v.split("=")[0]: v.split("=")[1] for v in cells[3:]}
        out.append(item)
    return out


def plain(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")


def file_name(item: dict, carrier: int, spelling: str) -> str:
    variants = list(item["variants"])
    if item["kind"].endswith("ctx"):
        return f"{item['word']}_ctx{carrier}.wav"
    suffix = f"_{variants.index(spelling) + 1}" if spelling in variants else ""
    return f"{item['word']}_{carrier}_{plain(spelling)}{suffix}.wav"


def readings(item: dict) -> list[list[tuple[int, str, str, str]]]:
    """Groups of (carrier number, carrier, spelling, result key) judged together.
    Accent pairs: in each neutral carrier, the plain word and its accented spellings.
    Context pairs (...ctx): the plain word in each of the sentences that decide its sense."""
    if item["kind"].endswith("ctx"):
        return [[(c, template, item["word"], template) for c, template in enumerate(item["variants"])]]
    return [[(c, carrier, spelling, spelling) for spelling in [item["word"], *item["variants"]]] for c, carrier in enumerate(CARRIERS)]


class Aligner:
    """Letter-level forced alignment with MMS_FA (multilingual, romanized letters)."""

    def __init__(self) -> None:
        import torch
        from torchaudio.pipelines import MMS_FA

        from paths import models_dir

        self.torch = torch
        self.bundle = MMS_FA
        self.model = MMS_FA.get_model(with_star=False, dl_kwargs={"model_dir": str(models_dir() / "mms_fa")})
        self.tokenizer = MMS_FA.get_tokenizer()
        self.aligner = MMS_FA.get_aligner()

    def letters(self, audio: np.ndarray, words: list[str]) -> list[list[tuple[float, float]]]:
        """For each word, (start, end) seconds of each of its letters."""
        import soxr

        wave = self.torch.from_numpy(soxr.resample(audio, RATE, 16000).astype(np.float32))[None]
        with self.torch.inference_mode():
            emission, _ = self.model(wave)
            spans = self.aligner(emission[0], self.tokenizer(words))
        step = wave.shape[1] / emission.shape[1] / 16000
        return [[(s.start * step, s.end * step) for s in word] for word in spans]


def word_spans(aligner: Aligner, audio: np.ndarray, carrier: str, item: dict) -> list[tuple[float, float]]:
    """Time spans of the test word's syllables in a carrier sentence: from the first
    letter of each syllable to the first of the next (the last one ends at the next word)."""
    words = [re.sub(r"[^a-z]", "", plain(w)) for w in re.split(r"[\s']+", carrier.format(item["word"]))]
    words = [w for w in words if w]
    index = words.index(item["word"])
    letters = aligner.letters(audio, words)
    mine = letters[index]
    after = letters[index + 1][0][0] if index + 1 < len(letters) else mine[-1][1] + 0.1
    starts, i = [], 0
    for part in item["parts"]:
        starts.append(mine[i][0])
        i += len(part)
    bounds = [*starts, min(after, mine[-1][1] + 0.15)]
    return [(bounds[k], bounds[k + 1]) for k in range(len(starts))]


def measure(aligner: Aligner, audio: np.ndarray, carrier: str, item: dict) -> dict:
    try:
        sylls = word_spans(aligner, audio, carrier, item)
    except Exception as err:  # alignment failures are rare; the row says why
        return {"error": f"alignment: {err}"}
    found = syllables(audio, RATE, sylls)
    out = {"stressed": stressed(found), "scores": " ".join(f"{s.score:+.1f}" for s in found)}
    if item["kind"].startswith("vowel"):
        out["f1"] = round(vowel_f1(audio, RATE, *sylls[item["vowel"]]))
    return out


def judge(item: dict, results: dict) -> tuple[bool | None, str]:
    """Whether the readings put the stress or the vowel where the accent (or the sense) wants it, and a line to print."""
    marked = list(item["variants"])
    if any("error" in results[s] for s in marked):
        return None, f"?? {item['word']}: {[results[s]['error'] for s in results if 'error' in results[s]]}"
    if item["kind"].startswith("stress"):
        ok = all(results[s]["stressed"] == item["variants"][s] for s in marked)
        line = " ".join(f"{s}->{results[s]['stressed']}" for s in [item["word"], *marked] if "stressed" in results.get(s, {}))
        return ok, f"{'ok' if ok else '--'} {line}"
    o = next(s for s in marked if item["variants"][s] == "open")
    k = next(s for s in marked if item["variants"][s] == "closed")
    fo, fk = results[o]["f1"], results[k]["f1"]
    if not fo or not fk:
        return None, f"?? {item['word']}: no F1"
    ok = fo > fk * 1.05
    return ok, f"{'ok' if ok else '--'} {o} F1 {fo} / {k} F1 {fk} (senza accento {results.get(item['word'], {}).get('f1', '-')})"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=os.environ.get("LUMI_SIDECAR_URL", "http://127.0.0.1:8765"))
    parser.add_argument("--token", default=os.environ.get("LUMI_SIDECAR_TOKEN", ""))
    parser.add_argument("--voices", default="qwen3:1.7B-Base:", help="engine:model:voice, comma-separated")
    parser.add_argument("--pairs", default=str(PAIRS))
    parser.add_argument("--analyze", action="store_true", help="measure the WAV files already in --out, don't synthesize")
    parser.add_argument("--out", default="accenti")
    args = parser.parse_args()
    url, token = args.url.rstrip("/"), args.token
    ws = url.replace("http", "ws", 1)
    pairs = read_pairs(Path(args.pairs))
    aligner = Aligner()

    if args.analyze:
        folders = sorted(p for p in Path(args.out).iterdir() if p.is_dir())
        variants = [(f.name, f) for f in folders]
    else:
        variants = []
        for variant in [v.strip() for v in args.voices.split(",") if v.strip()]:
            engine, model, voice = (variant.split(":", 2) + ["", ""])[:3]
            name = re.sub(r"[^\w.-]+", "_", f"{engine}_{model}_{Path(voice).stem if voice else 'default'}")[:80]
            variants.append((variant, Path(args.out) / name))

    rows: list[dict] = []
    summary = []
    for variant, folder in variants:
        if not args.analyze:
            from smoke import http, speak, wait_ready

            from pronuncia import save_wav

            engine, model, voice = (variant.split(":", 2) + ["", ""])[:3]
            folder.mkdir(parents=True, exist_ok=True)
            http(url, token, "/config", {"tts": {"engine": engine, "model": model, "voice": voice}, "preload": True})
            print(f"\n== {variant}: loading...")
            wait_ready(url, token, {"tts"}, timeout=1800)
        else:
            print(f"\n== {variant}")
        counts = {kind: [0, 0] for kind in ("stress", "vowel", "stressctx", "vowelctx")}
        diffs: list[float] = []
        for item in pairs:
            for group in readings(item):
                results = {}
                for c, carrier, spelling, key in group:
                    file = folder / file_name(item, c, spelling)
                    if not args.analyze:
                        pcm, _first, _total = asyncio.run(speak(f"{ws}/tts?token={token}", carrier.format(spelling), "neutra"))
                        save_wav(file, pcm)
                    if not file.exists():
                        results[key] = {"error": "no file"}
                        continue
                    import soundfile as sf

                    audio, _rate = sf.read(str(file), dtype="float32")
                    results[key] = measure(aligner, audio, carrier, item)
                    rows.append({"variant": variant, "kind": item["kind"], "carrier": carrier, "spelling": spelling, "expected": item["variants"].get(key, ""), **results[key], "file": str(file)})
                ok, line = judge(item, results)
                print(f"  {line}")
                if ok is not None:
                    counts[item["kind"]][0] += ok
                    counts[item["kind"]][1] += 1
                    if item["kind"] == "vowel":
                        o = next(s for s in item["variants"] if item["variants"][s] == "open")
                        k = next(s for s in item["variants"] if item["variants"][s] == "closed")
                        diffs.append(results[o]["f1"] - results[k]["f1"])
        summary.append((variant, counts, float(np.mean(diffs)) if diffs else 0.0))

    report = Path(args.out) / "accenti.csv"
    report.parent.mkdir(parents=True, exist_ok=True)
    with report.open("w", newline="", encoding="utf8") as f:
        writer = csv.DictWriter(f, fieldnames=list(dict.fromkeys(k for r in rows for k in r)))
        writer.writeheader()
        writer.writerows(rows)
    print("\nVoice | written accents followed: stress, open/closed (mean F1 open - closed) | plain word read right from its context: stress, open/closed")
    for variant, counts, d in summary:
        c = {k: f"{v[0]}/{v[1]}" for k, v in counts.items()}
        print(f"  {variant}: {c['stress']}, {c['vowel']} ({d:+.0f} Hz) | {c['stressctx']}, {c['vowelctx']}")
    print(f"\nWAV files in {args.out}, report in {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
