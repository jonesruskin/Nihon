# Generates realistic CC0 humans for NIHON with MPFB2 (MakeHuman for Blender)
# and bakes CMU motion-capture clips onto MPFB's CMU-compatible rig.
#
# Run (headless):
#   blender -b --python scripts/blender/make_humans.py -- \
#       --out public/models/people --mocap /path/to/bvh [--only name]
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
args = ap.parse_args(argv)
os.makedirs(args.out, exist_ok=True)

# Japanese adults: mostly East Asian phenotype; tourists vary.
ASIAN = {"asian": 0.92, "caucasian": 0.05, "african": 0.03}
CAUC = {"asian": 0.05, "caucasian": 0.9, "african": 0.05}


def C(name, gender, age, skin, hair, clothes, race=ASIAN, weight=0.5, muscle=0.5, height=0.5, brows="eyebrow001", proxy="", season="any"):
    # season: "summer" (short sleeves / shorts), "winter" (jackets, long
    # sleeves only) or "any" (suits, shirts) - the game dresses its crowds
    # for the actual temperature.
    return dict(name=name, gender=gender, age=age, skin=skin, hair=hair, clothes=clothes, race=race,
                weight=weight, muscle=muscle, height=height, brows=brows, proxy=proxy, season=season)


SHOES_M = "shoes02/shoes02.mhclo"
SHOES_F = "shoes05/shoes05.mhclo"
CHARACTERS = [
    # The player (neutral, tourist-ready) - full mesh
    C("player_m", 1.0, 0.5, "young_asian_male", "short02", ["male_casualsuit04/male_casualsuit04.mhclo", SHOES_M], height=0.55, season="summer"),
    C("player_m_w", 1.0, 0.5, "young_asian_male", "short02", ["male_casualsuit05/male_casualsuit05.mhclo", SHOES_M], height=0.55, season="winter"),
    C("player_f", 0.0, 0.48, "young_asian_female", "bob02", ["female_casualsuit01/female_casualsuit01.mhclo", SHOES_F], brows="eyebrow009", season="summer"),
    C("player_f_w", 0.0, 0.48, "young_asian_female", "bob02", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], brows="eyebrow009", season="winter"),
    # Crowd archetypes (proxy body for performance)
    C("salaryman_a", 1.0, 0.56, "middleage_asian_male", "short02", ["male_worksuit01/male_worksuit01.mhclo", SHOES_M], weight=0.55, proxy="male_generic"),
    C("salaryman_b", 1.0, 0.66, "middleage_asian_male", "short04", ["male_elegantsuit01/male_elegantsuit01.mhclo", SHOES_M], weight=0.6, height=0.45, brows="eyebrow003", proxy="male_generic"),
    C("salaryman_c", 1.0, 0.5, "young_asian_male", "short03", ["male_worksuit01/male_worksuit01.mhclo", SHOES_M], weight=0.45, height=0.6, proxy="male_generic"),
    C("office_f", 0.0, 0.52, "young_asian_female", "bob01", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], brows="eyebrow009", proxy="female_generic"),
    C("young_f", 0.0, 0.42, "young_asian_female", "ponytail01", ["female_casualsuit02/female_casualsuit02.mhclo", SHOES_F], weight=0.42, brows="eyebrow010", proxy="female_generic", season="summer"),
    C("young_m", 1.0, 0.44, "young_asian_male", "short01", ["male_casualsuit02/male_casualsuit02.mhclo", SHOES_M], weight=0.45, proxy="male_generic", season="summer"),
    C("student_f", 0.0, 0.36, "young_asian_female", "long01", ["female_sportsuit01/female_sportsuit01.mhclo", SHOES_F], weight=0.4, height=0.42, brows="eyebrow010", proxy="female_generic", season="summer"),
    C("casual_m", 1.0, 0.6, "middleage_asian_male", "short02", ["male_casualsuit05/male_casualsuit05.mhclo", SHOES_M], weight=0.62, proxy="male_generic"),
    C("elder_m", 1.0, 0.86, "old_asian_male", "short04", ["male_casualsuit03/male_casualsuit03.mhclo", SHOES_M, "fedora01/fedora01.mhclo"], weight=0.5, height=0.4, brows="eyebrow006", proxy="male_generic"),
    C("elder_f", 0.0, 0.86, "old_asian_female", "bob02", ["female_casualsuit01/female_casualsuit01.mhclo", SHOES_F], weight=0.55, height=0.35, brows="eyebrow011", proxy="female_generic", season="summer"),
    C("tourist_m", 1.0, 0.5, "young_caucasian_male", "short01", ["male_casualsuit06/male_casualsuit06.mhclo", SHOES_M], race=CAUC, height=0.65, weight=0.55, proxy="male_generic", season="summer"),
    C("tourist_f", 0.0, 0.47, "young_caucasian_female", "braid01", ["female_casualsuit02/female_casualsuit02.mhclo", SHOES_F], race=CAUC, height=0.55, brows="eyebrow009", proxy="female_generic", season="summer"),
    # Cold-weather counterparts: long sleeves and jackets.
    C("young_m_w", 1.0, 0.42, "young_asian_male", "short01", ["male_casualsuit01/male_casualsuit01.mhclo", SHOES_M], weight=0.45, proxy="male_generic", season="winter"),
    C("young_m2_w", 1.0, 0.47, "young_asian_male", "short03", ["male_casualsuit03/male_casualsuit03.mhclo", SHOES_M], weight=0.5, height=0.58, proxy="male_generic", season="winter"),
    C("young_f_w", 0.0, 0.42, "young_asian_female", "ponytail01", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], weight=0.42, brows="eyebrow010", proxy="female_generic", season="winter"),
    C("student_f_w", 0.0, 0.37, "young_asian_female", "long01", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], weight=0.4, height=0.42, brows="eyebrow010", proxy="female_generic", season="winter"),
    C("elder_f_w", 0.0, 0.84, "old_asian_female", "bob02", ["female_elegantsuit01/female_elegantsuit01.mhclo", SHOES_F], weight=0.55, height=0.35, brows="eyebrow011", proxy="female_generic", season="winter"),
    C("tourist_m_w", 1.0, 0.5, "young_caucasian_male", "short01", ["male_casualsuit05/male_casualsuit05.mhclo", SHOES_M], race=CAUC, height=0.65, weight=0.55, proxy="male_generic", season="winter"),
]

