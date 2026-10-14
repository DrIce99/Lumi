"""Trains the "Lumi" wake word model for openWakeWord from synthetic speech.

    uv sync --extra wakeword --extra gpu
    uv run python -m wake.train --engines qwen3,kokoro --count 3000

1. Positives: "Lumi", "Ehi Lumi"... spoken by Lumi's own TTS engines with
   every voice available, varying speed, emotion and intensity.
2. Augmentation: speed/pitch, reverb (synthetic room responses), noise
   (generated, or recordings from --noise-dir), gain; each clip is placed
   so the name ends near the end of the 2 s window, as when it is spotted.
3. Negatives: similar words ("lume", "Luigi", "lumaca", "lui mi"...) and
   generic Italian speech from the same voices, plus --negatives-dir
   recordings and noise alone.
4. openWakeWord's feature models turn each clip into 16 x 96 embeddings;
   a small network learns lumi / not lumi and is exported to ONNX as
   %APPDATA%\\Lumi\\models\\wake\\lumi.onnx (never into the repo), with a
   lumi.json report (recall and false positives on held-out clips).

Optional: --user-dir with 20-30 WAV recordings of your own voice saying the
name makes it much more precise (they are augmented and weighted more).
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import time
from pathlib import Path

import numpy as np

import paths

log = logging.getLogger("lumi.wake.train")

RATE = 16_000
WINDOW = 2 * RATE
FRAMES = 16
EMBEDDING = 96

POSITIVE_TEXTS = ["Lumi", "Lumi!", "Lumi?", "Lumi.", "Ehi Lumi", "Ehi, Lumi!", "Ehi Lumi?", "Ehi, Lumi.", "Lumi, ehi."]
NEGATIVE_WORDS = [
    "lume", "Luigi", "lumaca", "lui mi", "Lucia", "lumino", "luna", "luci", "lumen", "illumina",
    "ehi Luigi", "ehi luna", "fumi", "numi", "Rumi", "Lidia", "Lucio", "lungo", "ehi tu", "eh sì",
    "Luisa", "lì mi", "le mie", "lo mi", "uomini", "ehi Gigi", "allume", "lumière",
]
NEGATIVE_SENTENCES = [
    "Oggi pomeriggio vado al supermercato.", "Mi passi il caricatore del telefono?", "Il treno è in ritardo di dieci minuti.",
    "Hai visto la partita ieri sera?", "Devo finire questo documento entro venerdì.", "Che tempo fa domani a Milano?",
    "Ricordati di chiamare la mamma.", "La riunione è stata spostata alle tre.", "Questo codice non compila.",
    "Ho fame, ordiniamo una pizza?", "Accendi la luce in cucina.", "Il gatto dorme sul divano.",
    "Leggi quella mail e dimmi cosa ne pensi.", "Domani mattina ho il dentista.", "Il server è di nuovo giù.",
    "Mi piace molto questa canzone.", "Hai sentito le ultime notizie?", "Prendo un caffè, ne vuoi uno?",
    "Il file è nella cartella condivisa.", "Facciamo una pausa di cinque minuti.", "Lui mi ha detto che arriva tardi.",
    "Le luci della città di notte sono belle.", "Luigi e Lucia sono andati al mare.", "La luna stasera è piena.",
]
EMOTIONS = ["neutra", "gioia", "sorpresa", "pensiero", "tristezza"]


# ---------------- audio helpers (pure, tested) ----------------


def resample(audio: np.ndarray, source: int, target: int) -> np.ndarray:
    """Linear-interpolation resampling: enough for 16 kHz features."""
    if source == target or len(audio) == 0:
        return audio.astype(np.float32)
    n = max(1, int(round(len(audio) * target / source)))
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


def vary_speed(audio: np.ndarray, factor: float) -> np.ndarray:
    """Faster (factor > 1) and higher, or slower and lower, like a tape."""
    return resample(audio, int(RATE * factor), RATE)


def room_response(rng: np.random.Generator, rt60: float) -> np.ndarray:
    """A synthetic room: decaying noise, the direct sound first."""
    n = int(rt60 * RATE)
    t = np.arange(n) / RATE
    ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
    ir[0] = 1.0
    return (ir / np.abs(ir).sum() * 4).astype(np.float32)


def reverb(audio: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    wet = np.convolve(audio, room_response(rng, rng.uniform(0.15, 0.6)))[: len(audio)]
    mix = rng.uniform(0.2, 0.6)
    return ((1 - mix) * audio + mix * wet).astype(np.float32)


def add_noise(audio: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    """Mixes `noise` (looped or cut to length) at the given signal-to-noise ratio."""
    if len(noise) < len(audio):
        noise = np.tile(noise, len(audio) // max(1, len(noise)) + 1)
    noise = noise[: len(audio)]
    power = np.mean(audio**2) + 1e-9
    npower = np.mean(noise**2) + 1e-9
    return (audio + noise * np.sqrt(power / (npower * 10 ** (snr_db / 10)))).astype(np.float32)


def colored_noise(rng: np.random.Generator, n: int) -> np.ndarray:
    """White or pink-ish noise (a fan, a street)."""
    white = rng.standard_normal(n).astype(np.float32)
    if rng.random() < 0.5:
        return white
    return np.cumsum(white) - np.convolve(np.cumsum(white), np.ones(64) / 64, mode="same")


def fit_window(audio: np.ndarray, rng: np.random.Generator, window: int = WINDOW) -> np.ndarray:
    """The clip in a window, ending 0-200 ms before its end (the name is spotted right after it's said)."""
    audio = audio[-window:]
    out = np.zeros(window, dtype=np.float32)
    tail = int(rng.uniform(0, 0.2) * RATE)
    end = window - tail
    start = max(0, end - len(audio))
    out[start : start + len(audio[-(end - start) :])] = audio[-(end - start) :]
    return out


def trim_silence(audio: np.ndarray, threshold: float = 0.01) -> np.ndarray:
    loud = np.flatnonzero(np.abs(audio) > threshold * (np.abs(audio).max() + 1e-9))
    return audio[loud[0] : loud[-1] + 1] if len(loud) else audio


def to_int16(audio: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    peak = np.abs(audio).max() + 1e-9
    gain = rng.uniform(0.2, 0.9) / peak
    return np.clip(audio * gain * 32767, -32768, 32767).astype(np.int16)


def augment(audio: np.ndarray, rng: np.random.Generator, noises: list[np.ndarray], speed: bool = True) -> np.ndarray:
    """One random variant of a 16 kHz clip, in a WINDOW-long int16 array."""
    x = trim_silence(audio)
    if speed:
        x = vary_speed(x, rng.uniform(0.85, 1.18))
    if rng.random() < 0.6:
        x = reverb(x, rng)
    x = fit_window(x, rng)
    noise = noises[rng.integers(len(noises))] if noises and rng.random() < 0.7 else colored_noise(rng, WINDOW)
    x = add_noise(x, noise, rng.uniform(5, 30))
    return to_int16(x, rng)


# ---------------- data ----------------


def read_wavs(folder: Path | None, limit: int = 2000) -> list[np.ndarray]:
    """WAV/FLAC/OGG files of a folder, as 16 kHz mono float."""
    if not folder:
        return []
    import soundfile as sf

    out = []
    for path in sorted(folder.rglob("*"))[: limit * 3]:
        if path.suffix.lower() not in (".wav", ".flac", ".ogg"):
            continue
        try:
            audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
        except RuntimeError:
            continue
        out.append(resample(audio.mean(axis=1), rate, RATE))
        if len(out) >= limit:
            break
    log.info("%d clips from %s", len(out), folder)
    return out


def synthesize(engines: list[str], texts: list[str], count: int, rng: random.Random) -> list[np.ndarray]:
    """`count` utterances of random `texts`, with every voice of every engine, at 16 kHz."""
    from engines import make_tts
    from tts.base import SAMPLE_RATE, TTSConfig

    defaults = {"qwen3": ("1.7B-CustomVoice", None), "kokoro": ("v1.0", None), "chatterbox": ("multilingual", "predefinita")}
    out: list[np.ndarray] = []
    per_engine = max(1, count // len(engines))
    for name in engines:
        model, voice = defaults.get(name, ("", None))
        engine = make_tts(TTSConfig(engine=name, model=model, voice=voice or ""), str(paths.models_dir()))
        log.info("Loading %s...", name)
        engine.load()
        voices = engine.voices() or [voice or ""]
        if name == "qwen3":
            from tts.qwen3 import SPEAKERS

            voices = list(SPEAKERS)
        started = time.monotonic()
        for i in range(per_engine):
            text = rng.choice(texts)
            emotion = rng.choice(EMOTIONS)
            pcm = b"".join(engine.stream(text, emotion, rng.uniform(0.3, 1.0), voices[i % len(voices)]))
            audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
            if len(audio):
                out.append(resample(audio, SAMPLE_RATE, RATE))
            if (i + 1) % 100 == 0:
                log.info("%s: %d/%d (%.1f/s)", name, i + 1, per_engine, (i + 1) / (time.monotonic() - started))
        engine.unload()
    return out


def features(clips: np.ndarray) -> np.ndarray:
    """openWakeWord embeddings of int16 clips: (N, 16, 96), the last 16 frames (1.28 s) of each."""
    from openwakeword.utils import AudioFeatures

    from wake.detector import feature_files

    mel, emb = feature_files()
    extractor = AudioFeatures(melspec_model_path=str(mel), embedding_model_path=str(emb), inference_framework="onnx")
    out = extractor.embed_clips(clips, batch_size=64)
    return np.asarray(out, dtype=np.float32)[:, -FRAMES:, :]


# ---------------- model ----------------


def train(x: np.ndarray, y: np.ndarray, w: np.ndarray, epochs: int, seed: int):
    import torch
    from torch import nn

    torch.manual_seed(seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # openWakeWord's small "dnn" head over the 16 x 96 embeddings
    model = nn.Sequential(
        nn.Flatten(),
        nn.Linear(FRAMES * EMBEDDING, 128),
        nn.LayerNorm(128),
        nn.ReLU(),
        nn.Linear(128, 128),
        nn.LayerNorm(128),
        nn.ReLU(),
        nn.Linear(128, 1),
        nn.Sigmoid(),
    ).to(device)
    xs, ys, ws = (torch.tensor(a, device=device) for a in (x, y.astype(np.float32), w.astype(np.float32)))
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-3)
    loss_fn = nn.BCELoss(reduction="none")
    for epoch in range(epochs):
        order = torch.randperm(len(xs), device=device)
        total = 0.0
        for i in range(0, len(order), 256):
            idx = order[i : i + 256]
            p = model(xs[idx]).squeeze(1)
            loss = (loss_fn(p, ys[idx]) * ws[idx]).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss) * len(idx)
        if (epoch + 1) % 5 == 0:
            log.info("epoch %d: loss %.4f", epoch + 1, total / len(xs))
    return model.cpu().eval()


def evaluate(model, x: np.ndarray, y: np.ndarray, threshold: float = 0.5) -> dict:
    import torch

    with torch.no_grad():
        p = model(torch.tensor(x)).squeeze(1).numpy()
    pos, neg = p[y == 1], p[y == 0]
    return {
        "recall": float((pos >= threshold).mean()) if len(pos) else None,
        "false_positive_rate": float((neg >= threshold).mean()) if len(neg) else None,
        "threshold": threshold,
        "positives": int(len(pos)),
        "negatives": int(len(neg)),
    }


def export(model, path: Path) -> None:
    import torch

    path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(model, torch.zeros(1, FRAMES, EMBEDDING), str(path), input_names=["input"], output_names=["score"], opset_version=17)


# ---------------- main ----------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engines", default="kokoro", help="TTS engines for the synthetic voices, comma separated (qwen3, kokoro, chatterbox)")
    ap.add_argument("--count", type=int, default=3000, help="synthetic positives (2000-5000)")
    ap.add_argument("--variants", type=int, default=3, help="augmented variants of each synthetic clip")
    ap.add_argument("--negatives", type=int, default=3000, help="synthetic negatives")
    ap.add_argument("--user-dir", type=Path, help="recordings of your own voice saying the name")
    ap.add_argument("--negatives-dir", type=Path, help="recordings of speech without the name")
    ap.add_argument("--noise-dir", type=Path, help="background recordings (fans, music, streets)")
    ap.add_argument("--name", default="lumi", help="model name (file <name>.onnx)")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    paths.configure()

    rng = random.Random(args.seed)
    nrng = np.random.default_rng(args.seed)
    engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    noises = read_wavs(args.noise_dir, 500)

    log.info("Synthesizing %d positives and %d negatives with %s", args.count, args.negatives, ", ".join(engines))
    positives = synthesize(engines, POSITIVE_TEXTS, args.count, rng)
    neg_words = synthesize(engines, NEGATIVE_WORDS, args.negatives // 2, rng)
    neg_sentences = synthesize(engines, NEGATIVE_SENTENCES, args.negatives - args.negatives // 2, rng)
    users = read_wavs(args.user_dir, 200)
    real_negatives = read_wavs(args.negatives_dir, 3000)

    clips: list[np.ndarray] = []
    labels: list[int] = []
    weights: list[float] = []

    def add(audio: np.ndarray, label: int, weight: float, variants: int) -> None:
        for _ in range(variants):
            clips.append(augment(audio, nrng, noises))
            labels.append(label)
            weights.append(weight)

    for a in positives:
        add(a, 1, 1.0, args.variants)
    for a in users:
        add(a, 1, 3.0, 10)
    for a in neg_words:
        add(a, 0, 1.5, args.variants)
    for a in neg_sentences + real_negatives:
        # Long speech: random 2 s pieces, not only the end
        for _ in range(args.variants):
            start = nrng.integers(0, max(1, len(a) - WINDOW))
            add(a[start : start + WINDOW], 0, 1.0, 1)
    for _ in range(len(positives) // 2):
        clips.append(to_int16(colored_noise(nrng, WINDOW), nrng))
        labels.append(0)
        weights.append(1.0)

    x_all = np.stack(clips)
    y_all = np.array(labels)
    w_all = np.array(weights)
    # Balance the classes
    pos_share = y_all.mean()
    w_all = np.where(y_all == 1, w_all * 0.5 / pos_share, w_all * 0.5 / (1 - pos_share))
    log.info("%d clips (%.0f%% positive): computing features...", len(y_all), 100 * pos_share)
    feats = features(x_all)

    order = nrng.permutation(len(y_all))
    split = int(len(order) * 0.85)
    tr, va = order[:split], order[split:]
    model = train(feats[tr], y_all[tr], w_all[tr], args.epochs, args.seed)
    report = {name: evaluate(model, feats[va], y_all[va], t) for name, t in (("at_0.5", 0.5), ("at_0.7", 0.7))}
    log.info("Validation: %s", json.dumps(report))

    out = paths.models_dir() / "wake" / f"{args.name}.onnx"
    export(model, out)
    (out.with_suffix(".json")).write_text(
        json.dumps({"name": args.name, "engines": engines, "clips": int(len(y_all)), "user_clips": len(users), "validation": report}, indent=2),
        encoding="utf-8",
    )
    log.info("Saved %s: restart Lumi (or wait a minute) and the wake word uses it", out)


if __name__ == "__main__":
    main()
