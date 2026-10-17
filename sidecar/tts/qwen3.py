"""Qwen3-TTS through faster-qwen3-tts: CUDA graphs and real streaming.

Three flavours, chosen by the model in the settings:
- CustomVoice: predefined speakers ("ryan", "aiden"...), emotions through a
  style instruction (ignored by the 0.6B model);
- VoiceDesign: the voice is described in words (the `voice` setting);
- Base: the voice is cloned from a reference clip (x-vector only, so the
  accent of the clip doesn't bleed into the Italian); without a clip, the
  Italian reader in voices/italiana.flac (the default voice: in the
  roadmap 17.3 comparison the Base clones sounded the most Italian and
  VoiceDesign drifted between sentences). No style instruction:
  Base models aren't trained to follow one, and with it every emotion
  pulled the timbre somewhere else (it sounded like different people).
- Trained ("1.7B-Italiano"): Base with a LoRA on one Italian reader, merged
  into a one-speaker CustomVoice-style model by lora/train.py (roadmap
  17.5), in models/lora/<name>/model. No style instruction, like Base.
The voice must stay the same between sentences: fixed speaker and seed.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterator
from pathlib import Path

from devices import prepare_cuda_dlls

from .base import Cancel, EngineUnavailable, TTSEngine, bundled_voice, to_pcm16
from .emotions import qwen_instruct

log = logging.getLogger("lumi.tts.qwen3")

REPOS = {
    "1.7B-CustomVoice": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "0.6B-CustomVoice": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    "1.7B-VoiceDesign": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "1.7B-Base": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    "0.6B-Base": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
}
SPEAKERS = ["ryan", "aiden", "eric", "dylan", "uncle_fu", "vivian", "serena", "sohee", "ono_anna"]
# Models trained by lora/train.py: settings id -> folder under models/lora
TRAINED = {"1.7B-Italiano": "italiano"}
LANGUAGE = "italian"
DEFAULT_DESCRIPTION = "Voce maschile giovane, calda e vivace, italiano naturale con dizione chiara"
# Codec steps per streamed chunk: 4 steps = ~333 ms of audio. Smaller chunks
# reach the first sound sooner but cost more decoding.
CHUNK_STEPS = 4
# Longer reference clips usually mix several voices or music
MAX_CLIP_SECONDS = 30


def clip_path(voice: str) -> str:
    """The reference clip for a voice setting: a file path, a bundled voice's name or empty ("italiana")."""
    voice = (voice or "").strip()
    return bundled_voice(voice or "italiana") or voice


def clip_seconds(path: str) -> float | None:
    try:
        import soundfile as sf

        return float(sf.info(path).duration)
    except Exception:
        return None


def patch_rope_registry() -> None:
    """qwen-tts registers a "default" RoPE initializer that reads `config.rope_theta`;
    recent Transformers keep it only in `config.rope_parameters`. Register one that reads both."""
    import torch
    from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS

    def default_rope(config, device=None, seq_len=None, layer_type=None):
        params = getattr(config, "rope_parameters", None) or {}
        if layer_type and isinstance(params, dict) and isinstance(params.get(layer_type), dict):
            params = params[layer_type]
        params = params if isinstance(params, dict) else {}
        base = params.get("rope_theta") or getattr(config, "rope_theta", None) or 10000.0
        partial = params.get("partial_rotary_factor") or getattr(config, "partial_rotary_factor", None) or 1.0
        head_dim = getattr(config, "head_dim", None) or config.hidden_size // config.num_attention_heads
        dim = int(head_dim * partial)
        exponent = torch.arange(0, dim, 2, dtype=torch.int64).to(device=device, dtype=torch.float) / dim
        return 1.0 / (base**exponent), 1.0

    ROPE_INIT_FUNCTIONS["default"] = default_rope


