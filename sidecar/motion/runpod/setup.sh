#!/usr/bin/env bash
# Installs the text-to-motion engines on a RunPod pod, once per volume.
#
#   bash setup.sh                 # Kimodo (SOMA): the default
#   bash setup.sh hymotion        # Tencent HY-Motion 1.0 (see the license note in README.md)
#   bash setup.sh kimodo hymotion # both
#   bash setup.sh hymotion --lite # HY-Motion-1.0-Lite weights instead of the full model
#
# Each engine gets its own Python environment (they pin different torch and
# transformers versions) under $LUMI_MOTION_ROOT/venvs. Running it again
# updates the code and skips what is already there.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

engines=()
lite=0
for arg in "$@"; do
  case "$arg" in
    hymotion|kimodo) engines+=("$arg") ;;
    --lite) lite=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ ${#engines[@]} -eq 0 ] && engines=(kimodo)

ROOT="$LUMI_MOTION_ROOT"
mkdir -p "$ROOT/venvs" "$HF_HOME"

say() { printf '\n>>> %s\n' "$*"; }

need_apt=()
command -v git >/dev/null || need_apt+=(git)
command -v git-lfs >/dev/null || need_apt+=(git-lfs)
command -v zip >/dev/null || need_apt+=(zip)
if [[ " ${engines[*]} " == *" kimodo "* ]]; then
  command -v cmake >/dev/null || need_apt+=(cmake)
  command -v g++ >/dev/null || need_apt+=(build-essential)
fi
if [ ${#need_apt[@]} -gt 0 ]; then
  say "apt: ${need_apt[*]}"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need_apt[@]}"
fi

if ! command -v uv >/dev/null; then
  say "uv"
  curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
fi

say "GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || echo "no GPU visible!"

setup_hymotion() {
  local repo="$ROOT/HY-Motion-1.0" venv="$ROOT/venvs/hymotion"
  say "HY-Motion: code"
  if [ -d "$repo/.git" ]; then
    git -C "$repo" pull --ff-only
  else
    GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/Tencent-Hunyuan/HY-Motion-1.0.git "$repo"
  fi
  git -C "$repo" lfs install --local
  git -C "$repo" lfs pull  # stats/Mean.npy, Std.npy and the preview's mannequin

  say "HY-Motion: Python environment"
  [ -x "$venv/bin/python" ] || uv venv --python 3.11 "$venv"
  # FBX export (fbxsdkpy, from an extra index) is not needed: we write .vrma
  grep -v -E '^(--extra-index-url|fbxsdkpy)' "$repo/requirements.txt" > "$ROOT/hymotion-requirements.txt"
  uv pip install --python "$venv/bin/python" -r "$ROOT/hymotion-requirements.txt"

  say "HY-Motion: weights (motion model, Qwen3-8B and CLIP text encoders: about 20 GB)"
  "$venv/bin/python" - "$repo" "$lite" <<'PY'
import sys
from huggingface_hub import snapshot_download

repo, lite = sys.argv[1], sys.argv[2] == "1"
model = "HY-Motion-1.0-Lite" if lite else "HY-Motion-1.0"
snapshot_download("tencent/HY-Motion-1.0", allow_patterns=[f"{model}/*"], local_dir=f"{repo}/ckpts/tencent")
# Its text encoder reads ckpts/<name> unless USE_HF_MODELS=1
snapshot_download("Qwen/Qwen3-8B", allow_patterns=["*.json", "*.safetensors", "*.txt"], local_dir=f"{repo}/ckpts/Qwen3-8B")
snapshot_download(
    "openai/clip-vit-large-patch14",
    allow_patterns=["*.json", "*.txt", "model.safetensors"],
    local_dir=f"{repo}/ckpts/clip-vit-large-patch14",
)
print("weights ready:", model)
PY
  "$venv/bin/python" -c "import torch; assert torch.cuda.is_available(), 'torch sees no GPU'; print('torch', torch.__version__, torch.cuda.get_device_name(0))"
}

setup_kimodo() {
  local venv="$ROOT/venvs/kimodo"
  say "Kimodo: Python environment"
  [ -x "$venv/bin/python" ] || uv venv --python 3.10 "$venv"
  # torch for the pod's driver first, then Kimodo (it builds its C++ motion correction)
  uv pip install --python "$venv/bin/python" --torch-backend auto torch
  uv pip install --python "$venv/bin/python" --reinstall-package kimodo "kimodo @ git+https://github.com/nv-tlabs/kimodo.git"
  "$venv/bin/python" -c "import torch; assert torch.cuda.is_available(), 'torch sees no GPU'; print('torch', torch.__version__, torch.cuda.get_device_name(0))"

  if [ -z "${HF_TOKEN:-}" ] && [ ! -s "$HF_HOME/token" ]; then
    cat <<'MSG'

!!! Kimodo's text encoder is meta-llama/Meta-Llama-3-8B-Instruct, a gated model:
    request access on its Hugging Face page, then either set HF_TOKEN in the
    pod's environment variables or run:
      source env.sh && /workspace/lumi-motion/venvs/kimodo/bin/hf auth login
    The Kimodo weights and the text encoder download at the first generation.
MSG
  fi
}

for engine in "${engines[@]}"; do
  "setup_$engine"
done

say "done. Generate with: bash $HERE/run.sh --engine ${engines[0]}"
