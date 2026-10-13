import os
import sys
import tempfile
from pathlib import Path

# Tests never download into the user's models folder
os.environ.setdefault("LUMI_MODELS_DIR", tempfile.mkdtemp(prefix="lumi-models-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
