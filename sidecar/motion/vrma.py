"""Text-to-motion clips (HY-Motion, Kimodo, AMASS) -> VRM Animation (.vrma).

Roadmap 19.3: clips generated offline by text-to-motion models become
gestures for the 3D avatar (%APPDATA%\\Lumi\\animations\\<gesture>.vrma).

Why the rotations copy over almost as they are: the source skeletons (SMPL,
SMPL-H, SMPL-X, and Kimodo's SOMA in its "standard T-pose" frame) rest in a
T-pose whose joint frames are all aligned with the world (Y up, facing +Z,
the character's left on +X), and so do a VRM 1.0 model's normalized bones.
A joint's local rotation in the source is therefore the normalized bone's
local rotation in VRM; joints VRM doesn't have (SOMA's second neck joint,
its finger metacarpals) are folded into the next bone down the chain. The
.vrma written here has identity rest rotations on every node, so
three-vrm-animation applies the tracks unchanged, and it rescales the hips
translation by the ratio of the hips heights.

What the conversion still does: picks the up axis (AMASS is Z up), turns the
clip to face the camera, keeps Lumi in place (the window frames her from the
waist up), and puts the floor under the lowest joint of the clip.

Pure numpy, no torch: it runs on the rented GPU right after generation and
on the PC for files downloaded by hand (`python -m motion.vrma`).
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# VRM humanoid bones this converter writes, each after its parent.
VRM_PARENT: dict[str, str | None] = {
    "hips": None, "spine": "hips", "chest": "spine", "upperChest": "chest", "neck": "upperChest",
    "head": "neck",
}  # fmt: skip
for _s in ("left", "right"):
    VRM_PARENT |= {
        f"{_s}UpperLeg": "hips", f"{_s}LowerLeg": f"{_s}UpperLeg", f"{_s}Foot": f"{_s}LowerLeg",
        f"{_s}Toes": f"{_s}Foot", f"{_s}Shoulder": "upperChest", f"{_s}UpperArm": f"{_s}Shoulder",
        f"{_s}LowerArm": f"{_s}UpperArm", f"{_s}Hand": f"{_s}LowerArm",
    }  # fmt: skip
for _s in ("left", "right"):
    for _f in ("Thumb", "Index", "Middle", "Ring", "Little"):
        _parts = ("Metacarpal", "Proximal", "Distal") if _f == "Thumb" else ("Proximal", "Intermediate", "Distal")
        _up = f"{_s}Hand"
        for _p in _parts:
            VRM_PARENT[f"{_s}{_f}{_p}"] = _up
            _up = f"{_s}{_f}{_p}"
FINGER_BONES = {b for b in VRM_PARENT if any(f in b for f in ("Thumb", "Index", "Middle", "Ring", "Little"))}

# SMPL body joints (SMPL, SMPL-H, SMPL-X and Kimodo's smplx22 share the first 22).
SMPL_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19]
SMPL_BODY = [
    "hips", "leftUpperLeg", "rightUpperLeg", "spine", "leftLowerLeg", "rightLowerLeg",
    "chest", "leftFoot", "rightFoot", "upperChest", "leftToes", "rightToes",
    "neck", "leftShoulder", "rightShoulder", "head", "leftUpperArm", "rightUpperArm",
    "leftLowerArm", "rightLowerArm", "leftHand", "rightHand",
]  # fmt: skip
# Joint positions of the neutral SMPL body at rest (meters). Only used for the
# nodes' rest offsets and to find the floor: the rotations don't depend on it.
SMPL_REST = np.array([
    [-0.0018, -0.2233, 0.0282], [0.0695, -0.3141, 0.0239], [-0.0677, -0.3147, 0.0214],
    [-0.0025, -0.1037, 0.0119], [0.1043, -0.6895, 0.0167], [-0.1056, -0.6941, 0.0153],
    [0.0054, 0.0247, 0.0016], [0.0889, -1.0918, -0.0277], [-0.0918, -1.0950, -0.0254],
    [0.0019, 0.0732, 0.0283], [0.1188, -1.1468, 0.0912], [-0.1196, -1.1488, 0.0965],
    [-0.0015, 0.2885, -0.0123], [0.0767, 0.2004, -0.0098], [-0.0777, 0.2004, -0.0096],
    [0.0013, 0.3540, 0.0386], [0.1975, 0.2357, -0.0174], [-0.1922, 0.2352, -0.0207],
    [0.4521, 0.2219, -0.0430], [-0.4559, 0.2213, -0.0451], [0.7076, 0.2328, -0.0445],
    [-0.7044, 0.2338, -0.0452],
])  # fmt: skip
# SMPL-H hand joints, per hand: index, middle, pinky, ring, thumb (3 each).
SMPL_FINGERS = [("Index", "Proximal Intermediate Distal"), ("Middle", "Proximal Intermediate Distal"),
                ("Little", "Proximal Intermediate Distal"), ("Ring", "Proximal Intermediate Distal"),
                ("Thumb", "Metacarpal Proximal Distal")]  # fmt: skip
# Left hand joints relative to the wrist at rest (x mirrored for the right hand).
SMPL_FINGER_REST = np.array([
    [0.088, -0.006, 0.026], [0.120, -0.009, 0.028], [0.142, -0.011, 0.028],
    [0.094, -0.006, 0.004], [0.128, -0.010, 0.002], [0.152, -0.013, 0.000],
    [0.081, -0.012, -0.039], [0.101, -0.015, -0.044], [0.117, -0.017, -0.047],
    [0.090, -0.009, -0.018], [0.120, -0.013, -0.022], [0.142, -0.016, -0.024],
    [0.025, -0.015, 0.025], [0.045, -0.020, 0.050], [0.068, -0.022, 0.066],
])  # fmt: skip

# Kimodo SOMA (somaskel77) joint names -> VRM bones; several names = folded together, parent first.
SOMA_BODY = {
    "hips": ["Hips"], "spine": ["Spine1"], "chest": ["Spine2"], "upperChest": ["Chest"],
    "neck": ["Neck1"], "head": ["Neck2", "Head"],
}  # fmt: skip
for _s, _S in (("left", "Left"), ("right", "Right")):
    SOMA_BODY |= {
        f"{_s}Shoulder": [f"{_S}Shoulder"], f"{_s}UpperArm": [f"{_S}Arm"], f"{_s}LowerArm": [f"{_S}ForeArm"],
        f"{_s}Hand": [f"{_S}Hand"], f"{_s}UpperLeg": [f"{_S}Leg"], f"{_s}LowerLeg": [f"{_S}Shin"],
        f"{_s}Foot": [f"{_S}Foot"], f"{_s}Toes": [f"{_S}ToeBase"],
        f"{_s}ThumbMetacarpal": [f"{_S}HandThumb1"], f"{_s}ThumbProximal": [f"{_S}HandThumb2"],
        f"{_s}ThumbDistal": [f"{_S}HandThumb3"],
    }  # fmt: skip
    for _f, _F in (("Index", "Index"), ("Middle", "Middle"), ("Ring", "Ring"), ("Little", "Pinky")):
        SOMA_BODY |= {
            f"{_s}{_f}Proximal": [f"{_S}Hand{_F}1", f"{_S}Hand{_F}2"],
            f"{_s}{_f}Intermediate": [f"{_S}Hand{_F}3"],
            f"{_s}{_f}Distal": [f"{_S}Hand{_F}4"],
        }

ROOT_MODES = ("inplace", "keep")
FACING_MODES = ("start", "locked", "keep")


@dataclass
class Skeleton:
    """A source skeleton resting in a world-aligned T-pose (Y up, facing +Z), in meters."""

    parents: list[int]
    rest: np.ndarray  # (J, 3) joint positions at rest
    bones: dict[str, list[int]]  # VRM bone -> source joints folded into it, parent first
    head: int

    def __post_init__(self) -> None:
        # Folding is right only when each bone's chain hangs from its VRM parent's last joint
        for bone, chain in self.bones.items():
            for a, b in zip(chain, chain[1:]):
                if self.parents[b] != a:
                    raise ValueError(f"{bone}: joints {a} and {b} are not parent and child")
            up = self.vrm_parent(bone)
            want = -1 if up is None else self.bones[up][-1]
            if self.parents[chain[0]] != want:
                raise ValueError(f"{bone}: joint {chain[0]} doesn't hang from {up}")

    def vrm_parent(self, bone: str) -> str | None:
        up = VRM_PARENT[bone]
        while up is not None and up not in self.bones:
            up = VRM_PARENT[up]
        return up

    @property
    def root(self) -> int:
        return self.bones["hips"][0]

    def hips_height(self) -> float:
        return float(self.rest[self.root, 1] - self.rest[:, 1].min())


def smpl_skeleton(joints: int = 22) -> Skeleton:
    """SMPL body, plus the SMPL-H fingers (in joints 22-51) when there are 52 joints."""
    parents = list(SMPL_PARENTS)
    rest = [*SMPL_REST]
    bones = {name: [j] for j, name in enumerate(SMPL_BODY)}
    if joints == 52:
        for side, wrist, mirror in (("left", 20, 1.0), ("right", 21, -1.0)):
            for f, (finger, parts) in enumerate(SMPL_FINGERS):
                up = wrist
                for k, part in enumerate(parts.split()):
                    rest.append(SMPL_REST[wrist] + SMPL_FINGER_REST[f * 3 + k] * np.array([mirror, 1.0, 1.0]))
                    parents.append(up)
                    up = len(parents) - 1
                    bones[f"{side}{finger}{part}"] = [up]
    return Skeleton(parents, np.array(rest), bones, head=15)


def named_skeleton(names: list[str], parents: list[int], rest: np.ndarray) -> Skeleton:
    """A skeleton described by the file (Kimodo): SOMA by joint names, SMPL-X by order."""
    if names and names[0] == "Hips":
        index = {n: i for i, n in enumerate(names)}
        bones = {}
        for bone, chain in SOMA_BODY.items():
            if all(n in index for n in chain):
                bones[bone] = [index[n] for n in chain]
        missing = [b for b in SMPL_BODY if b not in bones and b not in ("upperChest",)]
        if missing:
            raise ValueError(f"SOMA skeleton without {', '.join(missing)}")
        return Skeleton(list(parents), np.asarray(rest, dtype=np.float64), bones, index["Head"])
    if len(names) >= 22 and names[0].lower() == "pelvis":
        sk = smpl_skeleton(22)
        sk.rest = np.asarray(rest, dtype=np.float64)[:22]
        return sk
    raise ValueError(f"unknown skeleton (first joints: {names[:3]})")


@dataclass
class Motion:
    """Local joint rotations (T, J, 3, 3) of `skeleton` and the root joint's positions (T, 3)."""

    rots: np.ndarray
    pos: np.ndarray
    fps: float
    skeleton: Skeleton
    # The up axis when the format fixes it ("y": Kimodo, HY-Motion), None to find it from the pose.
    # Finding it fails on a clip spent lying down (the head is beside the hips, not above).
    up: str | None = None

    @property
    def frames(self) -> int:
        return int(self.rots.shape[0])


