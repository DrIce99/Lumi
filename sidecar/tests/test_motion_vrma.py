import numpy as np
import pytest

from motion.vrma import (
    SMPL_REST,
    Motion,
    axis_angle_to_matrix,
    continuous,
    convert,
    from_axis_angle,
    load,
    main,
    matrix_to_quat,
    named_skeleton,
    read_glb,
    rot_y,
    smpl_skeleton,
    track,
    trim,
)

H = smpl_skeleton().hips_height()
IDENTITY = np.array([0, 0, 0, 1.0])


def still(frames=30, joints=22):
    """A T-pose standing still, as axis-angle poses + pelvis translation."""
    return np.zeros((frames, joints * 3)), np.tile(SMPL_REST[0], (frames, 1))


def unpack(data):
    doc, binary = read_glb(data)
    return doc, lambda bone, path="rotation": track(doc, binary, bone, path)


def humans(doc):
    return doc["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"]


def angle_between(q, r):
    return np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(q * r, axis=-1)), 0, 1)))


def soma_names():
    """Kimodo's somaskel77 layout (bone_order_names_with_parents)."""
    joints = [("Hips", None), ("Spine1", "Hips"), ("Spine2", "Spine1"), ("Chest", "Spine2"), ("Neck1", "Chest"),
              ("Neck2", "Neck1"), ("Head", "Neck2"), ("HeadEnd", "Head"), ("Jaw", "Head"), ("LeftEye", "Head"),
              ("RightEye", "Head")]  # fmt: skip
    for S in ("Left", "Right"):
        joints += [(f"{S}Shoulder", "Chest"), (f"{S}Arm", f"{S}Shoulder"), (f"{S}ForeArm", f"{S}Arm"),
                   (f"{S}Hand", f"{S}ForeArm")]  # fmt: skip
        for F, n in (("Thumb", 3), ("Index", 4), ("Middle", 4), ("Ring", 4), ("Pinky", 4)):
            up = f"{S}Hand"
            for k in [*range(1, n + 1), "End"]:
                joints.append((f"{S}Hand{F}{k}", up))
                up = f"{S}Hand{F}{k}"
    for S in ("Left", "Right"):
        joints += [(f"{S}Leg", "Hips"), (f"{S}Shin", f"{S}Leg"), (f"{S}Foot", f"{S}Shin"),
                   (f"{S}ToeBase", f"{S}Foot"), (f"{S}ToeEnd", f"{S}ToeBase")]  # fmt: skip
    names = [n for n, _ in joints]
    parents = [-1 if p is None else names.index(p) for _, p in joints]
    # A rough T-pose: each joint a little further from its parent along the limb
    rest = np.zeros((len(names), 3))
    for i, (name, p) in enumerate(joints):
        if p is None:
            rest[i] = [0, 0.95, 0]
            continue
        side = 1 if name.startswith("Left") else -1 if name.startswith("Right") else 0
        step = [0.0, 0.1, 0.0]
        if any(k in name for k in ("Leg", "Shin", "Foot")):
            step = [0.05 * side, -0.25, 0.0]
        elif "Toe" in name:
            step = [0.0, -0.05, 0.1]
        elif side and "Eye" not in name:
            step = [0.1 * side, 0.0, 0.0]
        rest[i] = rest[parents[i]] + step
    return names, parents, rest


def test_quaternions_match_the_rotations():
    rng = np.random.default_rng(1)
    aa = rng.normal(size=(200, 3)) * 1.5
    q = matrix_to_quat(axis_angle_to_matrix(aa))
    theta = np.linalg.norm(aa, axis=-1)
    expect = np.concatenate([aa / theta[:, None] * np.sin(theta / 2)[:, None], np.cos(theta / 2)[:, None]], -1)
    assert np.allclose(np.abs(np.sum(q * expect, -1)), 1, atol=1e-9)


def test_a_still_t_pose_is_identity_and_stands_on_the_floor():
    poses, trans = still()
    data, report = convert(from_axis_angle(poses, trans))
    doc, tr = unpack(data)
    assert doc["extensions"]["VRMC_vrm_animation"]["specVersion"] == "1.0"
    assert set(humans(doc)) >= {"hips", "spine", "chest", "upperChest", "head", "leftHand", "rightToes"}
    assert len(humans(doc)) == 22 and not report.fingers
    for bone in ("hips", "leftUpperArm", "head"):
        assert np.allclose(tr(bone), IDENTITY, atol=1e-6)
    hips = tr("hips", "translation")
    assert np.allclose(hips[:, 1], H, atol=1e-6)
    assert np.allclose(hips[:, [0, 2]], 0)
    # Rest hips height = a standing frame: three-vrm-animation scales by their ratio
    assert doc["nodes"][0]["translation"][1] == pytest.approx(H)
    assert report.up == "+y" and report.seconds == pytest.approx(1.0)
    times = doc["accessors"][doc["animations"][0]["samplers"][0]["input"]]
    assert times["min"] == [0.0] and times["max"][0] == pytest.approx(29 / 30)


