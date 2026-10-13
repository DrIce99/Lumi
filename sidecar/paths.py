"""Where models and caches live: %APPDATA%\\Lumi\\models, never the repo.

`configure()` must run before importing Hugging Face, torch or other model
libraries, so that every download lands in the models folder.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

log = logging.getLogger("lumi.paths")

_models_dir: Path | None = None


def default_models_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "Lumi" / "models"


def configure(models_dir: str | None = None) -> Path:
    global _models_dir
    path = Path(models_dir or os.environ.get("LUMI_MODELS_DIR") or default_models_dir())
    path.mkdir(parents=True, exist_ok=True)
    _models_dir = path
    os.environ.setdefault("HF_HOME", str(path / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(path / "torch"))
    # Downloads progress bars garble the log
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    # Plain HTTPS downloads from the CDN: the Xet protocol can crawl on some networks
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    return path


def models_dir() -> Path:
    return _models_dir or configure()


def download(url: str, target: Path) -> Path:
    """Downloads `url` to `target` once (atomic: a partial file never looks complete)."""
    if target.exists() and target.stat().st_size > 0:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    log.info("Downloading %s", url)
    fd, tmp = tempfile.mkstemp(dir=target.parent, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url, timeout=60) as response:
            shutil.copyfileobj(response, out, length=1 << 20)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    log.info("Saved %s (%.1f MB)", target, target.stat().st_size / 1e6)
    return target