@dataclass
class Report:
    seconds: float
    frames: int
    up: str
    turned: float  # degrees turned to face the camera at the start
    travel: float  # meters of root travel on the floor (removed when in place)
    yaw_range: float  # degrees the body turns during the clip (before locking)
    fingers: bool


# --- rotations ---------------------------------------------------------------


def axis_angle_to_matrix(aa: np.ndarray) -> np.ndarray:
    aa = np.asarray(aa, dtype=np.float64)
    theta = np.linalg.norm(aa, axis=-1, keepdims=True)
    k = aa / np.maximum(theta, 1e-12)
    x, y, z = k[..., 0], k[..., 1], k[..., 2]
    zero = np.zeros_like(x)
    K = np.stack([zero, -z, y, z, zero, -x, -y, x, zero], axis=-1).reshape(*aa.shape[:-1], 3, 3)
    s = np.sin(theta)[..., None]
    c = np.cos(theta)[..., None]
    return np.eye(3) + s * K + (1 - c) * (K @ K)


def matrix_to_quat(m: np.ndarray) -> np.ndarray:
    """Rotation matrices (..., 3, 3) -> unit quaternions (..., 4) as x, y, z, w (glTF order)."""
    m = np.asarray(m, dtype=np.float64)
    m00, m01, m02 = m[..., 0, 0], m[..., 0, 1], m[..., 0, 2]
    m10, m11, m12 = m[..., 1, 0], m[..., 1, 1], m[..., 1, 2]
    m20, m21, m22 = m[..., 2, 0], m[..., 2, 1], m[..., 2, 2]
    # Each row is the quaternion times 4 * one of its components: use the largest
    cands = np.stack(
        [
            np.stack([m21 - m12, m02 - m20, m10 - m01, 1 + m00 + m11 + m22], -1),
            np.stack([1 + m00 - m11 - m22, m01 + m10, m02 + m20, m21 - m12], -1),
            np.stack([m01 + m10, 1 - m00 + m11 - m22, m12 + m21, m02 - m20], -1),
            np.stack([m02 + m20, m12 + m21, 1 - m00 - m11 + m22, m10 - m01], -1),
        ],
        axis=-2,
    )
    pick = np.argmax(np.stack([m00 + m11 + m22, m00, m11, m22], -1), axis=-1)
    q = np.take_along_axis(cands, pick[..., None, None], axis=-2)[..., 0, :]
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def rot_y(angle: np.ndarray | float) -> np.ndarray:
    a = np.asarray(angle, dtype=np.float64)
    c, s = np.cos(a), np.sin(a)
    one, zero = np.ones_like(a), np.zeros_like(a)
    return np.stack([c, zero, s, zero, one, zero, -s, zero, c], -1).reshape(*a.shape, 3, 3)


