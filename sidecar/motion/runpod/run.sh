#!/usr/bin/env bash
# Runs generate.py with the Python environment of the engine it is asked for:
#   bash run.sh                      # Kimodo (SOMA), every gesture in gestures.json
#   bash run.sh --engine hymotion --only laugh,yawn --seeds 2
# All the options: bash run.sh --help
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

engine=kimodo  # generate.py's default too
prev=""
for arg in "$@"; do
  case "$arg" in
    --engine=*) engine="${arg#--engine=}" ;;
  esac
  [ "$prev" = "--engine" ] && engine="$arg"
  prev="$arg"
done

python="$LUMI_MOTION_ROOT/venvs/$engine/bin/python"
if [ ! -x "$python" ]; then
  echo "$engine is not installed: bash $HERE/setup.sh $engine" >&2
  exit 1
fi
exec "$python" "$HERE/generate.py" "$@"