class Qwen3Engine(TTSEngine):
    name = "qwen3"
    # Loading captures CUDA graphs: no other GPU work may run meanwhile
    exclusive_load = True

    def __init__(self, config, models_dir_path: str):
        super().__init__(config, models_dir_path)
        self.model = None
        self.kind = "custom"
        self.clone_prompt = None
        self.speakers: list[str] = SPEAKERS
        self._lock = threading.Lock()

    def load(self) -> None:
        prepare_cuda_dlls()
        try:
            import torch
            from faster_qwen3_tts import FasterQwen3TTS
        except ImportError as err:
            raise EngineUnavailable("Qwen3-TTS non è installato: nel sidecar esegui `uv sync --extra gpu`.") from err
        if not torch.cuda.is_available():
            raise EngineUnavailable("Qwen3-TTS ha bisogno di una scheda video NVIDIA con CUDA: scegli Kokoro.")
        if self.config.model in TRAINED:
            repo = self._trained(TRAINED[self.config.model])
        else:
            repo = REPOS.get(self.config.model, REPOS["1.7B-Base"])
            self.kind = "design" if "VoiceDesign" in repo else "clone" if repo.endswith("Base") else "custom"
        # qwen_tts installs its own RoPE shim on import: replace it after the import
        import qwen_tts  # noqa: F401

        patch_rope_registry()
        log.info("Loading %s", repo)
        self.model = FasterQwen3TTS.from_pretrained(repo, device="cuda", dtype=torch.bfloat16)
        self.device = "cuda"
        if self.kind == "custom":
            supported = self.model.model.get_supported_speakers() if hasattr(self.model, "model") else None
            if supported:
                self.speakers = [s for s in SPEAKERS if s in supported] + sorted(s for s in supported if s not in SPEAKERS)
        if self.kind == "clone":
            self._prepare_clone(self.config.voice)
        # Captures the CUDA graphs now rather than on the first sentence
        self.model.warmup(prefill_len=100)

    def _trained(self, name: str) -> str:
        """The folder of a model merged by lora/train.py, and its speaker."""
        folder = Path(self.models_dir) / "lora" / name / "model"
        config = folder / "config.json"
        if not config.is_file():
            raise EngineUnavailable("Il modello addestrato in italiano non c'è ancora: crealo con lora.prepare e lora.train (vedi sidecar/lora/README.md).")
        meta = json.loads(config.read_text(encoding="utf8")).get("lumi_finetune") or {}
        self.kind = "trained"
        self.speakers = [meta.get("speaker") or name]
        # The language tag it was trained with ("auto" = none)
        self.trained_language = meta.get("language") or "auto"
        return str(folder)

    def _prepare_clone(self, clip: str) -> None:
        clip = clip_path(clip)
        if not clip or not Path(clip).is_file():
            raise EngineUnavailable("Per clonare una voce scegli un file audio (10-20 secondi di voce pulita).")
        seconds = clip_seconds(clip)
        if seconds and seconds > MAX_CLIP_SECONDS:
            # The voice print averages the whole clip: a long one mixes voices, music and noise
            log.warning("Voice clip is %.0f s long: 10-20 s of one clean voice gives a steadier voice", seconds)
        self.clone_prompt = self.model.model.create_voice_clone_prompt(ref_audio=clip, ref_text="", x_vector_only_mode=True)
        self._clip = clip

    def unload(self) -> None:
        self.model = None
        self.clone_prompt = None
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:
            pass

    def voices(self) -> list[str]:
        return self.speakers if self.kind == "custom" else []

    def stream(self, text: str, emotion: str, intensity: float, voice: str, cancel: Cancel | None = None) -> Iterator[bytes]:
        import torch

        if self.model is None:
            self.load()
        instruct = qwen_instruct(emotion, intensity, self.config.speed)
        with self._lock, torch.inference_mode():
            # Same seed for every sentence: the voice doesn't drift
            torch.manual_seed(self.config.seed)
            if self.kind == "custom":
                speaker = (voice or self.config.voice or "ryan").lower()
                if speaker not in self.speakers:
                    speaker = self.speakers[0]
                chunks = self.model.generate_custom_voice_streaming(
                    text=text, speaker=speaker, language=LANGUAGE, instruct=instruct, chunk_size=CHUNK_STEPS
                )
            elif self.kind == "trained":
                # Its only speaker; no instruction, it was never trained on one
                chunks = self.model.generate_custom_voice_streaming(
                    text=text, speaker=self.speakers[0], language=self.trained_language, chunk_size=CHUNK_STEPS
                )
            elif self.kind == "design":
                description = (voice or self.config.voice or DEFAULT_DESCRIPTION).strip()
                chunks = self.model.generate_voice_design_streaming(
                    text=text, instruct=f"{description}. {instruct}", language=LANGUAGE, chunk_size=CHUNK_STEPS
                )
            else:
                clip = clip_path(voice or self.config.voice)
                if clip != getattr(self, "_clip", None) and Path(clip).is_file():
                    self._prepare_clone(clip)
                chunks = self.model.generate_voice_clone_streaming(
                    text=text,
                    language=LANGUAGE,
                    voice_clone_prompt=self.clone_prompt,
                    xvec_only=True,
                    chunk_size=CHUNK_STEPS,
                )
            try:
                for audio, rate, _timing in chunks:
                    if cancel and cancel.cancelled:
                        break
                    if len(audio):
                        yield to_pcm16(audio, rate)
            finally:
                close = getattr(chunks, "close", None)
                if close:
                    close()
