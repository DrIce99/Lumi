# Sourced by setup.sh and run.sh: everything that must survive a pod restart
# lives on the volume (/workspace), the caches that don't on the container disk.
export LUMI_MOTION_ROOT="${LUMI_MOTION_ROOT:-/workspace/lumi-motion}"
export HF_HOME="${HF_HOME:-/workspace/hf}"
export UV_PYTHON_INSTALL_DIR="$LUMI_MOTION_ROOT/python"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/root/.cache/uv}"
export UV_LINK_MODE=copy
export PATH="$HOME/.local/bin:$PATH"
export PYTHONUNBUFFERED=1
