# Generates realistic CC0 humans for NIHON with MPFB2 (MakeHuman for Blender)
# and bakes CMU motion-capture clips onto MPFB's CMU-compatible rig.
#
# Run (headless):
#   blender -b --python scripts/blender/make_humans.py -- \
#       --out assets-src/models/people --mocap /path/to/bvh [--only name]
#   then: node scripts/optimize-assets.mjs people
#
# Everything used is CC0 (MakeHuman system assets, MPFB output) or
# unrestricted (CMU Graphics Lab Motion Capture Database, cgspeed BVH).
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Quaternion, Vector

from bl_ext.user_default.mpfb.services.humanservice import HumanService

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--mocap", required=True)
ap.add_argument("--only", default="", help="comma-separated names; merged into the existing manifest")
ap.add_argument("--tex", type=int, default=512)
ap.add_argument("--idle", default="", help="override the idle clip: file.bvh:start:maxlen (QA)")
ap.add_argument("--gait", default="", help="override every character's gait (QA)")
args = ap.parse_args(argv)
os.makedirs(args.out, exist_ok=True)

# Japanese adults: mostly East Asian phenotype; tourists vary.
ASIAN = {"asian": 0.92, "caucasian": 0.05, "african": 0.03}
CAUC = {"asian": 0.05, "caucasian": 0.9, "african": 0.05}


def C(name, gender, age, skin, hair, clothes, race=ASIAN, weight=0.5, muscle=0.5, height=0.5, brows="eyebrow001", proxy="", season="any", gait="neutral", stoop=0.0):
    # season: "summer" (short sleeves / shorts), "winter" (jackets, long
    # sleeves only) or "any" (suits, shirts) - the game dresses its crowds
    # for the actual temperature.
    return dict(name=name, gender=gender, age=age, skin=skin, hair=hair, clothes=clothes, race=race,
                weight=weight, muscle=muscle, height=height, brows=brows, proxy=proxy, season=season, gait=gait, stoop=stoop)


