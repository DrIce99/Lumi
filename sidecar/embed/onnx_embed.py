"""Text embeddings on the CPU for the memory (roadmap 10.6), for PCs without
Ollama: ONNX models from Hugging Face run with onnxruntime and the
`tokenizers` library (both already needed by the light profile).

The default is bge-m3, the same model the app uses through Ollama, int8
quantized (568 MB): multilingual, good in Italian, and the similarity
floors measured for it hold. The vectors are not bit-identical to
Ollama's, so they are stored under their own model name and the memory
re-embeds in the background when the source changes.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass

import numpy as np

log = logging.getLogger("lumi.embed")


@dataclass(frozen=True)
class EmbedModel:
    repo: str
    file: str
    pooling: str  # "cls" | "mean"
    query_prefix: str = ""
    document_prefix: str = ""
    max_tokens: int = 512


MODELS = {
    "bge-m3-int8": EmbedModel("Xenova/bge-m3", "onnx/model_quantized.onnx", "cls"),
    "multilingual-e5-small-int8": EmbedModel("Xenova/multilingual-e5-small", "onnx/model_quantized.onnx", "mean", "query: ", "passage: "),
    "multilingual-e5-base-int8": EmbedModel("Xenova/multilingual-e5-base", "onnx/model_quantized.onnx", "mean", "query: ", "passage: "),
    "paraphrase-multilingual-minilm-int8": EmbedModel("Xenova/paraphrase-multilingual-MiniLM-L12-v2", "onnx/model_quantized.onnx", "mean", max_tokens=256),
}
DEFAULT_MODEL = "bge-m3-int8"
# Batches stay small: memory lines are short, and the CPU is shared with the voice
MAX_BATCH = 16
# Unloaded after this long without requests (like Ollama's keep_alive): bge-m3 takes ~1 GB of RAM
KEEP_ALIVE_S = 600


class EmbedUnavailable(RuntimeError):
    pass


def pool(hidden: np.ndarray, mask: np.ndarray, how: str) -> np.ndarray:
    """Sentence vectors from token states (batch, tokens, dim), L2-normalized."""
    if how == "cls":
        vectors = hidden[:, 0, :]
    else:
        weights = mask[:, :, None].astype(hidden.dtype)
        vectors = (hidden * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1e-9)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norms, 1e-12)


class OnnxEmbedder:
    def __init__(self, name: str = DEFAULT_MODEL, threads: int | None = None, keep_alive: float = KEEP_ALIVE_S):
        if name not in MODELS:
            raise EmbedUnavailable(f"Modello di embedding sconosciuto: {name}")
        self.name = name
        self.spec = MODELS[name]
        self.threads = threads or max(1, min(4, (os.cpu_count() or 4) // 2))
        self.session = None
        self.tokenizer = None
        self.keep_alive = keep_alive
        self.used_at = 0.0
        self._lock = threading.Lock()

    def load(self) -> None:
        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from tokenizers import Tokenizer
        except ImportError as err:
            raise EmbedUnavailable(f"Mancano i pacchetti per gli embedding: {err}") from err
        model_path = hf_hub_download(self.spec.repo, self.spec.file)
        # Large ONNX files keep their weights next to the graph
        try:
            hf_hub_download(self.spec.repo, self.spec.file + "_data")
        except Exception:
            pass
        tokenizer = Tokenizer.from_file(hf_hub_download(self.spec.repo, "tokenizer.json"))
        tokenizer.enable_truncation(self.spec.max_tokens)
        tokenizer.enable_padding()
        options = ort.SessionOptions()
        # Half the cores at most: the embeddings run in the background, next to Whisper and the voice
        options.intra_op_num_threads = self.threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.tokenizer = tokenizer
        log.info("Embedding model %s ready (%d threads)", self.name, self.threads)
        threading.Thread(target=self._unload_when_idle, name="lumi-embed-idle", daemon=True).start()

    def _unload_when_idle(self) -> None:
        while True:
            time.sleep(min(60.0, self.keep_alive / 2))
            with self._lock:
                if self.session is None:
                    return
                if time.monotonic() - self.used_at > self.keep_alive:
                    self.session = None
                    self.tokenizer = None
                    log.info("Embedding model %s unloaded (idle)", self.name)
                    return

    @property
    def loaded(self) -> bool:
        return self.session is not None

    def embed(self, texts: list[str], kind: str = "document") -> np.ndarray:
        if not texts:
            return np.zeros((0, 0), dtype=np.float32)
        with self._lock:
            self.used_at = time.monotonic()
            if self.session is None:
                self.load()
            prefix = self.spec.query_prefix if kind == "query" else self.spec.document_prefix
            out = []
            for i in range(0, len(texts), MAX_BATCH):
                batch = self.tokenizer.encode_batch([prefix + t for t in texts[i : i + MAX_BATCH]])
                ids = np.array([e.ids for e in batch], dtype=np.int64)
                mask = np.array([e.attention_mask for e in batch], dtype=np.int64)
                feed = {"input_ids": ids, "attention_mask": mask}
                if "token_type_ids" in self.inputs:
                    feed["token_type_ids"] = np.zeros_like(ids)
                hidden = self.session.run(None, feed)[0]
                out.append(pool(hidden.astype(np.float32), mask, self.spec.pooling))
            return np.concatenate(out).astype(np.float32)
