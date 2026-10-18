# Decimate a GLB prop to a face budget (e.g. the 15k-face bicycles, which are
# placed by the hundred outside stations).
# Usage: blender -b --python scripts/blender/decimate.py -- in.glb out.glb 1800
import sys

import bpy

src, dst, budget = sys.argv[sys.argv.index("--") + 1:][:3]
budget = int(budget)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
total = sum(len(o.data.polygons) for o in meshes)
ratio = min(1.0, budget / max(1, total))
for o in meshes:
    m = o.modifiers.new("dec", "DECIMATE")
    m.ratio = ratio
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=m.name)
after = sum(len(o.data.polygons) for o in meshes)
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7)
print("DECIMATED", src, total, "->", after)