SHOES_M = "shoes02/shoes02.mhclo"
SHOES_F = "shoes05/shoes05.mhclo"
CHARACTERS = [
    # The player (neutral, tourist-ready) - full mesh
    C("player_m", 1.0, 0.5, "young_asian_male", "short02", ["male_casualsuit04/male_casualsuit04.mhclo", SHOES_M], height=0.55, season="summer", gait="neutral"),
    C("player_m_w", 1.0, 0.5, "young_asian_male", "short02", ["male_casualsuit05/male_casualsuit05.mhclo", SHOES_M], height=0.55, season="winter", gait="neutral"),
    C("player_f", 0.0, 0.48, "young_asian_female", "bob02", ["female_casualsuit01/female_casualsuit01.mhclo", SHOES_F], brows="eyebrow009", season="summer", gait="light"),
    C("player_f_w", 0.0, 0.48, "young_asian_female", "bob02", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], brows="eyebrow009", season="winter", gait="light"),
    # Crowd archetypes (proxy body for performance)
    C("salaryman_a", 1.0, 0.56, "middleage_asian_male", "short02", ["male_worksuit01/male_worksuit01.mhclo", SHOES_M], weight=0.55, proxy="male_generic", gait="brisk"),
    C("salaryman_b", 1.0, 0.66, "middleage_asian_male", "short04", ["male_elegantsuit01/male_elegantsuit01.mhclo", SHOES_M], weight=0.6, height=0.45, brows="eyebrow003", proxy="male_generic", gait="steady"),
    C("salaryman_c", 1.0, 0.5, "young_asian_male", "short03", ["male_worksuit01/male_worksuit01.mhclo", SHOES_M], weight=0.45, height=0.6, proxy="male_generic", gait="relaxed"),
    C("office_f", 0.0, 0.52, "young_asian_female", "bob01", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], brows="eyebrow009", proxy="female_generic", gait="light"),
    C("young_f", 0.0, 0.42, "young_asian_female", "ponytail01", ["female_casualsuit02/female_casualsuit02.mhclo", SHOES_F], weight=0.42, brows="eyebrow010", proxy="female_generic", season="summer", gait="relaxed"),
    C("young_m", 1.0, 0.44, "young_asian_male", "short01", ["male_casualsuit02/male_casualsuit02.mhclo", SHOES_M], weight=0.45, proxy="male_generic", season="summer", gait="loose"),
    C("student_f", 0.0, 0.36, "young_asian_female", "long01", ["female_sportsuit01/female_sportsuit01.mhclo", SHOES_F], weight=0.4, height=0.42, brows="eyebrow010", proxy="female_generic", season="summer", gait="loose"),
    C("casual_m", 1.0, 0.6, "middleage_asian_male", "short02", ["male_casualsuit05/male_casualsuit05.mhclo", SHOES_M], weight=0.62, proxy="male_generic", gait="steady"),
    C("elder_m", 1.0, 0.86, "old_asian_male", "short04", ["male_casualsuit03/male_casualsuit03.mhclo", SHOES_M, "fedora01/fedora01.mhclo"], weight=0.5, height=0.4, brows="eyebrow006", proxy="male_generic", gait="slow", stoop=9),
    C("elder_f", 0.0, 0.86, "old_asian_female", "bob02", ["female_casualsuit01/female_casualsuit01.mhclo", SHOES_F], weight=0.55, height=0.35, brows="eyebrow011", proxy="female_generic", season="summer", gait="slow", stoop=11),
    C("tourist_m", 1.0, 0.5, "young_caucasian_male", "short01", ["male_casualsuit06/male_casualsuit06.mhclo", SHOES_M], race=CAUC, height=0.65, weight=0.55, proxy="male_generic", season="summer", gait="neutral"),
    C("tourist_f", 0.0, 0.47, "young_caucasian_female", "braid01", ["female_casualsuit02/female_casualsuit02.mhclo", SHOES_F], race=CAUC, height=0.55, brows="eyebrow009", proxy="female_generic", season="summer", gait="steady"),
    # Cold-weather counterparts: long sleeves and jackets.
    C("young_m_w", 1.0, 0.42, "young_asian_male", "short01", ["male_casualsuit01/male_casualsuit01.mhclo", SHOES_M], weight=0.45, proxy="male_generic", season="winter", gait="loose"),
    C("young_m2_w", 1.0, 0.47, "young_asian_male", "short03", ["male_casualsuit03/male_casualsuit03.mhclo", SHOES_M], weight=0.5, height=0.58, proxy="male_generic", season="winter", gait="relaxed"),
    C("young_f_w", 0.0, 0.42, "young_asian_female", "ponytail01", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], weight=0.42, brows="eyebrow010", proxy="female_generic", season="winter", gait="relaxed"),
    C("student_f_w", 0.0, 0.37, "young_asian_female", "long01", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], weight=0.4, height=0.42, brows="eyebrow010", proxy="female_generic", season="winter", gait="loose"),
    C("elder_f_w", 0.0, 0.84, "old_asian_female", "bob02", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], weight=0.55, height=0.35, brows="eyebrow011", proxy="female_generic", season="winter", gait="slow", stoop=11),
    C("tourist_m_w", 1.0, 0.5, "young_caucasian_male", "short01", ["male_casualsuit05/male_casualsuit05.mhclo", SHOES_M], race=CAUC, height=0.65, weight=0.55, proxy="male_generic", season="winter", gait="neutral"),
]

# Gaits: (bvh, start s, max cycle s). Each archetype walks like a different
# person (CMU subjects), so a crowd isn't one actor cloned.
WALKS = {
    "neutral": ("07_01.bvh", 0.8, 1.6),
    "brisk": ("07_12.bvh", 0.4, 1.4),
    "slow": ("08_04.bvh", 0.6, 2.0),
    "loose": ("16_15.bvh", 0.6, 1.6),
    "relaxed": ("35_01.bvh", 0.6, 1.6),
    "steady": ("39_01.bvh", 0.6, 1.6),
    "light": ("02_01.bvh", 0.6, 1.6),
}
RUN = ("09_01.bvh", 0.3, 1.0)
# A real standing idle: weight shifts, breathing, the odd glance.
IDLE = ("82_08.bvh", 0.5, 7.5)  # standing still for the first 8.5 s


