import numpy as np
import pytest

from motion.vrma import (
    SMPL_REST,
    Motion,
    axis_angle_to_matrix,
    continuous,
    convert,
    convert_parts,
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
    turn_ramp,
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
    data, report = convert(Motion(rots, pos, 30.0, sk), hands=True)
    doc, tr = unpack(data)
    assert report.fingers
    assert len(humans(doc)) == 22 + 30
    assert angle_between(tr("head")[0], matrix_to_quat(a @ b)) < 1e-4
    assert angle_between(tr("leftIndexProximal")[0], matrix_to_quat(a @ b)) < 1e-4
    assert angle_between(tr("neck")[0], IDENTITY) < 1e-4
    assert angle_between(tr("rightUpperArm")[0], matrix_to_quat(b)) < 1e-4
    assert doc["nodes"][0]["translation"][1] == pytest.approx(sk.hips_height())
    assert len(humans(unpack(convert(Motion(rots, pos, 30.0, sk), hands=False)[0])[0])) == 22


def test_still_fingers_are_dropped_and_moving_ones_kept():
    names, parents, rest = soma_names()
    sk = named_skeleton(names, parents, rest)
    T = 20
    rots = np.tile(np.eye(3), (T, len(names), 1, 1))
    curl = axis_angle_to_matrix(np.array([0, 0, 0.25]))  # Kimodo: the same relaxed pose all along
    for n in names:
        if "Hand" in n and n not in ("LeftHand", "RightHand"):
            rots[:, names.index(n)] = curl
    pos = np.tile(rest[0], (T, 1))
    data, report = convert(Motion(rots, pos, 30.0, sk))
    assert not report.fingers and len(humans(unpack(data)[0])) == 22
    # A left index that really moves keeps the left hand's tracks, not the right one's
    rots[:, names.index("LeftHandIndex3")] = axis_angle_to_matrix(np.stack([np.zeros(T), np.zeros(T), np.linspace(0, 1, T)], -1))
    bones = humans(unpack(convert(Motion(rots, pos, 30.0, sk))[0])[0])
    assert "leftIndexIntermediate" in bones and "rightIndexIntermediate" not in bones


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
    assert load(tmp_path / "soma.npz").rots.shape[1] == len(names)

    np.savez(tmp_path / "am.npz", root_orient=poses[:, :3], pose_body=poses[:, 3:66], trans=trans, mocap_frame_rate=60)
    m = load(tmp_path / "am.npz")
    assert m.fps == 60 and m.rots.shape == (12, 22, 3, 3)


def test_command_line_converts_a_folder(tmp_path):
    poses, trans = still(12)
    np.savez(tmp_path / "a.npz", poses=poses, trans=trans)
    np.savez(tmp_path / "bad.npz", other=np.zeros(3))
    assert main([str(tmp_path), "-o", str(tmp_path / "out")]) == 1  # one file failed
    assert read_glb((tmp_path / "out" / "a.vrma").read_bytes())[0]["asset"]["version"] == "2.0"


def raised_right_hand(frames=40):
    """The right arm hangs (+Z turns the right arm down), then rises to the T-pose."""
    poses, trans = still(frames)
    poses[:, 17 * 3 + 2] = np.concatenate([np.full(frames // 2, 1.3), np.zeros(frames - frames // 2)])
    return from_axis_angle(poses, trans)


def test_a_hand_shape_follows_the_hand_up():
    data, report = convert(raised_right_hand(), shapes={"right": "fist"})
    doc, tr = unpack(data)
    bones = humans(doc)
    assert report.fingers and "rightIndexProximal" in bones and "leftIndexProximal" not in bones
    q = tr("rightIndexProximal")
    # Hanging: the relaxed curl (14 degrees); raised: the fist (85)
    assert angle_between(q[2], IDENTITY) == pytest.approx(14, abs=0.5)
    assert angle_between(q[-1], IDENTITY) == pytest.approx(85, abs=0.5)
    # The right fingers curl with +Z, as in the app's pose.ts
    assert q[-1, 2] > 0.5
    with pytest.raises(ValueError, match="shape"):
        convert(raised_right_hand(), shapes={"right": "peace"})


def test_turn_puts_the_clip_in_profile():
    poses, trans = still(10)
    data, _ = convert(from_axis_angle(poses, trans), turn=90)
    q = unpack(data)[1]("hips")[0]
    assert np.allclose(np.abs(q), [0, np.sin(np.pi / 4), 0, np.cos(np.pi / 4)], atol=1e-6)


def test_parts_are_cut_from_one_conversion():
    poses, trans = still(60)
    poses[:, 3] = np.linspace(0, 1, 60)  # the left leg lifts slowly all along
    trans[:, 0] += np.linspace(0, 1, 60)
    parts, report = convert_parts(from_axis_angle(poses, trans), [("enter", 0, 21), ("loop", 20, 50), ("exit", 49, 60)])
    enter = unpack(parts["enter"])[1]("leftUpperLeg")
    loop = unpack(parts["loop"])[1]("leftUpperLeg")
    exit_ = unpack(parts["exit"])[1]("leftUpperLeg")
    # Each part starts where the previous one ends
    assert np.allclose(enter[-1], loop[0], atol=1e-6) and np.allclose(loop[-1], exit_[0], atol=1e-6)
    assert len(loop) == 30 and report.frames == 60
    hips = unpack(parts["exit"])[1]("hips", "translation")
    assert np.allclose(hips[:, [0, 2]], 0)  # in place over the whole motion
    with pytest.raises(ValueError, match="outside"):
        convert_parts(from_axis_angle(poses, trans), [("x", 50, 70)])


def test_a_clip_spent_lying_down_keeps_the_format_s_up_axis(tmp_path):
    poses, trans = still(20)
    lying = axis_angle_to_matrix(np.array([-np.pi / 2, 0, 0]))  # on the back: the head points away from the camera
    rots = np.tile(np.eye(3), (20, 22, 1, 1))
    rots[:, 0] = lying
    np.savez(tmp_path / "ki.npz", local_rot_mats=rots, root_positions=trans)
    data, report = convert(load(tmp_path / "ki.npz"))
    assert report.up == "+y"
    assert angle_between(unpack(data)[1]("hips")[0], matrix_to_quat(lying)) < 0.05
    # Without a format that says it, the same pose would have been "stood up" (the AMASS guess)
    assert convert(from_axis_angle(np.concatenate([np.tile([-np.pi / 2, 0, 0], (20, 1)), poses[:, 3:]], 1), trans))[1].up != "+y"


def test_an_idle_turns_into_profile_while_it_enters_and_back_while_it_exits():
    poses, trans = still(60)
    cuts = [("enter", 0, 21), ("loop", 20, 41), ("exit", 40, 60)]
    ramp = turn_ramp(cuts, 60, 90)
    assert ramp[0] == 0 and ramp[20] == 90 and ramp[30] == 90 and ramp[40] == 90 and ramp[59] == 0
    parts, _ = convert_parts(from_axis_angle(poses, trans), cuts, turn=ramp)
    yaw = lambda q: np.degrees(2 * np.arctan2(q[..., 1], q[..., 3]))
    assert yaw(unpack(parts["enter"])[1]("hips")[0]) == pytest.approx(0, abs=1e-3)
    assert np.allclose(yaw(unpack(parts["loop"])[1]("hips")), 90, atol=1e-3)
    assert yaw(unpack(parts["exit"])[1]("hips")[-1]) == pytest.approx(0, abs=1e-3)