def align_to_y(axis: np.ndarray) -> np.ndarray:
    """The rotation taking a unit axis to +Y."""
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    y = np.array([0.0, 1.0, 0.0])
    d = float(a @ y)
    if d > 1 - 1e-9:
        return np.eye(3)
    if d < -1 + 1e-9:
        return np.diag([1.0, -1.0, -1.0])
    k = np.cross(a, y)
    k /= np.linalg.norm(k)
    return axis_angle_to_matrix(k * np.arccos(d))


def heading(root: np.ndarray) -> np.ndarray:
    """Yaw of the pelvis (radians) from its left-right axis, which stays level in a bow."""
    return np.arctan2(-root[..., 2, 0], root[..., 0, 0])


def continuous(q: np.ndarray) -> np.ndarray:
    """Flip signs so consecutive quaternions stay on the same side (no 360 degree spins when interpolated)."""
    q = q.copy()
    for t in range(1, q.shape[0]):
        flip = np.sum(q[t] * q[t - 1], axis=-1) < 0
        q[t][flip] *= -1
    return q


def forward_kinematics(m: Motion) -> np.ndarray:
    """World joint positions (T, J, 3)."""
    sk = m.skeleton
    world_r = np.empty_like(m.rots)
    world_p = np.empty((m.frames, len(sk.parents), 3))
    for j, p in enumerate(sk.parents):
        if p < 0:
            world_r[:, j] = m.rots[:, j]
            world_p[:, j] = m.pos if j == sk.root else m.pos + (sk.rest[j] - sk.rest[sk.root])
        else:
            world_r[:, j] = world_r[:, p] @ m.rots[:, j]
            world_p[:, j] = world_p[:, p] + world_r[:, p] @ (sk.rest[j] - sk.rest[p])
    return world_p


