# Normalises downloaded CC-BY / CC0 models (Objaverse) for NIHON:
# orientation (forward -Z, up +Y in glTF), real-world scale, ground origin,
# automatic wheel separation for vehicles, decimation, texture downsizing,
# Draco export.
#
#   blender -b --python scripts/blender/optimize_assets.py -- --src DIR --out public/models/objs [--only id]
import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--only", default="")
args = ap.parse_args(argv)
os.makedirs(args.out, exist_ok=True)

# id: (front axis in glTF space, size key, size metres, max faces, max texture, wheels?)
ASSETS = {
    "kei_truck_minicab": ("-x", "length", 3.395, 20000, 512, True),
    "kei_car_generic": ("+z", "length", 3.395, 20000, 512, True),
    "kei_delivery": ("+z", "length", 3.395, 20000, 512, True),
    "kei_truck_vintage": ("-x", "length", 3.0, 20000, 512, True),
    "sedan_86": ("-x", "length", 4.69, 30000, 512, True),
    "sedan_2010": ("-x", "length", 4.85, 30000, 512, True),
    "light_truck_90": ("+x", "length", 4.69, 30000, 512, True),
    "light_truck_07": ("-x", "length", 4.69, 30000, 512, True),
    "box_truck": ("+x", "length", 4.7, 30000, 512, True),
    "pickup_jp": ("-x", "length", 4.7, 30000, 512, True),
    "bus_erga_mio": ("+x", "length", 10.5, 30000, 2048, True),
    "bus_town": ("+x", "length", 10.5, 40000, 512, True),
    "torii": ("+x", "height", 5.5, 20000, 1024, False),
    "lantern_old": ("+z", "height", 2.0, 8000, 512, False),
    "lantern_stone": ("+z", "height", 1.3, 8000, 512, False),
    "vending_soft": ("+z", "height", 1.83, 2000, 1024, False),
    "vending_red": ("+z", "height", 1.83, 12000, 512, False),
    "postbox_red": ("+z", "height", 1.35, 4000, 512, False),
    "bicycle": ("+x", "length", 1.75, 15000, 512, False),
    "bicycle_yellow": ("+x", "length", 1.8, 15000, 512, False),
    "neon_vertical": ("+z", "height", 3.4, 8000, 512, False),
    "neon_street": ("+z", "height", 2.8, 8000, 512, False),
    "tree_sakura": ("+z", "height", 7.0, 25000, 1024, False),
    "tree_jmaple": ("+z", "height", 5.5, 25000, 1024, False),
    "bamboo": ("+z", "height", 11.0, 12000, 1024, False),
    "bamboo_bush": ("+z", "height", 3.0, 8000, 512, False),
    "train_ginza": ("+x", "length", 96.0, 30000, 1024, False),
}

ROT = {"+x": 90, "-x": -90, "+z": 180, "-z": 0}  # degrees about Blender Z


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def join_all():
    objs = mesh_objects()
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    # Bake parents/transforms into the meshes first.
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(objs) > 1:
        bpy.ops.object.join()
    for o in list(bpy.context.scene.objects):
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    return bpy.context.view_layer.objects.active


def bbox(o):
    # bound_box is cached until the depsgraph re-evaluates.
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


def normalise(obj, front, key, size):
    obj.rotation_mode = "XYZ"  # glTF import uses quaternions; euler would be ignored
    obj.rotation_euler = (0, 0, math.radians(ROT[front]))
    bpy.ops.object.transform_apply(rotation=True)
    mn, mx = bbox(obj)
    dims = mx - mn
    # After rotation, length is along Blender Y (glTF -Z forward), height along Z.
    cur = dims.y if key == "length" else dims.z
    s = size / max(cur, 1e-6)
    obj.scale = (s, s, s)
    bpy.ops.object.transform_apply(scale=True)
    mn, mx = bbox(obj)
    obj.location = (-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)
    bpy.ops.object.transform_apply(location=True)


