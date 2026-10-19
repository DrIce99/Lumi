"""Generate Lumi's gesture clips with a text-to-motion model on a rented GPU.

Runs on the RunPod pod after setup.sh, with the engine's own Python:

    bash run.sh                      # Kimodo, through its environment
    bash run.sh --engine hymotion

For every gesture in gestures.json it writes out/<name>/seed<N>.npz (the
model's motion) and seed<N>.vrma (converted by motion.vrma), plus
preview.html with HY-Motion (all takes on its wooden mannequin) and
info.json. Gestures already done with the same prompt and settings are
skipped, so a stopped pod resumes where it was. At the end everything is
zipped into lumi-clips.zip for the PC.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))  # the folder that contains motion/

from motion.vrma import add_options, convert, describe, load  # noqa: E402

ROOT = Path(os.environ.get("LUMI_MOTION_ROOT", "/workspace/lumi-motion"))
MIN_SECONDS, MAX_SECONDS = 1.0, 10.0  # HY-Motion: 20-360 frames at 30 fps; Kimodo: up to 10 s


class HyMotion:
    """Tencent HY-Motion 1.0 through its own runtime (no prompt rewriter: our prompts are already English)."""

    name = "hymotion"

    def __init__(self, repo: Path, model: str, cfg: float, steps: int | None):
        os.chdir(repo)  # its configs and text encoders use paths relative to the repo
        sys.path.insert(0, str(repo))
        from hymotion.utils.t2m_runtime import T2MRuntime

        model_dir = repo / "ckpts" / "tencent" / model
        self.runtime = T2MRuntime(
            config_path=str(model_dir / "config.yml"),
            ckpt_name=str(model_dir / "latest.ckpt"),
            disable_prompt_engineering=True,
        )
        if steps:
            for pipeline in self.runtime.pipelines:
                pipeline.validation_steps = steps
        self.cfg = cfg
        self.label = f"{model}, cfg {cfg}" + (f", {steps} steps" if steps else "")

    def generate(self, prompt: str, seconds: float, seeds: list[int], out: Path, batch: int) -> list[Path]:
        files: list[Path] = []
        for start in range(0, len(seeds), batch):
            chunk = seeds[start : start + batch]
            work = f"output/lumi/{out.name}"  # relative: its writer refuses paths outside the repo
            html, _, _ = self.runtime.generate_motion(
                text=prompt,
                seeds_csv=",".join(map(str, chunk)),
                duration=seconds,
                cfg_scale=self.cfg,
                output_format="dict",
                output_dir=work,
                output_filename="take",
            )
            for i, seed in enumerate(chunk):
                dst = out / f"seed{seed}.npz"
                shutil.move(os.path.join(work, f"take_{i:03d}.npz"), dst)
                files.append(dst)
            name = "preview.html" if len(seeds) <= batch else f"preview-{chunk[0]}.html"
            (out / name).write_text(html, encoding="utf-8")
            shutil.rmtree(work, ignore_errors=True)
        return files


class Kimodo:
    """NVIDIA Kimodo: SOMA (default, fingers included) or SMPL-X models; G1 is a robot."""

    name = "kimodo"

    def __init__(self, model: str, cfg: float | None, steps: int | None):
        import numpy as np
        import torch
        from kimodo import load_model

        if "g1" in model.lower():
            raise SystemExit("Kimodo G1 is a robot skeleton: use a SOMA or SMPL-X model")
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        self.model, resolved = load_model(model, device=device, default_family="Kimodo", return_resolved_name=True)
        # The rest pose goes into every file: motion.vrma needs it for SOMA (77 joints)
        sk = self.model.output_skeleton
        self.skeleton = {
            "joint_names": np.array(list(sk.bone_order_names)),
            "parents": sk.joint_parents.detach().cpu().numpy(),
            "neutral_joints": sk.neutral_joints.detach().cpu().numpy(),
        }
        self.steps = steps or 100
        self.cfg = {"cfg_type": "regular", "cfg_weight": cfg} if cfg else {}
        self.label = f"{resolved}, {self.steps} steps" + (f", cfg {cfg}" if cfg else "")

    def generate(self, prompt: str, seconds: float, seeds: list[int], out: Path, batch: int) -> list[Path]:
        import numpy as np
        from kimodo.tools import seed_everything

        files: list[Path] = []
        frames = int(round(seconds * self.model.fps))
        for seed in seeds:
            seed_everything(seed)
            result = self.model(
                [prompt],
                [frames],
                constraint_lst=[],
                num_denoising_steps=self.steps,
                num_samples=1,
                multi_prompt=True,
                post_processing=True,
                return_numpy=True,
                **self.cfg,
            )
            dst = out / f"seed{seed}.npz"
            np.savez_compressed(
                dst,
                local_rot_mats=np.asarray(result["local_rot_mats"])[0],
                root_positions=np.asarray(result["root_positions"])[0],
                fps=np.array([float(self.model.fps)]),
                **self.skeleton,
            )
            files.append(dst)
        return files


def gestures(path: Path, only: set[str]) -> list[dict]:
    spec = json.loads(path.read_text(encoding="utf-8"))
    defaults = spec.get("defaults", {})
    out = []
    for g in spec["gestures"]:
        g = {**defaults, **g}
        if not g["name"].replace("_", "").isalnum() or g["name"] != g["name"].lower():
            raise SystemExit(f"gesture name {g['name']!r}: lower case letters, digits and _ only")
        if only and g["name"] not in only:
            continue
        g["duration"] = min(MAX_SECONDS, max(MIN_SECONDS, float(g.get("duration", 3.0))))
        out.append(g)
    missing = only - {g["name"] for g in out}
    if missing:
        raise SystemExit(f"not in {path.name}: {', '.join(sorted(missing))}")
    return out


def pack(out: Path, dst: Path) -> None:
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out.parent))


def main() -> int:
    p = argparse.ArgumentParser(description="Text-to-motion gesture clips for Lumi")
    p.add_argument("--engine", choices=("kimodo", "hymotion"), default="kimodo")
    p.add_argument(
        "--model", help="Kimodo: kimodo-soma-rp (default, the latest SOMA); HY-Motion-1.0 (default) or HY-Motion-1.0-Lite"
    )
    p.add_argument("--gestures", type=Path, default=HERE / "gestures.json")
    p.add_argument("--out", type=Path, default=ROOT / "out")
    p.add_argument("--only", default="", help="comma separated gesture names")
    p.add_argument("--seeds", type=int, help="takes per gesture (overrides gestures.json)")
    p.add_argument("--batch", type=int, default=4, help="HY-Motion takes generated together (less = less VRAM)")
    p.add_argument("--cfg", type=float, help="guidance scale (HY-Motion default 5.0)")
    p.add_argument("--steps", type=int, help="denoising steps (HY-Motion 50, Kimodo 100 by default)")
    p.add_argument("--force", action="store_true", help="redo gestures already generated")
    add_options(p)
    args = p.parse_args()

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    todo = gestures(args.gestures.resolve(), {s.strip() for s in args.only.split(",") if s.strip()})

    if args.engine == "hymotion":
        engine = HyMotion(ROOT / "HY-Motion-1.0", args.model or "HY-Motion-1.0", args.cfg or 5.0, args.steps)
    else:
        engine = Kimodo(args.model or "kimodo-soma-rp", args.cfg, args.steps)
    print(f">>> {engine.name}: {engine.label}; {len(todo)} gestures -> {out}")

    convert_opts = {"root": args.root, "facing": args.facing, "up": args.up, "hands": args.hands}
    failed: list[str] = []
    for g in todo:
        gdir = out / g["name"]
        count = args.seeds or int(g.get("seeds", 4))
        settings = {"engine": engine.name, "model": engine.label, "prompt": g["prompt"], "duration": g["duration"]}
        info_path = gdir / "info.json"
        if info_path.exists() and not args.force:
            old = json.loads(info_path.read_text(encoding="utf-8"))
            if all(old.get(k) == v for k, v in settings.items()) and len(old.get("takes", [])) >= count:
                print(f"--- {g['name']}: already done")
                continue
        shutil.rmtree(gdir, ignore_errors=True)
        gdir.mkdir(parents=True)
        seeds = [int(s) for s in g["seed_list"]] if "seed_list" in g else random.sample(range(1000, 10000), count)
        print(f">>> {g['name']} ({g['duration']:.1f} s, seeds {seeds}): {g['prompt']}")
        started = time.time()
        try:
            files = engine.generate(g["prompt"], g["duration"], seeds, gdir, max(1, args.batch))
        except Exception as err:  # one bad prompt (or an OOM) must not lose the others
            print(f"!!! {g['name']}: {err}")
            failed.append(g["name"])
            import torch

            torch.cuda.empty_cache()
            continue
        takes = []
        for f in files:
            data, report = convert(load(f), **convert_opts)
            f.with_suffix(".vrma").write_bytes(data)
            takes.append({"file": f.with_suffix(".vrma").name, "seed": int(f.stem[4:]), "summary": describe(report)})
            print(f"    {f.stem}: {describe(report)}")
        info = {**settings, "convert": convert_opts, "seconds": round(time.time() - started, 1), "takes": takes}
        info_path.write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")

    archive = out.parent / "lumi-clips.zip"
    pack(out, archive)
    print(f">>> {archive} ({archive.stat().st_size / 1e6:.1f} MB)")
    if failed:
        print(f"!!! failed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