# --- loading -----------------------------------------------------------------


def from_axis_angle(poses: np.ndarray, trans: np.ndarray, fps: float = 30.0) -> Motion:
    """Axis-angle poses (T, 3*J) in SMPL order (22 body joints first) + root translation (T, 3)."""
    T = poses.shape[0]
    aa = np.asarray(poses, dtype=np.float64).reshape(T, -1, 3)
    joints = aa.shape[1]
    if joints < 22:
        raise ValueError(f"expected at least 22 SMPL joints, got {joints}")
    mats = axis_angle_to_matrix(aa)
    if joints == 52:  # SMPL-H: 22 body + 2 x 15 fingers
        rots, sk = mats, smpl_skeleton(52)
    elif joints == 55:  # SMPL-X: 22 body + jaw + 2 eyes + 2 x 15 fingers
        rots, sk = np.concatenate([mats[:, :22], mats[:, 25:55]], axis=1), smpl_skeleton(52)
    else:
        rots, sk = mats[:, :22], smpl_skeleton(22)
    return Motion(rots, np.asarray(trans, dtype=np.float64).reshape(T, 3), float(fps), sk)  # up unknown: AMASS is Z up


def load(path: str | Path, fps: float | None = None) -> Motion:
    """A motion .npz from HY-Motion, Kimodo (generate.py or its CLI) or AMASS."""
    with np.load(path, allow_pickle=False) as z:
        keys = set(z.files)
        rate = fps
        for k in ("mocap_framerate", "mocap_frame_rate", "fps"):
            if rate is None and k in keys:
                rate = float(np.asarray(z[k]).reshape(-1)[0])
        rate = rate or 30.0
        if "local_rot_mats" in keys:
            rots = np.asarray(z["local_rot_mats"], dtype=np.float64)
            if rots.ndim == 5:  # several samples saved together: take the first
                rots = rots[0]
            pos = np.asarray(z["root_positions"], dtype=np.float64).reshape(rots.shape[0], 3)
            if "joint_names" in keys:
                sk = named_skeleton([str(n) for n in z["joint_names"]], z["parents"].tolist(), z["neutral_joints"])
            elif rots.shape[1] == 22:
                sk = smpl_skeleton(22)
            else:
                raise ValueError(
                    f"Kimodo skeleton with {rots.shape[1]} joints and no skeleton in the file: "
                    "generate it with runpod/generate.py, which saves the joint names and rest pose"
                )
            if rots.shape[1] != len(sk.parents):
                raise ValueError(f"{rots.shape[1]} joint rotations for a {len(sk.parents)} joint skeleton")
            return Motion(rots, pos, rate, sk, up="y")  # Kimodo: Y up
        if "poses" in keys and "trans" in keys:
            m = from_axis_angle(z["poses"], z["trans"], rate)
            if "Rh" in keys:  # HY-Motion's files (AMASS has no Rh): Y up
                m.up = "y"
            return m
        if {"root_orient", "pose_body", "trans"} <= keys:
            poses = np.concatenate([z["root_orient"], z["pose_body"]], axis=-1)
            if "pose_hand" in keys:
                poses = np.concatenate([poses, z["pose_hand"]], axis=-1)
            return from_axis_angle(poses, z["trans"], rate)
    raise ValueError(f"{path}: not a known motion file (keys: {sorted(keys)})")


# --- conversion --------------------------------------------------------------


def trim(m: Motion, start: float | None, end: float | None) -> Motion:
    a = 0 if start is None else max(0, int(round(start * m.fps)))
    b = m.frames if end is None else min(m.frames, int(round(end * m.fps)))
    if b - a < 2:
        raise ValueError("the trimmed clip is shorter than two frames")
    return Motion(m.rots[a:b], m.pos[a:b], m.fps, m.skeleton, m.up)