def test_z_up_files_are_stood_up():
    poses, trans = still()
    poses[:, :3] = [np.pi / 2, 0, 0]  # AMASS: the body's +Y (up) rotated onto +Z
    trans = trans @ axis_angle_to_matrix(np.array([np.pi / 2, 0, 0])).T
    data, report = convert(from_axis_angle(poses, trans))
    assert report.up == "+z"
    assert angle_between(unpack(data)[1]("hips")[0], IDENTITY) < 1e-4


def test_the_clip_turns_to_face_the_camera():
    poses, trans = still()
    poses[:, :3] = [0, np.radians(70), 0]
    data, report = convert(from_axis_angle(poses, trans))
    assert report.turned == pytest.approx(70, abs=1e-6)
    assert angle_between(unpack(data)[1]("hips")[0], IDENTITY) < 1e-4
    data, _ = convert(from_axis_angle(poses, trans), facing="keep")
    assert angle_between(unpack(data)[1]("hips")[0], IDENTITY) == pytest.approx(70, abs=1e-4)


def test_locked_facing_removes_turns_but_keeps_a_bow():
    poses, trans = still(60)
    m = from_axis_angle(poses, trans)
    bow = axis_angle_to_matrix(np.array([0.6, 0, 0]))
    m.rots[:, 0] = rot_y(np.linspace(0, np.pi, 60)) @ bow  # bows while turning half around
    data, report = convert(m, facing="locked")
    assert report.yaw_range == pytest.approx(180, abs=1e-3)
    assert np.all(angle_between(unpack(data)[1]("hips"), matrix_to_quat(bow)) < 1e-4)


def test_in_place_removes_the_walk_and_keep_starts_from_zero():
    poses, trans = still(40)
    trans[:, 2] += np.linspace(0, 2, 40)  # walks 2 m forward
    trans[:, 1] += 0.05 * np.sin(np.linspace(0, 6, 40))  # and bobs
    data, report = convert(from_axis_angle(poses, trans))
    hips = unpack(data)[1]("hips", "translation")
    assert report.travel == pytest.approx(2, abs=1e-6)
    assert np.allclose(hips[:, [0, 2]], 0)
    # The floor is under the lowest point of the clip
    assert hips[:, 1].min() == pytest.approx(H, abs=1e-5)
    assert np.ptp(hips[:, 1]) == pytest.approx(np.ptp(trans[:, 1]), abs=1e-5)
    hips = unpack(convert(from_axis_angle(poses, trans), root="keep")[0])[1]("hips", "translation")
    assert hips[0, 2] == pytest.approx(0) and hips[-1, 2] == pytest.approx(2, abs=1e-5)


def test_crouching_lowers_the_hips_over_the_same_floor():
    poses, trans = still(20)
    poses[10:, 3 * 4] = 1.4  # knees bend in the second half...
    poses[10:, 3 * 5] = 1.4
    trans[10:, 1] -= 0.3  # ...and the body drops
    hips = unpack(convert(from_axis_angle(poses, trans))[0])[1]("hips", "translation")
    assert hips[0, 1] - hips[-1, 1] == pytest.approx(0.3, abs=1e-5)


def test_quaternions_stay_on_one_side():
    q = np.array([[[0, 0, 0, 1.0]], [[0, 0, 0, -1.0]], [[0, 0, 0.1, -0.99]]])
    out = continuous(q)
    assert out[1, 0, 3] == 1 and out[2, 0, 3] > 0


