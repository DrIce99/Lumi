"""LoRA on Qwen3-TTS Base with one Italian reader (roadmap 17.5), then the
adapter merged into a full model that the sidecar loads like a CustomVoice
model with one speaker ("1.7B-Italiano" in the settings).

    uv run python -m lora.prepare --librivox i_malavoglia_1303_librivox --hours 8
    uv run python -m lora.train --name italiano            # hours; close Lumi first (VRAM)
    uv run python scripts/pronuncia.py --voices qwen3:1.7B-Base:,qwen3:1.7B-Italiano: --asr --accent
    uv run python scripts/accenti.py --voices qwen3:1.7B-Base:,qwen3:1.7B-Italiano:

The sequence layout comes from Qwen's single-speaker fine-tuning recipe
(github.com/QwenLM/Qwen3-TTS, finetuning/sft_12hz.py and dataset.py,
Apache 2.0): the whole text first, then the codec frames (the layout
faster-qwen3-tts uses for custom voices: non_streaming_mode), the speaker
embedding of one reference clip in its slot; loss = first-codebook
cross-entropy of the talker + 0.3 x the code predictor's on the other 15.
Three fixes over the published recipe, measured as the loss of the
untrained model on our clips (the right format is the one it already
knows): text embeddings go through `text_projection` as in generation,
labels are shifted once (Transformers' causal loss shifts them again:
the recipe predicted two steps ahead), and the code predictor gets the
hidden state that produced codec 0 of the frame, one position earlier,
with its labels unshifted. Talker 11.8 -> 1.36, code predictor 9.2 -> 4.9.
Only LoRA weights on the attention and MLP projections train (peft, bf16,
gradient checkpointing): the 1.7B model needs about 5 GB instead of 20+.
The merged weights keep faster-qwen3-tts fast (no adapter at inference).
No style instruction is trained: like Base, the result gets none.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import paths  # noqa: E402

paths.configure()

import numpy as np  # noqa: E402
import torch  # noqa: E402

REPOS = {"1.7B": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "0.6B": "Qwen/Qwen3-TTS-12Hz-0.6B-Base"}
TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
# The speaker's row in the codec embedding of the merged model (as in sft_12hz.py)
SPEAKER_ID = 3000


def lora_dir(name: str) -> Path:
    return paths.models_dir() / "lora" / name


def build_text(text: str) -> str:
    return f"<|im_start|>assistant\n{text}<|im_end|>\n<|im_start|>assistant\n"


def ref_mel(path: str) -> torch.Tensor:
    import librosa
    from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram

    audio, _ = librosa.load(path, sr=24000, mono=True)
    return mel_spectrogram(
        torch.from_numpy(audio.astype(np.float32)).unsqueeze(0),
        n_fft=1024,
        num_mels=128,
        sampling_rate=24000,
        hop_size=256,
        win_size=1024,
        fmin=0,
        fmax=12000,
    ).transpose(1, 2)


def codec_prefix(config, language: str | None) -> list[int]:
    """The codec tags before the speaker slot, as generation builds them: no language
    = "nothink", a language = "think" with its id (what the sidecar uses: italian)."""
    talker = config.talker_config
    if not language:
        return [talker.codec_nothink_id, talker.codec_think_bos_id, talker.codec_think_eos_id]
    return [talker.codec_think_id, talker.codec_think_bos_id, talker.codec_language_id[language], talker.codec_think_eos_id]


def collate(items: list[dict], config, language: str | None = None) -> dict:
    """Talker inputs for a batch: text channel and codec channel side by side
    (layout of dataset.py's collate_fn in Qwen's recipe, generalized to the
    language tag). Role (3) | tags + speaker + pad, text pads + bos | text,
    eos | bos | frames | codec eos."""
    talker = config.talker_config
    tags = codec_prefix(config, language) + [0, talker.codec_pad_id]  # 0: the speaker slot
    s = 3 + len(tags)  # first text token
    slot = 3 + len(tags) - 2
    lengths = [it["text_ids"].shape[1] + it["codes"].shape[0] for it in items]
    b, t = len(items), max(lengths) + s
    input_ids = torch.zeros((b, t, 2), dtype=torch.long)
    codec_ids = torch.zeros((b, t, 16), dtype=torch.long)
    text_mask = torch.zeros((b, t), dtype=torch.bool)
    codec_embed_mask = torch.zeros((b, t), dtype=torch.bool)
    codec_mask = torch.zeros((b, t), dtype=torch.bool)
    attention = torch.zeros((b, t), dtype=torch.long)
    labels = torch.full((b, t), -100, dtype=torch.long)
    for i, it in enumerate(items):
        text, codes = it["text_ids"], it["codes"]
        n_text, n_codes = text.shape[1], codes.shape[0]
        first = codes[:, 0]
        frames = s + n_text - 1  # position of the first frame
        end = frames + n_codes  # codec eos
        input_ids[i, :3, 0] = text[0, :3]
        input_ids[i, 3 : s - 1, 0] = config.tts_pad_token_id
        input_ids[i, s - 1, 0] = config.tts_bos_token_id
        input_ids[i, s : s + n_text - 3, 0] = text[0, 3:]
        input_ids[i, s + n_text - 3, 0] = config.tts_eos_token_id
        input_ids[i, s + n_text - 2 : end + 1, 0] = config.tts_pad_token_id
        text_mask[i, : end + 1] = True
        input_ids[i, 3:s, 1] = torch.tensor(tags)
        input_ids[i, s : frames - 1, 1] = talker.codec_pad_id
        input_ids[i, frames - 1, 1] = talker.codec_bos_id
        input_ids[i, frames:end, 1] = first
        input_ids[i, end, 1] = talker.codec_eos_token_id
        labels[i, frames:end] = first
        labels[i, end] = talker.codec_eos_token_id
        codec_ids[i, frames:end, :] = codes
        codec_embed_mask[i, 3 : end + 1] = True
        codec_embed_mask[i, slot] = False  # the speaker embedding's slot
        codec_mask[i, frames:end] = True
        attention[i, : end + 1] = 1
    return {
        "input_ids": input_ids,
        "codec_ids": codec_ids,
        "text_mask": text_mask.unsqueeze(-1),
        "codec_embed_mask": codec_embed_mask.unsqueeze(-1),
        "codec_mask": codec_mask,
        "attention": attention,
        "labels": labels,
        "slot": slot,
    }


def sub_loss(talker, codes: torch.Tensor, frames: torch.Tensor) -> torch.Tensor:
    """Code predictor loss: from the talker's hidden state and codebooks 0..14, codebooks 1..15.
    Its logits are already aligned with codes[:, 1:] (no shift: the model's own loss would shift)."""
    embeds = [frames.unsqueeze(1), talker.get_input_embeddings()(codes[:, :1])]
    for k in range(1, 15):
        embeds.append(talker.code_predictor.get_input_embeddings()[k - 1](codes[:, k : k + 1]))
    logits = talker.code_predictor.forward_finetune(inputs_embeds=torch.cat(embeds, dim=1)).logits
    return torch.nn.functional.cross_entropy(logits.float().reshape(-1, logits.shape[-1]), codes[:, 1:].reshape(-1))


def step_loss(model, batch: dict, speaker: torch.Tensor) -> torch.Tensor:
    talker = model.talker
    ids = batch["input_ids"]
    embeds = talker.text_projection(talker.model.text_embedding(ids[:, :, 0])) * batch["text_mask"]
    codec = talker.model.codec_embedding(ids[:, :, 1]) * batch["codec_embed_mask"]
    codec[:, batch["slot"], :] = speaker.expand(ids.shape[0], -1)
    embeds = embeds + codec
    for i in range(1, 16):
        extra = talker.code_predictor.get_input_embeddings()[i - 1](batch["codec_ids"][:, :, i])
        embeds = embeds + extra * batch["codec_mask"].unsqueeze(-1)
    # Labels sit on the positions of their own frames: the causal loss shifts them once
    out = talker(inputs_embeds=embeds, attention_mask=batch["attention"], labels=batch["labels"], output_hidden_states=True, use_cache=False)
    hidden = out.hidden_states[0][-1]
    # The hidden state that produced codec 0 of frame k is the one at the position before it
    before = torch.zeros_like(batch["codec_mask"])
    before[:, :-1] = batch["codec_mask"][:, 1:]
    return out.loss + 0.3 * sub_loss(talker, batch["codec_ids"][batch["codec_mask"]], hidden[before])


def load_rows(path: Path, processor) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf8").splitlines():
        row = json.loads(line)
        ids = processor(text=build_text(row["text"]), return_tensors="pt", padding=True)["input_ids"]
        ids = ids.unsqueeze(0) if ids.dim() == 1 else ids
        rows.append({"text_ids": ids[:, :-5], "codes": torch.tensor(row["audio_codes"], dtype=torch.long)})
    return rows


def merge(model, peft_talker, base_repo: str, out: Path, speaker_name: str, speaker: torch.Tensor, language: str) -> None:
    """Full model with the LoRA folded in, saved like sft_12hz.py's checkpoints:
    a custom_voice model whose only speaker is `speaker_name`."""
    from huggingface_hub import snapshot_download
    from safetensors.torch import save_file

    model.talker = peft_talker.merge_and_unload()
    base = Path(snapshot_download(base_repo))
    tmp = out.with_name(out.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    # Everything but the talker's weights, written below (speech_tokenizer/ keeps its own)
    shutil.copytree(base, tmp, ignore=lambda folder, names: [n for n in names if n.startswith(".") or (Path(folder) == base and n == "model.safetensors")])
    config = json.loads((base / "config.json").read_text(encoding="utf8"))
    config["tts_model_type"] = "custom_voice"
    talker = config.setdefault("talker_config", {})
    talker["spk_id"] = {speaker_name: SPEAKER_ID}
    talker["spk_is_dialect"] = {speaker_name: False}
    # Read by the sidecar: no style instruction, the speaker to use
    config["lumi_finetune"] = {"speaker": speaker_name, "base": base_repo, "language": language or "auto"}
    (tmp / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf8")
    state = {k: v.detach().to("cpu").contiguous() for k, v in model.state_dict().items() if not k.startswith("speaker_encoder")}
    weight = state["talker.model.codec_embedding.weight"]
    weight[SPEAKER_ID] = speaker[0].to(weight.dtype).cpu()
    save_file(state, str(tmp / "model.safetensors"))
    shutil.rmtree(out, ignore_errors=True)
    tmp.rename(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", default="italiano", help="dataset folder under models/lora (from lora.prepare)")
    parser.add_argument("--size", default="1.7B", choices=sorted(REPOS))
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--batch", type=int, default=2)
    parser.add_argument("--accumulate", type=int, default=8)
    parser.add_argument("--max-steps", type=int, default=0, help="stop after this many optimizer steps (a quick check)")
    parser.add_argument("--language", default="italian", help='language tag of the training sequences, the one the sidecar generates with ("" = none, as in the recipe)')
    parser.add_argument("--speaker", default="", help="speaker name in the merged model (default: --name)")
    args = parser.parse_args()
    if not torch.cuda.is_available():
        print("Serve una scheda video NVIDIA con CUDA.")
        return 1

    from peft import LoraConfig, get_peft_model
    from qwen_tts import Qwen3TTSModel

    from tts.qwen3 import patch_rope_registry

    patch_rope_registry()

    root = lora_dir(args.name)
    data = root / "data" / "train.jsonl"
    if not data.exists():
        print(f"Manca {data}: prima esegui lora.prepare --name {args.name}")
        return 1
    repo = REPOS[args.size]
    qwen = Qwen3TTSModel.from_pretrained(repo, dtype=torch.bfloat16, attn_implementation="sdpa")
    model = qwen.model.to("cuda")
    config = model.config
    rows = load_rows(data, qwen.processor)
    ref = json.loads(data.read_text(encoding="utf8").splitlines()[0])["ref_audio"]
    model.requires_grad_(False)
    model.eval()
    with torch.inference_mode():
        speaker = model.speaker_encoder(ref_mel(ref).to("cuda", torch.bfloat16)).detach().clone()
    speaker = speaker.clone()  # out of inference mode

    model.talker.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    lora = LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05, target_modules=TARGETS)
    peft_talker = get_peft_model(model.talker, lora)  # injects in place: model.talker now has the adapters
    peft_talker.print_trainable_parameters()
    model.talker.train()
    params = [p for p in model.talker.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)

    steps_per_epoch = math.ceil(len(rows) / args.batch / args.accumulate)
    total = args.max_steps or max(1, int(steps_per_epoch * args.epochs))
    warmup = max(1, total // 20)
    schedule = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda s: min(1.0, (s + 1) / warmup) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total)))
    )
    print(f"{len(rows)} clip, {total} passi (batch {args.batch} x {args.accumulate})")
    random.seed(0)
    step, micro, started, losses = 0, 0, time.monotonic(), []
    while step < total:
        order = list(range(len(rows)))
        random.shuffle(order)
        for i in range(0, len(order), args.batch):
            batch = {k: v.to("cuda") if torch.is_tensor(v) else v for k, v in collate([rows[j] for j in order[i : i + args.batch]], config, args.language).items()}
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = step_loss(model, batch, speaker)
            (loss / args.accumulate).backward()
            losses.append(loss.item())
            micro += 1
            if micro % args.accumulate:
                continue
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            optimizer.step()
            schedule.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            if step % 10 == 0 or step == total:
                mem = torch.cuda.max_memory_allocated() / 2**30
                print(f"passo {step}/{total} loss {np.mean(losses[-10 * args.accumulate:]):.3f} lr {schedule.get_last_lr()[0]:.2e} {mem:.1f} GB {time.monotonic() - started:.0f} s")
            if step % max(1, steps_per_epoch // 2) == 0:
                peft_talker.save_pretrained(str(root / "adapter"))
            if step >= total:
                break

    peft_talker.save_pretrained(str(root / "adapter"))
    model.talker.eval()
    out = root / "model"
    merge(model, peft_talker, repo, out, args.speaker or args.name, speaker, args.language)
    print(f"Modello fuso in {out}: nelle impostazioni scegli Qwen3-TTS «{args.size}, addestrato in italiano».")
    return 0


if __name__ == "__main__":
    sys.exit(main())