def orient(m: Motion, up: str = "auto", facing: str = "start", turn: float | np.ndarray = 0.0) -> tuple[Motion, str, float, float]:
    """Y up, facing +Z, then turned by `turn` degrees (90 = facing +X, the character's left: a profile;
    one value per frame turns it gradually).
    Returns the motion, the up axis found, the start turn and the yaw range (degrees)."""
    root = m.skeleton.root
    rots = m.rots.copy()
    pos = m.pos.copy()
    if up == "auto" and m.up:
        up = m.up
    if up == "auto":
        v = (forward_kinematics(m)[:, m.skeleton.head] - pos).mean(axis=0)
        i = int(np.argmax(np.abs(v)))
        axis = np.zeros(3)
        axis[i] = 1.0 if v[i] >= 0 else -1.0
        up_name = ("-" if axis[i] < 0 else "+") + "xyz"[i]
    elif up in ("y", "z"):
        axis = np.array([0.0, 1.0, 0.0]) if up == "y" else np.array([0.0, 0.0, 1.0])
        up_name = "+" + up
    else:
        raise ValueError(f"up must be auto, y or z, not {up!r}")
    c = align_to_y(axis)
    rots[:, root] = c @ rots[:, root]
    pos = pos @ c.T

    yaw = np.unwrap(heading(rots[:, root]))
    yaw_range = float(np.degrees(yaw.max() - yaw.min()))
    n = min(len(yaw), 6)
    start = float(np.arctan2(np.sin(yaw[:n]).mean(), np.cos(yaw[:n]).mean()))
    if facing not in FACING_MODES:
        raise ValueError(f"facing must be one of {FACING_MODES}, not {facing!r}")
    first = 0.0 if facing == "keep" else -start
    # The extra turn may change over time (an idle turning into profile while it lies down)
    extra = rot_y(np.broadcast_to(np.radians(np.asarray(turn, dtype=np.float64)), (m.frames,)))
    q0 = extra @ rot_y(first)
    pos = np.einsum("tij,tj->ti", q0, pos)
    rots[:, root] = (extra @ rot_y(-yaw) if facing == "locked" else q0) @ rots[:, root]
    return Motion(rots, pos, m.fps, m.skeleton, "y"), up_name, float(np.degrees(-first)), yaw_range


def hips_track(m: Motion, root: str = "inplace") -> tuple[np.ndarray, float]:
    """Hips positions (T, 3) over a floor at y = 0, and the floor travel in meters."""
    if root not in ROOT_MODES:
        raise ValueError(f"root must be one of {ROOT_MODES}, not {root!r}")
    floor = float(forward_kinematics(m)[..., 1].min())
    xz = m.pos[:, [0, 2]] - m.pos[0, [0, 2]]
    travel = float(np.linalg.norm(np.diff(xz, axis=0), axis=-1).sum())
    out = np.zeros((m.frames, 3))
    out[:, 1] = m.pos[:, 1] - floor
    if root == "keep":
        out[:, 0] = xz[:, 0]
        out[:, 2] = xz[:, 1]
    return out, travel


def vrm_bones(m: Motion) -> list[tuple[str, int, np.ndarray, np.ndarray]]:
    """(VRM bone, index of its parent in this list, rest offset, local rotations (T, 3, 3)), parents first."""
    sk = m.skeleton
    out: list[tuple[str, int, np.ndarray, np.ndarray]] = []
    at: dict[str, int] = {}
    for bone in VRM_PARENT:  # parents come first in this order
        if bone not in sk.bones:
            continue
        chain = sk.bones[bone]
        rot = m.rots[:, chain[0]]
        for j in chain[1:]:
            rot = rot @ m.rots[:, j]
        up = sk.vrm_parent(bone)
        offset = sk.rest[chain[0]] - (sk.rest[sk.bones[up][0]] if up else 0)
        at[bone] = len(out)
        out.append((bone, at[up] if up else -1, offset, rot))
    return out


# --- hands -------------------------------------------------------------------

# Text-to-motion models leave the fingers still (Kimodo SOMA fills them with a
# relaxed pose, HY-Motion with a mean pose): such tracks would freeze the
# app's living fingers, so they are dropped, and a gesture that needs a fist
# or a pointing finger names a shape. Same conventions and angles as the
# app's pose.ts: Euler XYZ degrees on normalized bones, fingers curl with Z
# (left -, right +), the thumb folds with X and crosses the palm with Y.
HAND_SHAPES = ("relaxed", "open", "fist", "point", "claw", "pinch", "thumbs_up")
_CURLS = {
    # index, middle, ring, little, thumb fold
    "relaxed": (14, 14, 14, 14, 20),
    "open": (2, 2, 2, 2, 0),
    "fist": (85, 85, 85, 85, 55),
    "point": (0, 85, 85, 85, 45),
    "claw": (45, 45, 45, 45, 25),
    "pinch": (45, 35, 30, 30, 45),
    "thumbs_up": (85, 85, 85, 85, 0),
}


