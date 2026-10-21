# Bake crowd LODs of the MakeHuman characters for GPU-instanced crowds.
#
# For each character GLB: sample every material's texture into per-vertex
# colours, join all parts, decimate to ~1.8k triangles, then bake the walk
# and idle cycles as vertex animation (positions + normals per frame).
#
# Output per character: public/models/crowd/<name>.bin with layout
#   [u32 headerLen][header JSON][pad to 4]
#   indices  u16 * nIdx
#   colors   u8  * nVert * 4
#   frames   i16 * nVert * 4 * nFrames   (xyz quantised to bounds, w = packed normal xy)
# Header: {verts, indices, frames:{walk:[start,count], idle:[...]}, min:[x,y,z], max:[x,y,z]}
#
# Usage: blender -b --python scripts/blender/make_crowd.py -- assets-src/models/people public/models/crowd [name,name]
import bpy, bmesh, json, os, struct, sys, math
from mathutils import Vector

src, dst = sys.argv[sys.argv.index('--') + 1:][:2]
os.makedirs(dst, exist_ok=True)
TARGET_TRIS = 1800
WALK_FRAMES = 24
IDLE_FRAMES = 24


def wipe():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions, bpy.data.armatures):
        for b in list(coll):
            coll.remove(b)


def material_sampler(mat):
    """Return f(u, v) -> (r, g, b, a) linear for the material's base colour."""
    base = [0.8, 0.8, 0.8, 1.0]
    img = None
    if mat and mat.use_nodes:
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf:
            inp = bsdf.inputs['Base Color']
            base = list(inp.default_value)
            for l in inp.links:
                n = l.from_node
                while n and n.type != 'TEX_IMAGE' and n.inputs:
                    nxt = [li.from_node for i in n.inputs for li in i.links]
                    n = nxt[0] if nxt else None
                if n and n.type == 'TEX_IMAGE' and n.image:
                    img = n.image
    if img is None:
        return lambda u, v: base
    w, h = img.size
    px = list(img.pixels[:])
    # 8-bit images expose their stored (sRGB) values; float images are linear.
    srgb = not img.is_float and img.colorspace_settings.name.lower().startswith('srgb')

    def lin(c):
        return ((c + 0.055) / 1.055) ** 2.4 if srgb and c > 0.04045 else (c / 12.92 if srgb else c)

    def f(u, v):
        x = min(w - 1, max(0, int((u % 1.0) * w)))
        y = min(h - 1, max(0, int((v % 1.0) * h)))
        i = (y * w + x) * 4
        return (lin(px[i]) * base[0], lin(px[i + 1]) * base[1], lin(px[i + 2]) * base[2], px[i + 3])

    return f