# (clip name, bvh file, start sec, max cycle length sec, in-place)
CLIPS = [
    ("walk", "07_01.bvh", 0.8, 1.6, True),
    ("run", "09_01.bvh", 0.3, 1.0, True),
    ("idle", "07_01.bvh", 0.0, 0.0, True),
]


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


def parent_is_root(bone):
    return bone.parent is None


def bake_clip(rig, bvh_path, clip, start, max_len, in_place):
    """Direction-aligned retarget: works across different rest poses
    (MakeHuman A-pose vs. BVH T-pose)."""
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
    names = [n for n in bone_order(rig) if n in sb]
    # Work in world space with pure rotations: the BVH armature carries an
    # object-level axis conversion, the MPFB rig an object-level scale.
    # The BVH armature stays Y-up even when imported with Z-up axes:
    # rotate it into Blender's Z-up frame explicitly.
    qConv = Quaternion((1, 0, 0), math.radians(90))
    Mconv = qConv.to_matrix().to_4x4()
    qWs = qConv @ src.matrix_world.to_quaternion()
    qWt = rig.matrix_world.to_quaternion()
    Rt = {n: tb[n].matrix_local.copy() for n in names}  # target armature space (for hierarchy)
    qRs = {n: qWs @ sb[n].matrix_local.to_quaternion() for n in names}
    qRt = {n: qWt @ tb[n].matrix_local.to_quaternion() for n in names}
    C = {}
    for n in names:
        ds = qRs[n] @ Vector((0, 1, 0))
        dt = qRt[n] @ Vector((0, 1, 0))
        C[n] = dt.rotation_difference(ds)
    sw = src.matrix_world.to_scale()[0]
    tw = rig.matrix_world.to_scale()[0]
    src_leg = (sb["LeftUpLeg"].head_local - sb["LeftFoot"].head_local).length * sw
    dst_leg = (tb["LeftUpLeg"].head_local - tb["LeftFoot"].head_local).length * tw
    k = dst_leg / src_leg if src_leg > 0 else 1.0
    up_world = Vector((0, 0, 1))

    rig.animation_data_create()
    action = bpy.data.actions.new(clip)
    rig.animation_data.action = action
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    step = 4 if max_len > 0 else 30  # 120 -> 30 fps
    hips0 = None
    out_frame = 0
    qWt_inv = qWt.inverted()
    for f in range(a, b + 1, step):
        bpy.context.scene.frame_set(f)
        pose_t = {}
        for n in names:
            Ps = src.pose.bones[n].matrix
            qPs = qWs @ Ps.to_quaternion()
            if parent_is_root(tb[n]):
                # Pelvis: full orientation (facing, tilt, twist).
                delta = qPs @ qRs[n].inverted()
                q_world = delta @ C[n] @ qRt[n]
            else:
                # Limbs/spine: swing the rest bone onto the source bone's
                # current direction. Matching directions bone by bone puts every
                # joint where the actor's was, independent of rest-pose twist.
                ds_pose = qPs @ Vector((0, 1, 0))
                dt_rest = qRt[n] @ Vector((0, 1, 0))
                q_world = dt_rest.rotation_difference(ds_pose) @ qRt[n]
            q_arm = qWt_inv @ q_world  # back to target armature space
            parent = tb[n].parent
            if parent is not None and parent.name in pose_t:
                rest_local = Rt[parent.name].inverted() @ Rt[n]
                head = (pose_t[parent.name] @ rest_local).to_translation()
            else:
                hs = Mconv @ src.matrix_world @ Ps.to_translation()
                if hips0 is None:
                    hips0 = hs.copy()
                d = (hs - hips0) * k
                if in_place:
                    d = up_world * d.dot(up_world)
                d_arm = (rig.matrix_world.inverted().to_3x3()) @ d
                head = Rt[n].to_translation() + d_arm
            M = q_arm.to_matrix().to_4x4()
            M.translation = head
            pose_t[n] = M
            if parent is not None and parent.name in pose_t:
                rest_local = Rt[parent.name].inverted() @ Rt[n]
                basis = rest_local.inverted() @ pose_t[parent.name].inverted() @ M
            else:
                basis = Rt[n].inverted() @ M
            pbt = rig.pose.bones[n]
            loc, q, _ = basis.decompose()
            pbt.rotation_quaternion = q
            pbt.keyframe_insert("rotation_quaternion", frame=out_frame)
            if parent is None:
                pbt.location = loc
                pbt.keyframe_insert("location", frame=out_frame)
        out_frame += 1
    bpy.data.objects.remove(src, do_unlink=True)
    track = rig.animation_data.nla_tracks.new()
    track.name = clip
    strip = track.strips.new(clip, 0, action)
    strip.name = clip
    rig.animation_data.action = None
    return out_frame / 30.0


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
    durations = {}
    for clip, bvh, start, max_len, in_place in CLIPS:
        durations[clip] = bake_clip(rig, os.path.join(args.mocap, bvh), clip, start, max_len, in_place)
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
    return durations


manifest = []
for spec in CHARACTERS:
    if args.only and spec["name"] not in args.only.split(","):
        continue
    clear_scene()
    make_human(spec)
    out = os.path.join(args.out, spec["name"] + ".glb")
    durations = export(spec, out)
    manifest.append({"name": spec["name"], "file": spec["name"] + ".glb", "gender": "m" if spec["gender"] > 0.5 else "f",
                     "age": spec["age"], "season": spec["season"], "clips": durations})
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
