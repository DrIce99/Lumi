"""Smart Turn v3 (Pipecat): from the last 8 seconds of the user's audio,
the probability that they finished their turn. Native audio, 23 languages
including Italian, ~10-30 ms on the CPU.

The model takes Whisper log-mel features (80 bins, 8 s); they are computed
here with numpy so the light profile doesn't need transformers.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from paths import models_dir

log = logging.getLogger("lumi.turn")

REPO = "pipecat-ai/smart-turn-v3"
MODEL_FILE = "smart-turn-v3.2-cpu.onnx"
SAMPLE_RATE = 16_000
SECONDS = 8
N_FFT = 400
HOP = 160
N_MELS = 80


def _hz_to_mel(freq: np.ndarray) -> np.ndarray:
    """Slaney mel scale (linear below 1 kHz, log above), as librosa and Whisper."""
    freq = np.asarray(freq, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = freq / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(freq >= min_log_hz, min_log_mel + np.log(np.maximum(freq, 1e-10) / min_log_hz) / logstep, mels)


def _mel_to_hz(mels: np.ndarray) -> np.ndarray:
    mels = np.asarray(mels, dtype=np.float64)
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(mels >= min_log_mel, min_log_hz * np.exp(logstep * (mels - min_log_mel)), f_sp * mels)


def mel_filters(sr: int = SAMPLE_RATE, n_fft: int = N_FFT, n_mels: int = N_MELS) -> np.ndarray:
    """Slaney-normalized mel filter bank, shape (n_mels, 1 + n_fft // 2)."""
    fft_freqs = np.linspace(0, sr / 2, 1 + n_fft // 2)
    mel_points = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(sr / 2), n_mels + 2))
    fdiff = np.diff(mel_points)
    ramps = mel_points[:, None] - fft_freqs[None, :]
    lower = -ramps[:-2] / fdiff[:-1, None]
    upper = ramps[2:] / fdiff[1:, None]
    weights = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_points[2 : n_mels + 2] - mel_points[:n_mels])
    return (weights * enorm[:, None]).astype(np.float32)


_FILTERS = mel_filters()
_WINDOW = np.hanning(N_FFT + 1)[:-1].astype(np.float64)


def prepare(audio: np.ndarray) -> np.ndarray:
    """Last 8 seconds, zero-padded at the start, normalized to zero mean and unit variance."""
    n = SECONDS * SAMPLE_RATE
    audio = np.asarray(audio, dtype=np.float32)[-n:]
    if len(audio) < n:
        audio = np.pad(audio, (n - len(audio), 0))
    return (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)


def log_mel(audio: np.ndarray) -> np.ndarray:
    """Whisper's log-mel spectrogram: (80, 800) for 8 s of 16 kHz audio."""
    padded = np.pad(audio.astype(np.float64), (N_FFT // 2, N_FFT // 2), mode="reflect")
    frames = 1 + (len(padded) - N_FFT) // HOP
    index = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    spectrum = np.abs(np.fft.rfft(padded[index] * _WINDOW, n=N_FFT)) ** 2
    mel = np.maximum(1e-10, _FILTERS.astype(np.float64) @ spectrum.T)
    log_spec = np.log10(mel)[:, :-1]
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(np.float32)


class SmartTurn:
    def __init__(self):
        self.session = None
        self.error: str | None = None
        self._lock = threading.Lock()

    def load(self) -> None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(REPO, MODEL_FILE, cache_dir=str(models_dir() / "smart-turn"))
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 2
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
        log.info("Smart Turn ready (%s)", MODEL_FILE)

    def probability(self, audio: np.ndarray) -> float:
        """Probability (0-1) that the turn is complete."""
        with self._lock:
            if self.session is None:
                self.load()
            features = log_mel(prepare(audio))[None, :, :]
            output = self.session.run(None, {"input_features": features})[0]
        return float(np.asarray(output).reshape(-1)[0])