def clear_scene():
    # read_factory_settings would unload the MPFB extension; wipe data instead.
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.actions, bpy.data.node_groups):
        for d in list(coll):
            coll.remove(d)
    try:
        bpy.ops.preferences.addon_enable(module="io_anim_bvh")
    except Exception:
        pass


def make_human(spec):
    info = HumanService._create_default_human_info_dict()
    info["name"] = spec["name"]
    ph = info["phenotype"]
    ph["gender"] = spec["gender"]
    ph["age"] = spec["age"]
    ph["weight"] = spec["weight"]
    ph["muscle"] = spec["muscle"]
    ph["height"] = spec["height"]
    ph["race"] = spec["race"]
    info["rig"] = "cmu_mb"
    info["skin_mhmat"] = f"skins/{spec['skin']}/{spec['skin']}.mhmat"
    info["skin_material_type"] = "GAMEENGINE"
    info["eyes_material_type"] = "GAMEENGINE"
    info["clothes_material_type"] = "GAMEENGINE"
    info["eyes"] = "low-poly/low-poly.mhclo"
    info["eyebrows"] = f"{spec['brows']}/{spec['brows']}.mhclo"
    info["eyelashes"] = "eyelashes01/eyelashes01.mhclo"
    info["hair"] = f"{spec['hair']}/{spec['hair']}.mhclo"
    info["clothes"] = spec["clothes"]
    info["proxy"] = f"{spec['proxy']}/{spec['proxy']}.proxy" if spec["proxy"] else ""
    info["alternative_materials"] = {}
    settings = HumanService.get_default_deserialization_settings()
    settings["subdiv_levels"] = 0
    settings["override_skin_model"] = "GAMEENGINE"
    settings["mask_helpers"] = True
    basemesh = HumanService.deserialize_from_dict(info, settings)
    return basemesh


def find_rig():
    for o in bpy.data.objects:
        if o.type == "ARMATURE":
            return o
    raise RuntimeError("no rig")


def import_bvh(path):
    bpy.ops.import_anim.bvh(filepath=path, axis_forward="Y", axis_up="Z", rotate_mode="XYZ",
                            use_fps_scale=False, update_scene_fps=False, update_scene_duration=False)
    return bpy.context.object


def bone_order(arm):
    out = []

    def walk(b):
        out.append(b.name)
        for c in b.children:
            walk(c)

    for b in arm.data.bones:
        if b.parent is None:
            walk(b)
    return out


def pose_vector(src, frame):
    bpy.context.scene.frame_set(frame)
    v = []
    for pb in src.pose.bones:
        if pb.name == "Hips":
            continue
        q = pb.matrix.to_quaternion()
        v.extend([q.w, q.x, q.y, q.z])
    return v


def find_loop(src, start, max_len, fps):
    """Pick [a, b) where pose(b) ~= pose(a): a seamless gait cycle."""
    f0 = int(src.animation_data.action.frame_range[0])
    f1 = int(src.animation_data.action.frame_range[1])
    a0 = f0 + int(start * fps)
    best = (1e9, a0, a0 + int(max_len * fps))
    poses = {}

    def P(f):
        if f not in poses:
            poses[f] = pose_vector(src, f)
        return poses[f]

    for a in range(a0, min(f1, a0 + int(0.4 * fps)), 2):
        for b in range(a + int(max_len * 0.55 * fps), min(f1, a + int(max_len * fps)), 1):
            d = sum((x - y) ** 2 for x, y in zip(P(a), P(b)))
            if d < best[0]:
                best = (d, a, b)
    return best[1], best[2]


