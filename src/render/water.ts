// Sea / lake surface: a reflective PBR surface with a tiling procedural wave
// normal map. Reflections come from the sky environment map.
import { CanvasTexture, MeshPhysicalMaterial, RepeatWrapping, Vector2, type Texture } from 'three'

let waveNormal: Texture | null = null
const materials: MeshPhysicalMaterial[] = []

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Sum of periodic value-noise octaves -> height field -> normal map. */
function makeWaveNormal(size = 256): Texture {
  const h = new Float32Array(size * size)
  const octaves = [
    { f: 4, a: 1 },
    { f: 8, a: 0.5 },
    { f: 16, a: 0.25 },
    { f: 32, a: 0.12 },
  ]
  for (const { f, a } of octaves) {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * f
        const fy = (y / size) * f
        const ix = Math.floor(fx)
        const iy = Math.floor(fy)
        const tx = fx - ix
        const ty = fy - iy
        const sx = tx * tx * (3 - 2 * tx)
        const sy = ty * ty * (3 - 2 * ty)
        const w = (i: number, j: number) => hash(((ix + i) % f) + f * 7, ((iy + j) % f) + f * 13)
        const v = (w(0, 0) * (1 - sx) + w(1, 0) * sx) * (1 - sy) + (w(0, 1) * (1 - sx) + w(1, 1) * sx) * sy
        h[y * size + x] += v * a
      }
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const strength = 6
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)]
      const r = h[y * size + ((x + 1) % size)]
      const u = h[((y - 1 + size) % size) * size + x]
      const d = h[((y + 1) % size) * size + x]
      let nx = (l - r) * strength
      let ny = (u - d) * strength
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      const p = (y * size + x) * 4
      img.data[p] = (nx * 0.5 + 0.5) * 255
      img.data[p + 1] = (ny * 0.5 + 0.5) * 255
      img.data[p + 2] = (nz * 0.5 + 0.5) * 255
      img.data[p + 3] = 255
    }
  ctx.putImageData(img, 0, 0)
  const t = new CanvasTexture(canvas)
  t.wrapS = t.wrapT = RepeatWrapping
  return t
}

export function createWaterMaterial(repeat = 24): MeshPhysicalMaterial {
  waveNormal ??= makeWaveNormal()
  const nm = waveNormal.clone()
  nm.repeat.set(repeat, repeat)
  nm.needsUpdate = true
  const m = new MeshPhysicalMaterial({
    color: 0x0b2730,
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.88,
    normalMap: nm,
    normalScale: new Vector2(0.35, 0.35),
    envMapIntensity: 1.0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  })
  materials.push(m)
  return m
}

/** Advance wave animation; wind (m/s) roughens and speeds the surface. */
export function updateWater(timeSec: number, wind = 3): void {
  const speed = 0.002 + wind * 0.0006
  const rough = Math.min(0.25, 0.04 + wind * 0.012)
  for (const m of materials) {
    m.normalMap!.offset.set(timeSec * speed, timeSec * speed * 0.6)
    m.roughness = rough
    m.normalScale.setScalar(0.25 + wind * 0.04)
  }
}