def bake(path, name):
    wipe()
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'Icosphere' and o.parent is not None]
    for o in [o for o in bpy.data.objects if o.type == 'MESH' and o not in meshes]:
        bpy.data.objects.remove(o, do_unlink=True)
    # Per-corner colours from textures, then averaged to points.
    for o in meshes:
        me = o.data
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        acc = [[0.0, 0.0, 0.0, 0.0] for _ in me.vertices]
        uv = me.uv_layers.active
        samplers = [material_sampler(m) for m in me.materials] or [lambda u, v: (0.6, 0.6, 0.6, 1)]
        for poly in me.polygons:
            smp = samplers[min(poly.material_index, len(samplers) - 1)]
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                u, v = uv.data[li].uv if uv else (0.5, 0.5)
                r, g, b, a = smp(u, v)
                if a < 0.3:  # transparent bits of hair/lash cards
                    continue
                acc[vi][0] += r; acc[vi][1] += g; acc[vi][2] += b; acc[vi][3] += 1
        for i, c in enumerate(acc):
            n = c[3] or 1
            attr.data[i].color = (c[0] / n, c[1] / n, c[2] / n, 1.0)
    # Mark clothing (tintable per person) vs skin, hair, eyes.
    for o in meshes:
        names = ' '.join(m.name.lower() for m in o.data.materials if m)
        skin = any(k in names for k in ('.body', 'eye', 'brow', 'lash', 'teeth', 'tongue', 'hair', 'short0', 'bob0', 'long0', 'ponytail', 'braid', 'afro', 'low-poly'))
        cl = o.data.attributes.new('Cloth', 'FLOAT', 'POINT')
        for d in cl.data:
            d.value = 0.0 if skin else 1.0
    # Tuck the skin a centimetre under the clothes so decimation can't make
    # it poke through.
    for o in meshes:
        if any(m and m.name.endswith('.body') for m in o.data.materials):
            for v in o.data.vertices:
                v.co -= v.normal * 0.01
    # Join into one mesh.
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    # Decimate before the armature deforms it.
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    dec = body.modifiers.new('dec', 'DECIMATE')
    dec.ratio = min(1.0, TARGET_TRIS / max(1, tris))
    dec.use_collapse_triangulate = True
    while body.modifiers[0].name != 'dec':
        bpy.ops.object.modifier_move_up(modifier='dec')
    bpy.ops.object.modifier_apply(modifier='dec')
    tri = body.modifiers.new('tri', 'TRIANGULATE')
    bpy.ops.object.modifier_move_to_index(modifier='tri', index=0)
    bpy.ops.object.modifier_apply(modifier='tri')

    me = body.data
    nV = len(me.vertices)
    idx = [v for p in me.polygons for v in p.vertices]
    col = me.color_attributes['Col']
    cloth = me.attributes['Cloth']
    colors = []
    for i in range(nV):
        c = col.data[i].color
        # linear -> sRGB bytes
        for k in range(3):
            x = max(0.0, min(1.0, c[k]))
            x = 12.92 * x if x <= 0.0031308 else 1.055 * (x ** (1 / 2.4)) - 0.055
            colors.append(int(round(x * 255)))
        colors.append(255 if cloth.data[i].value > 0.5 else 0)

    acts = {a.name.split('_')[0]: a for a in bpy.data.actions}
    frames = []  # list of (positions, normals) in glTF space
    spans = {}
    dg = bpy.context.evaluated_depsgraph_get()
    for clip, count in (('walk', WALK_FRAMES), ('idle', IDLE_FRAMES)):
        act = acts.get(clip)
        if not act:
            continue
        arm.animation_data_create()
        arm.animation_data.action = act
        f0, f1 = act.frame_range
        spans[clip] = [len(frames), count]
        for k in range(count):
            f = f0 + (f1 - f0) * k / count
            bpy.context.scene.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
            dg = bpy.context.evaluated_depsgraph_get()
            ev = body.evaluated_get(dg)
            m = ev.to_mesh()
            mw = body.matrix_world
            pos = []
            nrm = []
            for v in m.vertices:
                p = mw @ v.co
                n = (mw.to_3x3() @ v.normal).normalized()
                # Blender Z-up -> glTF Y-up
                pos.append((p.x, p.z, -p.y))
                nrm.append((n.x, n.z, -n.y))
            ev.to_mesh_clear()
            frames.append((pos, nrm))
    lo = [min(p[i] for f in frames for p in f[0]) for i in range(3)]
    hi = [max(p[i] for f in frames for p in f[0]) for i in range(3)]
    header = json.dumps({'verts': nV, 'indices': len(idx), 'frames': spans, 'min': lo, 'max': hi}).encode()
    out = bytearray()
    out += struct.pack('<I', len(header)) + header
    while len(out) % 4:
        out += b' '
    out += struct.pack(f'<{len(idx)}H', *idx)
    while len(out) % 4:
        out += b'\0'
    out += bytes(colors)
    for pos, nrm in frames:
        buf = []
        for (x, y, z), (nx, ny, nz) in zip(pos, nrm):
            q = [int(round(((c - lo[i]) / ((hi[i] - lo[i]) or 1)) * 65535 - 32768)) for i, c in enumerate((x, y, z))]
            # octahedral normal packed into one int16 (8+8 bits)
            s = abs(nx) + abs(ny) + abs(nz) or 1
            ox, oy = nx / s, ny / s
            if nz < 0:
                ox, oy = (1 - abs(oy)) * (1 if ox >= 0 else -1), (1 - abs(ox)) * (1 if oy >= 0 else -1)
            pk = (int(round((ox * 0.5 + 0.5) * 255)) << 8) | int(round((oy * 0.5 + 0.5) * 255))
            q.append(pk - 32768)
            buf.extend(q)
        out += struct.pack(f'<{len(buf)}h', *buf)
    with open(os.path.join(dst, f'{name}.bin'), 'wb') as fh:
        fh.write(out)
    print('baked', name, nV, 'verts', len(idx) // 3, 'tris', len(frames), 'frames', len(out) // 1024, 'KB')


# Optional third argument: comma-separated names to (re)bake; the rest of
# the crowd manifest is kept as is.
only = set(sys.argv[sys.argv.index('--') + 1:][2].split(',')) if len(sys.argv[sys.argv.index('--') + 1:]) > 2 else None
manifest = json.load(open(os.path.join(src, 'manifest.json')))
names = []
for m in manifest:
    if only is None or m['name'] in only:
        bake(os.path.join(src, m['file']), m['name'])
    # Stride (m per walk cycle) lets the game drive each person's cycle by
    # distance walked, so feet stay planted at any speed.
    walk = m.get('clips', {}).get('walk', 1.1)
    names.append({'name': m['name'], 'gender': m['gender'], 'age': m['age'], 'season': m.get('season', 'any'),
                  'stride': round(m.get('speeds', {}).get('walk', 1.35) * walk, 3), 'idle': m.get('clips', {}).get('idle', 3.0)})
json.dump(names, open(os.path.join(dst, 'manifest.json'), 'w'), indent=1)