def test_smpl_fingers_only_when_asked():
    poses, trans = still(10, joints=52)
    poses[:, 22 * 3 + 2] = 0.8  # left index proximal curls
    data, report = convert(from_axis_angle(poses, trans), hands=True)
    doc, tr = unpack(data)
    bones = humans(doc)
    assert {"leftIndexProximal", "rightThumbMetacarpal", "leftLittleDistal"} <= set(bones)
    assert len(bones) == 52 and report.fingers
    assert angle_between(tr("leftIndexProximal")[0], IDENTITY) == pytest.approx(np.degrees(0.8), abs=1e-3)
    nodes = doc["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    assert nodes[parent[bones["rightThumbMetacarpal"]["node"]]]["name"] == "rightHand"
    # HY-Motion's fingers are a fixed mean pose: left out unless asked
    assert len(humans(unpack(convert(from_axis_angle(poses, trans))[0])[0])) == 22


def test_soma_folds_extra_joints_into_vrm_bones():
    names, parents, rest = soma_names()
    sk = named_skeleton(names, parents, rest)
    T = 8
    rots = np.tile(np.eye(3), (T, len(names), 1, 1))
    a = axis_angle_to_matrix(np.array([0, 0.3, 0]))
    b = axis_angle_to_matrix(np.array([0.4, 0, 0]))
    rots[:, names.index("Neck2")] = a
    rots[:, names.index("Head")] = b
    rots[:, names.index("LeftHandIndex1")] = a
    rots[:, names.index("LeftHandIndex2")] = b
    rots[:, names.index("RightArm")] = b
    pos = np.tile(rest[0], (T, 1))
    data, report = convert(Motion(rots, pos, 30.0, sk))
    doc, tr = unpack(data)
    assert report.fingers  # SOMA's fingers are motion capture: written by default
    assert len(humans(doc)) == 22 + 30
    assert angle_between(tr("head")[0], matrix_to_quat(a @ b)) < 1e-4
    assert angle_between(tr("leftIndexProximal")[0], matrix_to_quat(a @ b)) < 1e-4
    assert angle_between(tr("neck")[0], IDENTITY) < 1e-4
    assert angle_between(tr("rightUpperArm")[0], matrix_to_quat(b)) < 1e-4
    assert doc["nodes"][0]["translation"][1] == pytest.approx(sk.hips_height())
    assert len(humans(unpack(convert(Motion(rots, pos, 30.0, sk), hands=False)[0])[0])) == 22


def test_a_skeleton_whose_chain_skips_a_joint_is_refused():
    names, parents, rest = soma_names()
    parents = list(parents)
    parents[names.index("Head")] = names.index("Neck1")  # Neck2 is no longer between them
    with pytest.raises(ValueError, match="head"):
        named_skeleton(names, parents, rest)


def test_trim_keeps_the_middle():
    poses, trans = still(90)
    m = trim(from_axis_angle(poses, trans), 1.0, 2.0)
    assert m.frames == 30
    with pytest.raises(ValueError):
        trim(m, 0.5, 0.51)


def test_loads_hy_motion_kimodo_and_amass_files(tmp_path):
    poses, trans = still(12, joints=52)
    np.savez(tmp_path / "hy.npz", poses=poses, trans=trans, Rh=poses[:, :3], gender=np.array(["neutral"]))
    m = load(tmp_path / "hy.npz")
    assert m.frames == 12 and m.rots.shape[1] == 52 and m.fps == 30

    rots = np.tile(np.eye(3), (12, 22, 1, 1))
    np.savez(tmp_path / "ki.npz", local_rot_mats=rots, root_positions=trans, posed_joints=np.zeros((12, 22, 3)))
    assert load(tmp_path / "ki.npz").rots.shape[1] == 22
    np.savez(tmp_path / "soma_cli.npz", local_rot_mats=np.tile(np.eye(3), (12, 77, 1, 1)), root_positions=trans)
    with pytest.raises(ValueError, match="generate.py"):
        load(tmp_path / "soma_cli.npz")
    names, parents, rest = soma_names()
    np.savez(
        tmp_path / "soma.npz",
        local_rot_mats=np.tile(np.eye(3), (12, len(names), 1, 1)),
        root_positions=trans,
        joint_names=np.array(names),
        parents=np.array(parents),
        neutral_joints=rest,
        fps=np.array([30.0]),
    )
    assert load(tmp_path / "soma.npz").skeleton.fingers_move

    np.savez(tmp_path / "am.npz", root_orient=poses[:, :3], pose_body=poses[:, 3:66], trans=trans, mocap_frame_rate=60)
    m = load(tmp_path / "am.npz")
    assert m.fps == 60 and m.rots.shape == (12, 22, 3, 3)


def test_command_line_converts_a_folder(tmp_path):
    poses, trans = still(12)
    np.savez(tmp_path / "a.npz", poses=poses, trans=trans)
    np.savez(tmp_path / "bad.npz", other=np.zeros(3))
    assert main([str(tmp_path), "-o", str(tmp_path / "out")]) == 1  # one file failed
    assert read_glb((tmp_path / "out" / "a.vrma").read_bytes())[0]["asset"]["version"] == "2.0"
