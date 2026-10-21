// Average colour (linear RGB) of every textured material used by a car's
// wheels, from the master models. The game bakes wheel parts into one
// vertex-coloured mesh per wheel (one draw call instead of 3-5); at the size
// of a wheel the texture detail is invisible but its colour isn't.
//   node scripts/wheel-colors.mjs  ->  public/models/objs/wheels.json
import { readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const CARS = ['sedan_86', 'sedan_2010', 'kei_car_generic', 'kei_delivery', 'kei_truck_minicab', 'kei_truck_vintage', 'pickup_jp', 'box_truck', 'light_truck_07', 'light_truck_90', 'bus_erga_mio', 'bus_town']
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function parseGlb(buf) {
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const binStart = 20 + jsonLen + 8
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen))
  return { json, bin }
}

const out = {}
for (const id of CARS) {
  const { json, bin } = parseGlb(readFileSync(`assets-src/models/objs/${id}.glb`))
  // Materials of meshes at or below a wheel_* node.
  const used = new Set()
  const walk = (i, inWheel) => {
    const n = json.nodes[i]
    const w = inWheel || /^wheel_/i.test(n.name ?? '')
    if (w && n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) if (p.material !== undefined) used.add(p.material)
    for (const c of n.children ?? []) walk(c, w)
  }
  for (const i of json.scenes[json.scene ?? 0].nodes) walk(i, false)
  const colours = {}
  for (const mi of used) {
    const mat = json.materials[mi]
    const pbr = mat.pbrMetallicRoughness ?? {}
    const f = pbr.baseColorFactor ?? [1, 1, 1, 1]
    let avg = [1, 1, 1]
    const t = pbr.baseColorTexture
    if (t) {
      const img = json.images[json.textures[t.index].source]
      if (img.bufferView === undefined) continue
      const bv = json.bufferViews[img.bufferView]
      const data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
      const { data: px, info } = await sharp(data).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const sum = [0, 0, 0]
      for (let i = 0; i < px.length; i += info.channels) for (let k = 0; k < 3; k++) sum[k] += toLinear(px[i + k] / 255)
      const n = px.length / info.channels
      avg = sum.map((s) => s / n)
    }
    colours[mat.name] = avg.map((a, k) => Math.round(a * f[k] * 1000) / 1000)
  }
  out[id] = colours
}
writeFileSync('public/models/objs/wheels.json', JSON.stringify(out, null, 1) + '\n')
console.log(JSON.stringify(out))
