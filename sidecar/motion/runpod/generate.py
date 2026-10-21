"""Generate Lumi's gesture clips and idle routines with a text-to-motion model.

Runs on the RunPod pod after setup.sh, or on the PC with ../local.ps1:

    bash run.sh                      # Kimodo, through its environment
    bash run.sh --engine hymotion    # gestures only
    bash run.sh --reconvert          # redo the .vrma from the .npz already there (no model)

gestures.json has two lists. A gesture becomes out/<name>/seed<N>.npz (the
model's motion) and seed<N>.vrma, plus info.json (and preview.html with
HY-Motion). An idle routine becomes out/idle/<name>/seed<N>.npz and the
folder out/idle/<name>/seed<N>/ with enter.vrma, loop.vrma, exit.vrma and
routine.json: copied as it is to %APPDATA%\\Lumi\\animations\\idle\\<name>\\.

Idle parts are generated one after the other with Kimodo's full-body
keyframe constraints: the enter starts on a second of standing still made
first; the loop starts and ends on the last 5 frames of the enter part (so
it repeats without a jump); the exit starts on them too and ends standing
still again. The three are joined and converted together, then cut.

Entries already done with the same prompts and settings are skipped, so a
stopped pod resumes where it was. Everything is zipped into lumi-clips.zip.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))  # the folder that contains motion/

from motion.vrma import (  # noqa: E402
    HAND_SHAPES,
    add_options,
    convert,
    convert_parts,
    describe,
    load,
    options_from,
    turn_ramp,
)

ROOT = Path(os.environ.get("LUMI_MOTION_ROOT", "/workspace/lumi-motion"))
MIN_SECONDS, MAX_SECONDS = 1.0, 10.0  # HY-Motion: 20-360 frames at 30 fps; Kimodo: up to 10 s per prompt
PARTS = ("enter", "loop", "exit")
JOIN = 5  # frames shared by consecutive idle parts (Kimodo's own transitions use 5)
ENTRY_OPTIONS = ("root", "facing", "turn", "hands")  # conversion options an entry may set
STAND = "A person stands still in a relaxed pose, the arms at the sides."  # where idle routines start and end


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

    def idle(self, parts: list[dict], seed: int, dst: Path, travels: bool = False) -> list[tuple[int, int]]:
        raise RuntimeError("idle routines need Kimodo (pose constraints join their parts)")


class Kimodo:
    """NVIDIA Kimodo: SOMA (default) or SMPL-X models; G1 is a robot."""

    name = "kimodo"

    def __init__(self, model: str, cfg: float | None, steps: int | None):
        import torch
        from kimodo import load_model

        if "g1" in model.lower():
            raise SystemExit("Kimodo G1 is a robot skeleton: use a SOMA or SMPL-X model")
        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        self.model, resolved = load_model(model, device=self.device, default_family="Kimodo", return_resolved_name=True)
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

    def _run(self, prompt: str, frames: int, constraints: list, heading: float | None = None):
        result = self.model(
            [prompt],
            [frames],
            constraint_lst=constraints,
            num_denoising_steps=self.steps,
            num_samples=1,
            multi_prompt=True,
            post_processing=True,
            return_numpy=True,
            first_heading_angle=heading,
            **self.cfg,
        )
        return np.asarray(result["local_rot_mats"])[0], np.asarray(result["root_positions"])[0]

    def _save(self, dst: Path, rots: np.ndarray, pos: np.ndarray, **extra) -> None:
        np.savez_compressed(
            dst, local_rot_mats=rots, root_positions=pos, fps=np.array([float(self.model.fps)]), **self.skeleton, **extra
        )

    def generate(self, prompt: str, seconds: float, seeds: list[int], out: Path, batch: int) -> list[Path]:
        from kimodo.tools import seed_everything

        files: list[Path] = []
        for seed in seeds:
            seed_everything(seed)
            rots, pos = self._run(prompt, int(round(seconds * self.model.fps)), [])
            dst = out / f"seed{seed}.npz"
            self._save(dst, rots, pos)
            files.append(dst)
        return files

    def _from_pose(self, prompt: str, frames: int, rots: np.ndarray, pos: np.ndarray, end: tuple[np.ndarray, np.ndarray] | None):
        """A part that starts on the given frames (local rotations + root positions) and, with `end`, finishes on
        those (the loop: the same frames again; the exit: standing as the routine began)."""
        import torch
        from kimodo.constraints import FullBodyConstraintSet
        from kimodo.geometry import matrix_to_axis_angle

        # As in Kimodo's own transitions: the pose moved to the origin on the floor, its heading kept
        offset = pos[0].copy()
        offset[1] = 0.0
        k = len(rots)
        index = list(range(k)) + (list(range(frames - k, frames)) if end is not None else [])
        r = np.concatenate([rots, end[0]]) if end is not None else rots
        p = np.concatenate([pos, end[1]]) if end is not None else pos
        aa = matrix_to_axis_angle(torch.tensor(r, dtype=torch.float32))
        constraint = FullBodyConstraintSet.from_dict(
            self.model.skeleton,
            {"frame_indices": index, "local_joints_rot": aa.tolist(), "root_positions": (p - offset).tolist()},
        ).to(self.device)
        heading = constraint.global_root_heading[0]
        angle = float(torch.atan2(heading[1], heading[0]))
        out_rots, out_pos = self._run(prompt, frames, [constraint], heading=angle)
        return out_rots, out_pos + offset

    def idle(self, parts: list[dict], seed: int, dst: Path, travels: bool = False) -> list[tuple[int, int]]:
        """enter, loop, exit joined into one motion saved at dst; returns each part's frames [start, end).
        `travels` (a walk): the loop ends on the same pose further on, at the pace the enter reached."""
        from kimodo.tools import seed_everything

        seed_everything(seed)
        fps = self.model.fps
        n = [int(round(p["duration"] * fps)) for p in parts]
        # A second of standing still: the enter starts on it and the exit ends on it. Left alone, the model
        # began "kneels down and lies on the stomach" already on the floor, and an exit stayed there
        stand_r, stand_p = self._run(STAND, int(fps), [])
        stand_r, stand_p = stand_r[-JOIN:], stand_p[-JOIN:]
        enter_r, enter_p = self._from_pose(parts[0]["prompt"], n[0], stand_r, stand_p, end=None)
        tail_r, tail_p = enter_r[-JOIN:], enter_p[-JOIN:]
        loop_end = tail_p.copy()
        if travels:
            # Same pose, further on: without it the loop had to end where it began, and she marched on the spot
            half = max(JOIN + 1, int(fps / 2))
            pace = (enter_p[-1, [0, 2]] - enter_p[-half, [0, 2]]) / ((half - 1) / fps)
            loop_end[:, [0, 2]] += pace * (n[1] - JOIN) / fps
        loop_r, loop_p = self._from_pose(parts[1]["prompt"], n[1], tail_r, tail_p, end=(tail_r, loop_end))
        # Standing again where she is
        home_p = stand_p.copy()
        home_p[:, [0, 2]] += tail_p[-1, [0, 2]] - stand_p[0, [0, 2]]
        exit_r, exit_p = self._from_pose(parts[2]["prompt"], n[2], tail_r, tail_p, end=(stand_r, home_p))
        # The loop's and the exit's first JOIN frames repeat the end of the enter part
        rots = np.concatenate([enter_r, loop_r[JOIN:], exit_r[JOIN:]])
        pos = np.concatenate([enter_p, loop_p[JOIN:], exit_p[JOIN:]])
        a = n[0]
        b = a + n[1] - JOIN
        # loop: from the enter's last frame to the loop's last (the same pose): it repeats seamlessly
        bounds = [(0, a), (a - 1, b), (b - 1, len(rots))]
        self._save(dst, rots, pos, parts=np.array(bounds), part_names=np.array(PARTS))
        return bounds


def check_name(name: str) -> None:
    if not name.replace("_", "").isalnum() or name != name.lower():
        raise SystemExit(f"name {name!r}: lower case letters, digits and _ only")


def check_options(entry: dict) -> dict:
    """The conversion options an entry sets: root, facing, turn, hands (model fingers) and shapes (from 'hand_shapes')."""
    opts = {k: entry[k] for k in ENTRY_OPTIONS if k in entry}
    shapes = entry.get("hand_shapes", {})
    for side, shape in shapes.items():
        if side not in ("left", "right") or shape not in HAND_SHAPES:
            raise SystemExit(f"{entry['name']}: hand_shapes {side}={shape}: left|right = one of {', '.join(HAND_SHAPES)}")
    if shapes:
        opts["shapes"] = shapes
    return opts


def seconds(value) -> float:
    return min(MAX_SECONDS, max(MIN_SECONDS, float(value)))


def read_spec(path: Path, only: set[str]) -> tuple[list[dict], list[dict]]:
    spec = json.loads(path.read_text(encoding="utf-8"))
    defaults = spec.get("defaults", {})
    gestures, idles = [], []
    for g in spec.get("gestures", []):
        g = {**defaults, **g}
        check_name(g["name"])
        g["duration"] = seconds(g.get("duration", 3.0))
        g["options"] = check_options(g)
        if not only or g["name"] in only:
            gestures.append(g)
    for i in spec.get("idles", []):
        i = {**defaults, **i}
        check_name(i["name"])
        missing = [p for p in PARTS if p not in i]
        if missing:
            raise SystemExit(f"idle {i['name']}: no {', '.join(missing)}")
        for p in PARTS:
            i[p] = {"prompt": i[p]["prompt"], "duration": seconds(i[p].get("duration", 4.0))}
        if i["loop"]["duration"] * 30 < 3 * JOIN:
            raise SystemExit(f"idle {i['name']}: the loop is too short")
        i["options"] = check_options(i)
        if not only or i["name"] in only or f"idle_{i['name']}" in only:
            idles.append(i)
    found = {g["name"] for g in gestures} | {i["name"] for i in idles} | {f"idle_{i['name']}" for i in idles}
    missing = only - found
    if missing:
        raise SystemExit(f"not in {path.name}: {', '.join(sorted(missing))}")
    return gestures, idles


def pack(out: Path, dst: Path) -> None:
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out.parent))


def already_done(info_path: Path, settings: dict, count: int) -> bool:
    if not info_path.exists():
        return False
    old = json.loads(info_path.read_text(encoding="utf-8"))
    return all(old.get(k) == v for k, v in settings.items()) and len(old.get("takes", [])) >= count


def convert_gesture(npz: Path, opts: dict) -> dict:
    data, report = convert(load(npz), **opts)
    npz.with_suffix(".vrma").write_bytes(data)
    return {"file": npz.with_suffix(".vrma").name, "seed": int(npz.stem[4:]), "summary": describe(report)}


def convert_idle(npz: Path, idle: dict, opts: dict) -> dict:
    """seed<N>.npz -> seed<N>/enter.vrma, loop.vrma, exit.vrma, routine.json."""
    with np.load(npz) as z:
        bounds = [tuple(int(x) for x in b) for b in z["parts"]]
    m = load(npz)
    cuts = [(name, a, b) for name, (a, b) in zip(PARTS, bounds)]
    if opts.get("turn"):
        # An idle's turn comes in while it enters and goes while it exits (a lying body seen from the side)
        opts = {**opts, "turn": turn_ramp(cuts, m.frames, float(opts["turn"]))}
    parts, report = convert_parts(m, cuts, **opts)
    folder = npz.with_suffix("")
    folder.mkdir(exist_ok=True)
    for name, data in parts.items():
        (folder / f"{name}.vrma").write_bytes(data)
    routine = {
        **idle.get("routine", {}),
        "seconds": {name: round((b - a) / m.fps, 2) for name, (a, b) in zip(PARTS, bounds)},
    }
    if routine.get("walk"):
        # How fast the loop walks before it was kept in place, in hips heights per second: the app
        # scales it to its own model and moves the window along at that pace
        a, b = bounds[1]
        xz = m.pos[a:b][:, [0, 2]]
        speed = float(np.linalg.norm(np.diff(xz, axis=0), axis=-1).sum()) / ((b - a) / m.fps)
        routine["walkSpeed"] = round(speed / m.skeleton.hips_height(), 3)
    (folder / "routine.json").write_text(json.dumps(routine, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"folder": folder.name, "seed": int(npz.stem[4:]), "summary": describe(report)}


def main() -> int:
    p = argparse.ArgumentParser(description="Text-to-motion gesture clips and idle routines for Lumi")
    p.add_argument("--engine", choices=("kimodo", "hymotion"), default="kimodo")
    p.add_argument(
        "--model", help="Kimodo: kimodo-soma-rp (default, the latest SOMA); HY-Motion-1.0 (default) or HY-Motion-1.0-Lite"
    )
    p.add_argument("--gestures", type=Path, default=HERE / "gestures.json")
    p.add_argument("--out", type=Path, default=ROOT / "out")
    p.add_argument("--only", default="", help="comma separated names (gestures or idles)")
    p.add_argument("--seeds", type=int, help="takes per entry (overrides gestures.json)")
    p.add_argument("--batch", type=int, default=4, help="HY-Motion takes generated together (less = less VRAM)")
    p.add_argument("--cfg", type=float, help="guidance scale (HY-Motion default 5.0)")
    p.add_argument("--steps", type=int, help="denoising steps (HY-Motion 50, Kimodo 100 by default)")
    p.add_argument("--force", action="store_true", help="redo entries already generated")
    p.add_argument("--reconvert", action="store_true", help="only convert the .npz already there again (no model)")
    add_options(p)
    args = p.parse_args()
    base = options_from(args)

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Commas or spaces: PowerShell turns an unquoted a,b,c into "a b c"
    gestures, idles = read_spec(args.gestures.resolve(), {s for s in re.split(r"[,\s]+", args.only) if s})
    failed: list[str] = []

    if args.reconvert:
        for g in gestures:
            for npz in sorted((out / g["name"]).glob("seed*.npz")):
                print(f"{g['name']}/{npz.stem}: {convert_gesture(npz, {**base, **g['options']})['summary']}")
        for i in idles:
            for npz in sorted((out / "idle" / i["name"]).glob("seed*.npz")):
                print(f"idle {i['name']}/{npz.stem}: {convert_idle(npz, i, {**base, **i['options']})['summary']}")
        return 0

    if args.engine == "hymotion":
        engine = HyMotion(ROOT / "HY-Motion-1.0", args.model or "HY-Motion-1.0", args.cfg or 5.0, args.steps)
    else:
        engine = Kimodo(args.model or "kimodo-soma-rp", args.cfg, args.steps)
    print(f">>> {engine.name}: {engine.label}; {len(gestures)} gestures, {len(idles)} idles -> {out}")

    def fail(name: str, err: Exception) -> None:  # one bad prompt (or an OOM) must not lose the others
        print(f"!!! {name}: {err}")
        failed.append(name)
        import torch

        torch.cuda.empty_cache()

    for g in gestures:
        gdir = out / g["name"]
        count = args.seeds or int(g.get("seeds", 4))
        settings = {"engine": engine.name, "model": engine.label, "prompt": g["prompt"], "duration": g["duration"]}
        if already_done(gdir / "info.json", settings, count) and not args.force:
            print(f"--- {g['name']}: already done")
            continue
        shutil.rmtree(gdir, ignore_errors=True)
        gdir.mkdir(parents=True)
        seeds = [int(s) for s in g["seed_list"]] if "seed_list" in g else random.sample(range(1000, 10000), count)
        print(f">>> {g['name']} ({g['duration']:.1f} s, seeds {seeds}): {g['prompt']}")
        started = time.time()
        try:
            files = engine.generate(g["prompt"], g["duration"], seeds, gdir, max(1, args.batch))
        except Exception as err:
            fail(g["name"], err)
            continue
        opts = {**base, **g["options"]}
        takes = []
        for f in files:
            takes.append(convert_gesture(f, opts))
            print(f"    {f.stem}: {takes[-1]['summary']}")
        info = {**settings, "convert": opts, "seconds": round(time.time() - started, 1), "takes": takes}
        (gdir / "info.json").write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")

    for i in idles:
        idir = out / "idle" / i["name"]
        count = args.seeds or int(i.get("seeds", 3))
        settings = {"engine": engine.name, "model": engine.label, **{part: i[part] for part in PARTS}}
        if already_done(idir / "info.json", settings, count) and not args.force:
            print(f"--- idle {i['name']}: already done")
            continue
        shutil.rmtree(idir, ignore_errors=True)
        idir.mkdir(parents=True)
        seeds = [int(s) for s in i["seed_list"]] if "seed_list" in i else random.sample(range(1000, 10000), count)
        print(f">>> idle {i['name']} (seeds {seeds})")
        for part in PARTS:
            print(f"    {part} ({i[part]['duration']:.1f} s): {i[part]['prompt']}")
        started = time.time()
        opts = {**base, **i["options"]}
        takes = []
        for seed in seeds:
            npz = idir / f"seed{seed}.npz"
            try:
                engine.idle([i[part] for part in PARTS], seed, npz, travels=bool(i.get("routine", {}).get("walk")))
            except Exception as err:
                fail(f"idle {i['name']} seed {seed}", err)
                continue
            takes.append(convert_idle(npz, i, opts))
            print(f"    seed{seed}: {takes[-1]['summary']}")
        info = {**settings, "convert": opts, "seconds": round(time.time() - started, 1), "takes": takes}
        (idir / "info.json").write_text(json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")

    archive = out.parent / "lumi-clips.zip"
    pack(out, archive)
    print(f">>> {archive} ({archive.stat().st_size / 1e6:.1f} MB)")
    if failed:
        print(f"!!! failed: {', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
