"""Voiceprints: who is speaking, as a speaker embedding.

A small speaker-verification model (WeSpeaker ResNet34 trained on
VoxCeleb, ONNX, on the CPU) turns a stretch of speech into a 256-number
vector; vectors of the same voice point the same way (cosine similarity).
The app keeps the known voices and decides who is who: the sidecar only
measures. Voiceprints never leave the computer.

The Kaldi filterbank features the model expects are computed in numpy (as
WeSpeaker does: Hamming window, no dither, mean normalization) and checked
against torchaudio in the tests, so the light profile needs no torch. Not
through sherpa-onnx: it bundles an older onnxruntime DLL that clashes with
the one the other engines load.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from paths import download, models_dir

log = logging.getLogger("lumi.voiceprint")

MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"
MODEL_FILE = "wespeaker_en_voxceleb_resnet34_LM.onnx"
RATE = 16000
# Shorter speech gives an unreliable voiceprint
MIN_SECONDS = 1.0
# Long turns: the middle part is enough and keeps it fast
MAX_SECONDS = 12.0

FRAME = 400  # 25 ms
SHIFT = 160  # 10 ms
NFFT = 512
MELS = 80
LOW_HZ = 20.0
PREEMPHASIS = 0.97

_lock = threading.Lock()
_session = None


class VoiceprintUnavailable(RuntimeError):
    pass


def _mel(hz):
    return 1127.0 * np.log(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def mel_banks() -> np.ndarray:
    """Kaldi's triangular mel filters, (MELS, NFFT/2 + 1)."""
    bins = NFFT // 2
    fft_mel = _mel(np.arange(bins) * RATE / NFFT)
    low, high = _mel(LOW_HZ), _mel(RATE / 2)
    delta = (high - low) / (MELS + 1)
    left = low + np.arange(MELS)[:, None] * delta
    center, right = left + delta, left + 2 * delta
    up = (fft_mel - left) / (center - left)
    down = (right - fft_mel) / (right - center)
    banks = np.maximum(0.0, np.minimum(up, down))
    return np.pad(banks, ((0, 0), (0, 1))).astype(np.float32)


_BANKS = mel_banks()
_WINDOW = (0.54 - 0.46 * np.cos(2 * np.pi * np.arange(FRAME) / (FRAME - 1))).astype(np.float64)


def fbank(audio: np.ndarray) -> np.ndarray:
    """Log mel filterbank, (frames, 80), like torchaudio.compliance.kaldi.fbank with WeSpeaker's options (before mean normalization)."""
    x = np.asarray(audio, dtype=np.float64) * 32768.0
    if len(x) < FRAME:
        return np.zeros((0, MELS), dtype=np.float32)
    count = 1 + (len(x) - FRAME) // SHIFT
    index = np.arange(FRAME)[None, :] + SHIFT * np.arange(count)[:, None]
    frames = x[index]
    frames = frames - frames.mean(axis=1, keepdims=True)
    previous = np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)
    frames = (frames - PREEMPHASIS * previous) * _WINDOW
    power = np.abs(np.fft.rfft(frames, n=NFFT, axis=1)) ** 2
    energies = power.astype(np.float32) @ _BANKS.T
    return np.log(np.maximum(energies, np.finfo(np.float32).eps)).astype(np.float32)


def _load():
    global _session
    if _session is not None:
        return _session
    import onnxruntime as ort

    path = download(MODEL_URL, models_dir() / "speaker" / MODEL_FILE)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    _session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
    log.info("Voiceprint model ready (%s)", MODEL_FILE)
    return _session


def trim(audio: np.ndarray) -> np.ndarray:
    """The loud part of the audio (silence and breaths blur a voiceprint), at most MAX_SECONDS from the middle."""
    frame = RATE // 50  # 20 ms
    usable = len(audio) - len(audio) % frame
    if usable <= 0:
        return audio[:0]
    frames = audio[:usable].reshape(-1, frame)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    loud = rms >= max(0.004, 0.15 * float(np.percentile(rms, 90)))
    speech = frames[loud].reshape(-1)
    limit = int(MAX_SECONDS * RATE)
    if len(speech) > limit:
        start = (len(speech) - limit) // 2
        speech = speech[start : start + limit]
    return speech


def embed(audio: np.ndarray) -> list[float] | None:
    """The voiceprint of 16 kHz mono float audio, unit length; None when there is too little speech."""
    speech = trim(np.asarray(audio, dtype=np.float32))
    if len(speech) < MIN_SECONDS * RATE:
        return None
    feats = fbank(speech)
    feats = feats - feats.mean(axis=0, keepdims=True)
    with _lock:
        session = _load()
        vector = session.run(None, {"feats": feats[None, :, :]})[0][0]
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm == 0:
        return None
    return [round(float(v), 5) for v in vector / norm]