def euler_xyz(deg: np.ndarray) -> np.ndarray:
    """Euler angles in degrees (three.js order XYZ) -> rotation matrix."""
    x, y, z = np.radians(np.asarray(deg, dtype=np.float64))
    rx = np.array([[1, 0, 0], [0, np.cos(x), -np.sin(x)], [0, np.sin(x), np.cos(x)]])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    rz = np.array([[np.cos(z), -np.sin(z), 0], [np.sin(z), np.cos(z), 0], [0, 0, 1]])
    return rx @ ry @ rz


def hand_shape(side: str, shape: str) -> dict[str, np.ndarray]:
    """VRM finger bone -> Euler degrees of a hand shape."""
    if shape not in _CURLS:
        raise ValueError(f"hand shape {shape!r}: one of {', '.join(HAND_SHAPES)}")
    *fingers, fold = _CURLS[shape]
    z = -1 if side == "left" else 1
    out: dict[str, np.ndarray] = {}
    for name, deg in zip(("Index", "Middle", "Ring", "Little"), fingers):
        for joint in ("Proximal", "Intermediate", "Distal"):
            out[f"{side}{name}{joint}"] = np.array([0.0, 0.0, z * deg])
    y = (0.6 if side == "left" else -0.6) * fold
    out[f"{side}ThumbMetacarpal"] = np.array([0.2 * fold, 0.6 * y, 0.0])
    out[f"{side}ThumbProximal"] = np.array([0.4 * fold, y, 0.0])
    out[f"{side}ThumbDistal"] = np.array([0.5 * fold, 0.5 * y, 0.0])
    return out


def fingers_animated(bones: list[tuple[str, int, np.ndarray, np.ndarray]], side: str, degrees: float = 2.0) -> bool:
    """Whether any finger of that hand moves by more than `degrees` during the clip."""
    for name, _, _, rot in bones:
        if name.startswith(side) and name in FINGER_BONES:
            q = continuous(matrix_to_quat(rot)[:, None])[:, 0]
            if np.degrees(2 * np.arccos(np.clip(np.abs(q @ q[0]), 0, 1))).max() > degrees:
                return True
    return False


