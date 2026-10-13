"""GPU detection and CUDA libraries on Windows.

faster-whisper (CTranslate2) needs cuBLAS for CUDA 12. torch ships it in
torch/lib, the NVIDIA pip wheels in nvidia/*/bin: those folders are added
to the DLL search path before any engine loads.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

log = logging.getLogger("lumi.devices")

_prepared = False


def prepare_cuda_dlls() -> list[str]:
    global _prepared
    if _prepared or sys.platform != "win32":
        return []
    _prepared = True
    dirs: list[Path] = []
    spec = importlib.util.find_spec("torch")
    if spec and spec.origin:
        lib = Path(spec.origin).parent / "lib"
        if lib.is_dir():
            dirs.append(lib)
    for site in {Path(p) for p in sys.path if p.endswith("site-packages")}:
        dirs.extend(sorted((site / "nvidia").glob("*/bin")))
    for d in dirs:
        try:
            os.add_dll_directory(str(d))
        except OSError:
            continue
        os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
    if dirs:
        log.info("CUDA libraries from %s", ", ".join(str(d) for d in dirs))
    return [str(d) for d in dirs]


@lru_cache(maxsize=1)
def cuda_available() -> bool:
    prepare_cuda_dlls()
    if importlib.util.find_spec("torch"):
        try:
            import torch

            return bool(torch.cuda.is_available())
        except Exception as err:  # broken CUDA install
            log.warning("torch can't use CUDA: %s", err)
            return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def resolve_device(requested: str) -> str:
    """'auto' becomes 'cuda' when a GPU is usable."""
    if requested == "cpu":
        return "cpu"
    if cuda_available():
        return "cuda"
    if requested == "cuda":
        log.warning("CUDA requested but not available: using the CPU")
    return "cpu"


def gpu_info() -> dict | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    best = None
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            gpu = {"name": parts[0], "vramTotalMb": int(float(parts[1])), "vramFreeMb": int(float(parts[2]))}
        except ValueError:
            continue
        if not best or gpu["vramTotalMb"] > best["vramTotalMb"]:
            best = gpu
    return best


def installed(*modules: str) -> list[str]:
    return [m for m in modules if importlib.util.find_spec(m) is not None]
