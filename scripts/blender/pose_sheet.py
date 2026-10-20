# QA for character animation (gate P): renders a contact sheet of a GLB's
# clips (front and side, several phases) and measures posture by forward
# kinematics, so "do they walk like people?" is answered with numbers and a
# picture rather than by eye in the game.
#
#   blender -b --python scripts/blender/pose_sheet.py -- in.glb out_dir [clip,clip]
#
# Writes out_dir/<name>_<clip>.png (2 rows: front, side) and prints one JSON
# line per clip with the measurements.
import bpy, json, math, os, sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
want = args[2].split(',') if len(args) > 2 else None
os.makedirs(out, exist_ok=True)
name = os.path.splitext(os.path.basename(src))[0]
PHASES = 6

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
scn = bpy.context.scene
# Cycles on the CPU: headless machines have no GL for Workbench/EEVEE.
scn.render.engine = 'CYCLES'
scn.cycles.device = 'CPU'
scn.cycles.samples = 6
scn.cycles.use_denoising = False
scn.cycles.max_bounces = 2
scn.render.resolution_x = 220
scn.render.resolution_y = 400
scn.render.film_transparent = False
scn.world = scn.world or bpy.data.worlds.new('w')
scn.world.use_nodes = True
scn.world.node_tree.nodes['Background'].inputs[1].default_value = 1.2
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3
sun.rotation_euler = (0.7, 0.2, 0.6)
scn.collection.objects.link(sun)
# A floor so feet below / above the ground show.
bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
floor = bpy.context.object
fm = bpy.data.materials.new('floor')
fm.diffuse_color = (0.55, 0.6, 0.55, 1)
floor.data.materials.append(fm)
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 2.1
cam = bpy.data.objects.new('cam', cam_data)
scn.collection.objects.link(cam)
scn.camera = cam


def B(n):
    return arm.pose.bones.get(n)


def world(pb, tail=False):
    return arm.matrix_world @ (pb.tail if tail else pb.head)


def measure():
    """Posture numbers in metres / degrees (Z up, character faces -Y in glTF→Blender import)."""
    bpy.context.view_layer.update()
    m = {}
    hips, neck, head = B('Hips'), B('Neck'), B('Head')
    la, ra = B('LeftArm'), B('RightArm')
    lf, rf = B('LeftFoot'), B('RightFoot')
    lh, rh = B('LeftHand'), B('RightHand')
    lu, ru = B('LeftUpLeg'), B('RightUpLeg')
    if not all((hips, neck, head, la, ra, lf, rf, lh, rh, lu, ru)):
        return m
    n = world(neck)
    m['shoulderDrop'] = round(n.z - (world(la).z + world(ra).z) / 2, 3)
    hd = (world(head, True) - world(head)).normalized()
    sp = (world(neck) - world(hips)).normalized()
    # Forward lean of the trunk / pitch of the head, from vertical, in the
    # sagittal plane. Character faces -Y after import from glTF.
    fwd = Vector((0, -1, 0))
    m['trunkLean'] = round(math.degrees(math.atan2(sp.dot(fwd), sp.z)), 1)
    m['headPitch'] = round(math.degrees(math.atan2(hd.dot(fwd), hd.z)), 1)
    m['hipWidth'] = round((world(lu) - world(ru)).length, 3)
    m['ankleGap'] = round(abs(world(lf).x - world(rf).x), 3)
    m['footZ'] = round(min(world(lf).z, world(rf).z), 3)
    pel = world(hips)
    m['handHip'] = round(min(abs(world(lh).x - pel.x), abs(world(rh).x - pel.x)), 3)
    return m


actions = {a.name.split('_')[0]: a for a in bpy.data.actions}
for clip, act in actions.items():
    if want and clip not in want:
        continue
    arm.animation_data_create()
    arm.animation_data.action = act
    # Mute NLA so only this clip plays.
    for t in arm.animation_data.nla_tracks:
        t.mute = True
    f0, f1 = act.frame_range
    frames = [f0 + (f1 - f0) * k / PHASES for k in range(PHASES)]
    shots = []
    stats = []
    for row, (loc, rot) in enumerate((((0, -4, 0.95), (math.pi / 2, 0, 0)), ((4, 0, 0.95), (math.pi / 2, 0, math.pi / 2)))):
        cam.location = loc
        cam.rotation_euler = rot
        for k, f in enumerate(frames):
            scn.frame_set(int(f), subframe=f - int(f))
            if row == 0:
                stats.append(measure())
            p = os.path.join(out, f'_{name}_{clip}_{row}_{k}.png')
            scn.render.filepath = p
            bpy.ops.render.render(write_still=True)
            shots.append(p)
    keys = stats[0].keys() if stats and stats[0] else []
    summary = {k: [min(s[k] for s in stats), max(s[k] for s in stats)] for k in keys}
    print('POSE', json.dumps({'name': name, 'clip': clip, 'frames': int(f1 - f0), 'fps': scn.render.fps, **summary}))
    sheet = os.path.join(out, f'{name}_{clip}.png')
    os.system(f"montage {' '.join(shots)} -tile {PHASES}x2 -geometry +2+2 -background '#222' {sheet} && rm {' '.join(shots)}")