# Bones whose rest direction is a convention of the skeleton, not anatomy:
# the CMU clavicle points 15 deg up, MakeHuman's 11 deg down; CMU hip joints
# point down and forward, MakeHuman's sideways; neck and head segments are
# split differently. These take the actor's rotation *relative to rest*, so
# the target keeps its own (natural) shoulders, pelvis and neck.
CONNECTORS = {"Hips", "LHipJoint", "RHipJoint", "LowerBack", "Spine", "Spine1", "Neck", "Neck1", "Head", "LeftShoulder", "RightShoulder"}
# Mocap hands are noise (CMU has a single wrist marker): hands and fingers
# stay in their relaxed rest relation to the forearm.
RIGID = {"LeftHand", "RightHand", "LThumb", "RThumb", "LeftFingerBase", "RightFingerBase", "LeftHandFinger1", "RightHandFinger1", "LeftHandIndex1", "RightHandIndex1"}
FEET = ("LeftFoot", "RightFoot")
TOES = ("LeftToeBase", "RightToeBase")


def bake_clip(rig, bvh_path, clip, start, max_len, in_place, ground="stance", stoop=0.0):
    """Rest-relative retarget of a CMU clip onto the MPFB cmu_mb rig.

    World-space rotations throughout. For every bone, the actor's rotation
    away from their own rest pose (D = S_pose * S_rest^-1) is applied to the
    target's rest pose. Limbs first swing the target's rest onto the actor's
    rest direction (MakeHuman stands in an A-pose with straight legs, CMU in a
    T-pose with legs 20 deg apart), so an actor standing straight makes the
    target stand straight; twist (palms, feet) comes along. The clip's mean
    heading is removed so the character walks along its own facing, and the
    pelvis height is solved each frame so the lowest foot touches the ground.
    Returns (duration s, stride m per cycle).
    """
    src = import_bvh(bvh_path)
    src_fps = 120
    act = src.animation_data.action
    if max_len > 0:
        a, b = find_loop(src, start, max_len, src_fps)
    else:
        a = int(act.frame_range[0]) + 10
        b = a + 60
    sb = src.data.bones
    tb = rig.data.bones
    names = [n for n in bone_order(rig) if n in sb or n in RIGID]
    qConv = Quaternion((1, 0, 0), math.radians(90))
    Mconv = qConv.to_matrix().to_4x4()
    qWs = qConv @ src.matrix_world.to_quaternion()
    qWt = rig.matrix_world.to_quaternion()
    qWt_inv = qWt.inverted()
    Rt = {n: tb[n].matrix_local.copy() for n in names}
    qRt = {n: qWt @ tb[n].matrix_local.to_quaternion() for n in names}
    qRs = {n: qWs @ sb[n].matrix_local.to_quaternion() for n in names if n in sb}
    Y = Vector((0, 1, 0))
    # Target rest, posed into the actor's rest (limbs only).
    qRtT = {}
    for n in names:
        if n in CONNECTORS or n in RIGID or n not in qRs:
            qRtT[n] = qRt[n]
        else:
            qRtT[n] = (qRt[n] @ Y).rotation_difference(qRs[n] @ Y) @ qRt[n]
    sw = src.matrix_world.to_scale()[0]
    tw = rig.matrix_world.to_scale()[0]
    src_leg = (sb["LeftUpLeg"].head_local - sb["LeftFoot"].head_local).length * sw
    dst_leg = (tb["LeftUpLeg"].head_local - tb["LeftFoot"].head_local).length * tw
    k = dst_leg / src_leg if src_leg > 0 else 1.0
    up = Vector((0, 0, 1))
    step = 4  # 120 -> 30 fps
    frames = list(range(a, b + 1, step))

    # Mean heading of the actor's pelvis over the cycle (circular mean).
    fwd = Vector((0, -1, 0))
    sx = sy = 0.0
    hips_path = []
    for f in frames:
        bpy.context.scene.frame_set(f)
        D = (qWs @ src.pose.bones["Hips"].matrix.to_quaternion()) @ qRs["Hips"].inverted()
        h = D @ fwd
        ang = math.atan2(h.y, h.x)
        sx += math.cos(ang)
        sy += math.sin(ang)
        hips_path.append(Mconv @ src.matrix_world @ src.pose.bones["Hips"].matrix.to_translation())
    mean = math.atan2(sy, sx)
    R = Quaternion(up, math.atan2(fwd.y, fwd.x) - mean)
    travel = R @ (hips_path[-1] - hips_path[0])
    stride = Vector((travel.x, travel.y, 0)).length * k

    # Rest heights of ankle and toe tip (armature space; the rig is Z-up).
    ank0 = min(Rt[n].to_translation().z for n in FEET)
    toe0 = min(tb[n].tail_local.z for n in TOES)

    rig.animation_data_create()
    action = bpy.data.actions.new(clip)
    rig.animation_data.action = action
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    to_arm = rig.matrix_world.inverted().to_3x3()
    side = Vector((1, 0, 0))

    def solve(fix):
        poses = []
        for f in frames:
            bpy.context.scene.frame_set(f)
            pose_t = {}
            for n in names:
                parent = tb[n].parent
                if n in RIGID and parent is not None and parent.name in pose_t:
                    rest_local = Rt[parent.name].inverted() @ Rt[n]
                    pose_t[n] = pose_t[parent.name] @ rest_local
                    continue
                Ps = src.pose.bones[n].matrix
                D = (qWs @ Ps.to_quaternion()) @ qRs[n].inverted()
                q_world = R @ D @ qRtT[n]
                if n in fix:
                    q_world = fix[n] @ q_world
                q_arm = qWt_inv @ q_world
                if parent is not None and parent.name in pose_t:
                    rest_local = Rt[parent.name].inverted() @ Rt[n]
                    head = (pose_t[parent.name] @ rest_local).to_translation()
                else:
                    hs = Mconv @ src.matrix_world @ Ps.to_translation()
                    d = R @ ((hs - hips_path[0]) * k)
                    if in_place:
                        d = up * d.dot(up)
                    head = Rt[n].to_translation() + to_arm @ d
                M = q_arm.to_matrix().to_4x4()
                M.translation = head
                pose_t[n] = M
            # Lowest contact point (heel ~ ankle, or toe tip) relative to rest.
            lows = []
            for fn, tn in zip(FEET, TOES):
                ank = pose_t[fn].translation.z - ank0
                tip = (pose_t[tn] @ Vector((0, tb[tn].length, 0))).z - toe0
                lows.append(min(ank, tip))
            poses.append((pose_t, min(lows)))
        return poses

    def head_pitch(q):
        v = q @ Y
        return math.atan2(-v.y, v.z)

    # Actors often watch the floor (markers, a treadmill edge): level the
    # gaze. Keep the head's motion, move its mean to just below the target's
    # neutral rest gaze, bending the whole neck rather than just the skull.
    # Age: elders walk with a rounded upper back, neck carried forward.
    st = math.radians(stoop)
    pitch = {"LowerBack": st * 0.25, "Spine": st * 0.6, "Spine1": st, "Neck": st, "Neck1": st, "Head": st} if stoop else {}
    roll = {}

    def fixes():
        f = {n: Quaternion(side, a) for n, a in pitch.items()}
        for n, a in roll.items():
            f[n] = Quaternion(Vector((0, 1, 0)), a) @ f.get(n, Quaternion())
        return f

    poses = solve(fixes())
    mean_pitch = sum(head_pitch(p["Head"].to_quaternion()) for p, _ in poses) / len(poses)
    rest_pitch = head_pitch(tb["Head"].matrix_local.to_quaternion())
    c = (rest_pitch + math.radians(4)) - mean_pitch
    c = max(-math.radians(35), min(math.radians(35), c))
    if abs(c) > math.radians(2):
        for n, w in (("Neck", 0.45), ("Neck1", 0.75), ("Head", 1.0)):
            pitch[n] = pitch.get(n, 0.0) + c * w
        poses = solve(fixes())
    # Step width: some actors walk a tightrope (feet passing in line), which
    # on a different body reads as knock-kneed or legs crossing. Swing both
    # thighs out just enough that the ankles always clear ~8 cm.
    gap = min(p["LeftFoot"].translation.x - p["RightFoot"].translation.x for p, _ in poses)
    if clip != "idle" and gap < 0.09:
        thigh = tb["LeftUpLeg"].length
        a = math.asin(min(0.5, (0.09 - gap) / 2 / thigh))
        roll["LeftUpLeg"] = -a
        roll["RightUpLeg"] = a
        poses = solve(fixes())
    if ground == "stance":
        lifts = [-g for _, g in poses]  # every frame: a foot is planted
    else:
        lifts = [-min(g for _, g in poses)] * len(poses)  # flight phases: lowest frame only
    root = names[0]
    for out_frame, ((pose_t, _), lift) in enumerate(zip(poses, lifts)):
        for n in names:
            M = pose_t[n].copy()
            parent = tb[n].parent
            if parent is not None and parent.name in pose_t:
                rest_local = Rt[parent.name].inverted() @ Rt[n]
                basis = rest_local.inverted() @ pose_t[parent.name].inverted() @ M
            else:
                M.translation = M.translation + Vector((0, 0, lift))
                basis = Rt[n].inverted() @ M
            pbt = rig.pose.bones[n]
            loc, q, _ = basis.decompose()
            pbt.rotation_quaternion = q
            pbt.keyframe_insert("rotation_quaternion", frame=out_frame)
            if n == root:
                pbt.location = loc
                pbt.keyframe_insert("location", frame=out_frame)
    bpy.data.objects.remove(src, do_unlink=True)
    track = rig.animation_data.nla_tracks.new()
    track.name = clip
    strip = track.strips.new(clip, 0, action)
    strip.name = clip
    rig.animation_data.action = None
    return (len(frames) - 1) / 30.0, stride