def split_wheels(obj):
    """Separate loose parts; islands that are low, round in side view and
    near the four corners become wheel_FL/FR/RL/RR."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    parts = mesh_objects()
    mn_all = Vector((1e9, 1e9, 1e9))
    mx_all = Vector((-1e9, -1e9, -1e9))
    for p in parts:
        a, b = bbox(p)
        mn_all = Vector(map(min, mn_all, a))
        mx_all = Vector(map(max, mx_all, b))
    H = mx_all.z - mn_all.z
    corners = {}
    body = []
    for p in parts:
        a, b = bbox(p)
        c = (a + b) / 2
        d = b - a
        low = a.z < mn_all.z + H * 0.08 and b.z < mn_all.z + H * 0.55
        roundish = d.y > 0.05 and abs(d.y - d.z) < 0.35 * max(d.y, d.z)
        outer = abs(c.x) > (mx_all.x - mn_all.x) * 0.22
        inner_hub = d.z < H * 0.5 and c.z < mn_all.z + H * 0.4 and abs(c.x) > (mx_all.x - mn_all.x) * 0.18
        if (low and roundish and outer) or (inner_hub and roundish and d.x < 0.5):
            side = "L" if c.x < 0 else "R"
            end = "F" if c.y > 0 else "R"
            corners.setdefault(end + side, []).append(p)
        else:
            body.append(p)
    # Require a plausible set; otherwise keep everything as body.
    if len(corners) < 4:
        body = parts
        corners = {}

    def join(objs, name):
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        o.name = name
        o.data.name = name
        return o

    out = {"body": join(body, "body")}
    for k, objs in corners.items():
        w = join(objs, "wheel_" + k)
        a, b = bbox(w)
        c = (a + b) / 2
        bpy.context.scene.cursor.location = c
        bpy.ops.object.select_all(action="DESELECT")
        w.select_set(True)
        bpy.context.view_layer.objects.active = w
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
        out["wheel_" + k] = w
    return out


def decimate(obj, max_faces):
    n = len(obj.data.polygons)
    if n <= max_faces:
        return
    m = obj.modifiers.new("dec", "DECIMATE")
    m.ratio = max_faces / n
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier="dec")


def shrink_textures(px):
    for img in bpy.data.images:
        if img.size[0] > px or img.size[1] > px:
            r = px / max(img.size[0], img.size[1])
            img.scale(max(1, int(img.size[0] * r)), max(1, int(img.size[1] * r)))


report = {}
for aid, (front, key, size, max_faces, max_tex, wheels) in ASSETS.items():
    if args.only and aid != args.only:
        continue
    src = os.path.join(args.src, aid + ".glb")
    if not os.path.exists(src):
        print("MISSING", aid)
        continue
    reset()
    bpy.ops.import_scene.gltf(filepath=src)
    obj = join_all()
    normalise(obj, front, key, size)
    parts = split_wheels(obj) if wheels else {"body": obj}
    if not wheels:
        obj.name = "body"
    for name, o in parts.items():
        decimate(o, max_faces if name == "body" else 1500)
    shrink_textures(max_tex)
    out = os.path.join(args.out, aid + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_image_format="AUTO",
        export_jpeg_quality=80,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=7,
        export_yup=True,
        export_apply=True,
    )
    mn, mx = (Vector((1e9,) * 3), Vector((-1e9,) * 3))
    for o in mesh_objects():
        a, b = bbox(o)
        mn = Vector(map(min, mn, a))
        mx = Vector(map(max, mx, b))
    d = mx - mn
    report[aid] = {
        "kb": os.path.getsize(out) // 1024,
        "faces": sum(len(o.data.polygons) for o in mesh_objects()),
        "dims": [round(d.x, 2), round(d.z, 2), round(d.y, 2)],  # glTF x, y(up), z
        "wheels": sorted(k for k in parts if k.startswith("wheel_")),
    }
    print("ASSET", aid, json.dumps(report[aid]))

if not args.only:
    with open(os.path.join(args.out, "assets.json"), "w") as f:
        json.dump(report, f, indent=1)