def hand_activity(m: Motion, side: str) -> np.ndarray:
    """0 while the hand hangs by the hips, 1 once it is up and gesturing (above the hips), smoothed over 0.2 s."""
    sk = m.skeleton
    world = forward_kinematics(m)
    lift = world[:, sk.bones[f"{side}Hand"][0], 1] - world[:, sk.root, 1]
    x = np.clip((lift + 0.02) / 0.17, 0, 1)
    a = x * x * (3 - 2 * x)
    k = max(1, int(round(0.2 * m.fps)))
    padded = np.pad(a, (k // 2, k - 1 - k // 2), mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")


def slerp(q0: np.ndarray, q1: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Quaternions from q0 to q1 at each t (T,) -> (T, 4)."""
    if q0 @ q1 < 0:
        q1 = -q1
    theta = float(np.arccos(np.clip(q0 @ q1, -1, 1)))
    t = np.asarray(t, dtype=np.float64)[:, None]
    if theta < 1e-6:
        q = q0 + t * (q1 - q0)
    else:
        q = (np.sin((1 - t) * theta) * q0 + np.sin(t * theta) * q1) / np.sin(theta)
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    rows = [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ]  # fmt: skip
    return np.stack(rows, -1).reshape(*q.shape[:-1], 3, 3)


def finger_offset(bone: str) -> np.ndarray:
    """A finger bone's rest offset from its parent, from the SMPL-H hand (for skeletons without fingers)."""
    side = "left" if bone.startswith("left") else "right"
    mirror = np.array([1.0 if side == "left" else -1.0, 1.0, 1.0])
    for f, (finger, parts) in enumerate(SMPL_FINGERS):
        names = parts.split()
        for k, part in enumerate(names):
            if bone == f"{side}{finger}{part}":
                prev = SMPL_FINGER_REST[f * 3 + k - 1] if k else np.zeros(3)
                return (SMPL_FINGER_REST[f * 3 + k] - prev) * mirror
    raise KeyError(bone)


def shaped_fingers(m: Motion, side: str, shape: str) -> dict[str, np.ndarray]:
    """Finger rotations (T, 3, 3): relaxed while the hand hangs, `shape` while it gestures."""
    a = hand_activity(m, side)
    relaxed = hand_shape(side, "relaxed")
    out = {}
    for bone, deg in hand_shape(side, shape).items():
        q0 = matrix_to_quat(euler_xyz(relaxed[bone]))
        q1 = matrix_to_quat(euler_xyz(deg))
        out[bone] = quat_to_matrix(slerp(q0, q1, a))
    return out


# --- the whole conversion ----------------------------------------------------


def convert_parts(
    m: Motion,
    parts: list[tuple[str, int, int]],
    root: str = "inplace",
    facing: str = "start",
    up: str = "auto",
    hands: bool | None = None,
    shapes: dict[str, str] | None = None,
    turn: float | np.ndarray = 0.0,
) -> tuple[dict[str, bytes], Report]:
    """Several .vrma cut from one motion at frames [start, end): orientation, floor and hands are worked
    out on the whole motion, so the parts join where they were cut (an idle's enter, loop and exit).
    `hands`: True/False forces the model's finger tracks in or out, None keeps them only if they move;
    `shapes` ({"right": "fist"}) gives a hand that shape while it gestures (relaxed while it hangs)."""
    m, up_name, turned, yaw_range = orient(m, up, facing, turn)
    hips, travel = hips_track(m, root)
    bones = vrm_bones(m)
    shaped = {side: shaped_fingers(m, side, shape) for side, shape in (shapes or {}).items()}
    keep = {s: s not in shaped and (fingers_animated(bones, s) if hands is None else hands) for s in ("left", "right")}
    kept = []
    for name, parent, offset, rot in bones:
        if name in FINGER_BONES:
            side = "left" if name.startswith("left") else "right"
            if side in shaped:
                rot = shaped[side].get(name, rot)
            elif not keep[side]:
                continue
        kept.append((name, parent, offset, rot))
    # Parent indices pointed into the full list: renumber (fingers only hang from hands and fingers)
    index = {b[0]: i for i, b in enumerate(kept)}
    kept = [(n, index[bones[p][0]] if p >= 0 else -1, o, r) for n, p, o, r in kept]
    # A skeleton without fingers (SMPL body) gets them, at the SMPL-H hand's rest offsets
    for side, rots in shaped.items():
        for bone, rot in rots.items():
            if bone in index:
                continue
            up = VRM_PARENT[bone]
            index[bone] = len(kept)
            kept.append((bone, index[up], finger_offset(bone), rot))
    fingers = any(b[0] in FINGER_BONES for b in kept)
    out = {}
    for name, a, b in parts:
        if not 0 <= a < b <= m.frames or b - a < 2:
            raise ValueError(f"part {name}: frames {a}-{b} outside the motion ({m.frames} frames)")
        out[name] = vrma_bytes([(n, p, o, r[a:b]) for n, p, o, r in kept], hips[a:b], m.skeleton.hips_height(), m.fps)
    report = Report(m.frames / m.fps, m.frames, up_name, turned, travel, yaw_range, fingers)
    return out, report


def convert(m: Motion, **options) -> tuple[bytes, Report]:
    """One .vrma for the whole motion (options as in convert_parts)."""
    parts, report = convert_parts(m, [("all", 0, m.frames)], **options)
    return parts["all"], report


# --- glTF / VRMA -------------------------------------------------------------


def vrma_bytes(bones: list[tuple[str, int, np.ndarray, np.ndarray]], hips: np.ndarray, height: float, fps: float) -> bytes:
    """A .vrma (binary glTF + VRMC_vrm_animation) with one rotation track per bone and the hips translation."""
    T = hips.shape[0]
    times = (np.arange(T) / fps).astype(np.float32)
    blobs: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []
    offset = 0

    def add(arr: np.ndarray, kind: str, minmax: bool = False) -> int:
        nonlocal offset
        raw = np.ascontiguousarray(arr, dtype="<f4").tobytes()
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw)})
        acc = {"bufferView": len(views) - 1, "componentType": 5126, "count": int(arr.shape[0]), "type": kind}
        if minmax:
            acc["min"] = [float(arr.min())]
            acc["max"] = [float(arr.max())]
        accessors.append(acc)
        blobs.append(raw)
        offset += len(raw)  # float32 data keeps every view 4-byte aligned
        return len(accessors) - 1

    time_acc = add(times, "SCALAR", minmax=True)
    nodes: list[dict] = []
    human: dict[str, dict] = {}
    channels: list[dict] = []
    samplers: list[dict] = []
    for i, (name, parent, off, rot) in enumerate(bones):
        # The hips' rest height is what three-vrm-animation divides the hips track by
        translation = [0.0, height, 0.0] if parent < 0 else [float(x) for x in off]
        nodes.append({"name": name, "translation": translation})
        if parent >= 0:
            nodes[parent].setdefault("children", []).append(i)
        human[name] = {"node": i}
        quats = continuous(matrix_to_quat(rot)[:, None])[:, 0]
        samplers.append({"input": time_acc, "output": add(quats, "VEC4"), "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": i, "path": "rotation"}})
    samplers.append({"input": time_acc, "output": add(hips, "VEC3"), "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": 0, "path": "translation"}})

    binary = b"".join(blobs)
    doc = {
        "asset": {"version": "2.0", "generator": "Lumi motion.vrma"},
        "extensionsUsed": ["VRMC_vrm_animation"],
        "extensions": {"VRMC_vrm_animation": {"specVersion": "1.0", "humanoid": {"humanBones": human}}},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "animations": [{"name": "gesture", "channels": channels, "samplers": samplers}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    return glb(doc, binary)


def glb(doc: dict, binary: bytes) -> bytes:
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(js), b"JSON")
        + js
        + struct.pack("<I4s", len(binary), b"BIN\0")
        + binary
    )


