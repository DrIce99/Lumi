import importlib.util

import numpy as np
import pytest

from turn.smart_turn import N_MELS, log_mel, mel_filters, prepare


def test_prepare_pads_at_the_start_and_normalizes():
    audio = np.ones(16000, dtype=np.float32)
    out = prepare(audio)
    assert out.shape == (128000,)
    assert abs(out.mean()) < 1e-4 and abs(out.std() - 1) < 1e-3
    # The audio sits at the end, after the zero padding
    assert out[0] < out[-1]
    long = prepare(np.arange(200000, dtype=np.float32))
    assert long.shape == (128000,)


def test_features_shape_and_filters():
    feats = log_mel(prepare(np.random.default_rng(1).normal(0, 0.1, 32000)))
    assert feats.shape == (N_MELS, 800)
    filters = mel_filters()
    assert filters.shape == (80, 201)
    assert (filters >= 0).all()


@pytest.mark.skipif(importlib.util.find_spec("transformers") is None, reason="transformers not installed")
def test_features_match_whisper_feature_extractor():
    from transformers import WhisperFeatureExtractor

    rng = np.random.default_rng(0)
    t = np.arange(48000) / 16000
    audio = (0.3 * np.sin(2 * np.pi * 220 * t) + 0.05 * rng.normal(size=t.size)).astype(np.float32)
    prepared = prepare(audio)
    extractor = WhisperFeatureExtractor(chunk_length=8)
    reference = extractor(
        prepared, sampling_rate=16000, return_tensors="np", padding="max_length", max_length=128000, truncation=True, do_normalize=True
    ).input_features[0]
    ours = log_mel(prepare(prepared))
    assert reference.shape == ours.shape
    assert np.max(np.abs(reference - ours)) < 2e-3