def downscale_images(px):
    for img in bpy.data.images:
        n = img.name.lower()
        if "eye" in n or "brow" in n or "lash" in n:
            px_i = min(px, 256)
        else:
            px_i = px
        if img.size[0] > px_i:
            ratio = px_i / img.size[0]
            img.scale(px_i, max(1, int(img.size[1] * ratio)))
            continue
        if False:
            ratio = px / img.size[0]
            img.scale(px, max(1, int(img.size[1] * ratio)))


def export(spec, path):
    rig = find_rig()
    # glTF keys are written in seconds from the scene frame rate: bake at 30.
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1
    durations, speeds = {}, {}
    idle = IDLE
    if args.idle:
        f, a, b = args.idle.split(":")
        idle = (f, float(a), float(b))
    plan = [("walk", WALKS[args.gait or spec["gait"]], "stance"), ("run", RUN, "flight"), ("idle", idle, "stance")]
    for clip, (bvh, start, max_len), ground in plan:
        dur, stride = bake_clip(rig, os.path.join(args.mocap, bvh), clip, start, max_len, True, ground, spec["stoop"] if clip != "run" else 0.0)
        durations[clip] = round(dur, 4)
        speeds[clip] = round(stride / dur, 3) if clip != "idle" else 0
    downscale_images(args.tex if not spec["name"].startswith("player") else max(args.tex, 1024))
    # Hide helper geometry
    for o in bpy.data.objects:
        if o.type == "MESH" and ("helper" in o.name.lower()):
            o.hide_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_skins=True,
        export_morph=False,
        export_image_format="JPEG",
        export_jpeg_quality=74,
        export_apply=True,
        export_yup=True,
        use_visible=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=7,
    )
    return durations, speeds


manifest = []
for spec in CHARACTERS:
    if args.only and spec["name"] not in args.only.split(","):
        continue
    clear_scene()
    make_human(spec)
    out = os.path.join(args.out, spec["name"] + ".glb")
    durations, speeds = export(spec, out)
    manifest.append({"name": spec["name"], "file": spec["name"] + ".glb", "gender": "m" if spec["gender"] > 0.5 else "f",
                     "age": spec["age"], "season": spec["season"], "gait": spec["gait"], "clips": durations, "speeds": speeds})
    print("EXPORTED", out, os.path.getsize(out) // 1024, "KB", durations)

path = os.path.join(args.out, "manifest.json")
if args.only and os.path.exists(path):
    done = {m["name"]: m for m in manifest}
    old = json.load(open(path))
    merged = [done.pop(m["name"], m) for m in old] + list(done.values())
    manifest = merged
# Season tags for entries baked before they existed.
seasons = {c["name"]: c["season"] for c in CHARACTERS}
for m in manifest:
    m["season"] = seasons.get(m["name"], m.get("season", "any"))
with open(path, "w") as f:
    json.dump(manifest, f, indent=1)