def read_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError("not a binary glTF 2.0 file")
    n, _ = struct.unpack_from("<I4s", data, 12)
    doc = json.loads(data[20 : 20 + n].decode("utf-8"))
    at = 20 + n
    binary = b""
    if at < len(data):
        size, _ = struct.unpack_from("<I4s", data, at)
        binary = data[at + 8 : at + 8 + size]
    return doc, binary


def track(doc: dict, binary: bytes, bone: str, path: str) -> np.ndarray:
    """The keyframe values of one humanoid bone's rotation or translation."""
    node = doc["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"][bone]["node"]
    anim = doc["animations"][0]
    for ch in anim["channels"]:
        if ch["target"]["node"] == node and ch["target"]["path"] == path:
            acc = doc["accessors"][anim["samplers"][ch["sampler"]]["output"]]
            view = doc["bufferViews"][acc["bufferView"]]
            width = {"VEC3": 3, "VEC4": 4}[acc["type"]]
            arr = np.frombuffer(binary, dtype="<f4", count=acc["count"] * width, offset=view["byteOffset"])
            return arr.reshape(acc["count"], width)
    raise KeyError(f"no {path} track for {bone}")


# --- command line ------------------------------------------------------------


def describe(r: Report) -> str:
    return (
        f"{r.seconds:.1f} s, up {r.up}, turned {r.turned:+.0f} deg, travel {r.travel:.2f} m, "
        f"body yaw range {r.yaw_range:.0f} deg" + (", fingers" if r.fingers else "")
    )


def add_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--root", choices=ROOT_MODES, default="inplace", help="inplace: no travel on the floor (default)")
    p.add_argument(
        "--facing", choices=FACING_MODES, default="start", help="start: face the camera at the start; locked: always"
    )
    p.add_argument("--up", choices=("auto", "y", "z"), default="auto")
    p.add_argument(
        "--hands",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="the model's finger tracks (default: only if they move; Kimodo and HY-Motion leave them still)",
    )
    p.add_argument(
        "--hand",
        action="append",
        default=[],
        metavar="SIDE=SHAPE",
        help=f"a hand shape while that hand gestures, e.g. right=fist ({', '.join(HAND_SHAPES)})",
    )
    p.add_argument("--turn", type=float, default=0.0, help="degrees to turn after facing the camera (90 = profile)")


def options_from(args: argparse.Namespace) -> dict:
    shapes = {}
    for item in args.hand:
        side, _, shape = item.partition("=")
        if side not in ("left", "right") or shape not in HAND_SHAPES:
            raise SystemExit(f"--hand {item}: left|right=one of {', '.join(HAND_SHAPES)}")
        shapes[side] = shape
    return {"root": args.root, "facing": args.facing, "up": args.up, "hands": args.hands, "shapes": shapes, "turn": args.turn}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Convert text-to-motion clips (.npz) to VRM Animation (.vrma)")
    p.add_argument("inputs", nargs="+", help=".npz files or folders")
    p.add_argument("-o", "--out", help="output file (one input) or folder; default: next to the input")
    add_options(p)
    p.add_argument("--trim", help="seconds to keep, start:end (either may be empty)")
    p.add_argument("--fps", type=float, help="frame rate when the file doesn't say (default 30)")
    args = p.parse_args(argv)
    options = options_from(args)

    files: list[Path] = []
    for item in map(Path, args.inputs):
        files += sorted(item.rglob("*.npz")) if item.is_dir() else [item]
    out = Path(args.out) if args.out else None
    failed = 0
    for src in files:
        if out is None:
            dst = src.with_suffix(".vrma")
        elif out.suffix.lower() == ".vrma" and len(files) == 1:
            dst = out
        else:
            dst = out / (src.stem + ".vrma")
        try:
            m = load(src, args.fps)
            if args.trim:
                a, _, b = args.trim.partition(":")
                m = trim(m, float(a) if a else None, float(b) if b else None)
            data, report = convert(m, **options)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            print(f"{src} -> {dst}: {describe(report)}")
        except (ValueError, KeyError, OSError) as err:
            failed += 1
            print(f"{src}: {err}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())


def turn_ramp(parts: list[tuple[str, int, int]], frames: int, degrees: float) -> np.ndarray:
    """An idle's extra turn per frame: from 0 to `degrees` over the enter part, held in the loop, back to 0
    over the exit (it turns into profile while it lies down, and back while it gets up)."""
    out = np.full(frames, float(degrees))
    for name, a, b in parts:
        u = np.clip((np.arange(a, b) - a) / max(1, b - 1 - a), 0, 1)
        ease = u * u * (3 - 2 * u)
        if name == "enter":
            out[a:b] = degrees * ease
        elif name == "exit":
            out[a:b] = degrees * (1 - ease)
    return out
