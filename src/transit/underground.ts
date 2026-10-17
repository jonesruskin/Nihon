// Subway and mountain tunnels around the train you ride, plus underground
// station halls (tiled walls, island platform with tactile line, pillars,
// fluorescent ceiling and 駅名標 name boards).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { assemble, at, colored } from '../world/props/models'

// Horseshoe tunnel section (x lateral, y above rail head).
const SECTION: [number, number][] = [
  [-2.6, -0.6], [-2.7, 2.6], [-2.3, 3.9], [-1.3, 4.7], [0, 4.95], [1.3, 4.7], [2.3, 3.9], [2.7, 2.6], [2.6, -0.6],
]

export class TunnelSleeve {
  readonly mesh: Mesh
  readonly lamps: Mesh
  private age = 99

  constructor() {
    this.mesh = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0x5f5d58, roughness: 0.95 }))
    this.lamps = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 3 }))
    this.mesh.frustumCulled = this.lamps.frustumCulled = false
    this.mesh.visible = this.lamps.visible = false
  }

  /**
   * Rebuild along [s0, s1] wherever the track is below ground.
   * sample(s) returns rail-head position, forward dir and depth below terrain.
   */
  update(dt: number, s0: number, s1: number, sample: (s: number, pos: Vector3, fwd: Vector3) => number): void {
    this.age += dt
    if (this.age < 0.4) return
    this.age = 0
    const pos: number[] = []
    const nrm: number[] = []
    const idx: number[] = []
    const lp: number[] = []
    const li: number[] = []
    const p = new Vector3()
    const f = new Vector3()
    const right = new Vector3()
    const up = new Vector3(0, 1, 0)
    let prevRing = -1
    const step = 4
    // Black end caps where the sleeve stops (not at real portals).
    const cap = (ring: number, flip: boolean) => {
      const c = pos.length / 3
      let cx = 0, cy = 0, cz = 0
      for (let j = 0; j < SECTION.length; j++) {
        cx += pos[(ring + j) * 3]
        cy += pos[(ring + j) * 3 + 1]
        cz += pos[(ring + j) * 3 + 2]
      }
      pos.push(cx / SECTION.length, cy / SECTION.length, cz / SECTION.length)
      nrm.push(0, 1, 0)
      for (let j = 0; j < SECTION.length - 1; j++) idx.push(...(flip ? [c, ring + j + 1, ring + j] : [c, ring + j, ring + j + 1]))
      // close the floor gap
      idx.push(...(flip ? [c, ring, ring + SECTION.length - 1] : [c, ring + SECTION.length - 1, ring]))
    }
    for (let s = s0; s <= s1; s += step) {
      const depth = sample(s, p, f)
      if (depth > -3) {
        prevRing = -1
        continue
      }
      right.crossVectors(f, up).normalize()
      const base = pos.length / 3
      for (const [x, y] of SECTION) {
        pos.push(p.x + right.x * x, p.y + y, p.z + right.z * x)
        const nx = -x
        const ny = -(y - 2.0)
        const l = Math.hypot(nx, ny) || 1
        nrm.push((right.x * nx) / l, ny / l, (right.z * nx) / l)
      }
      if (prevRing >= 0) {
        for (let j = 0; j < SECTION.length - 1; j++) {
          const a = prevRing + j
          const b = prevRing + j + 1
          const c = base + j
          const d = base + j + 1
          idx.push(a, c, b, b, c, d)
        }
      }
      if (prevRing < 0 && s === s0) cap(base, true)
      prevRing = base
      if (s + step > s1) cap(base, false)
      // Wall lamp every 12 m on the left wall.
      if (Math.floor(s / 12) !== Math.floor((s - step) / 12)) {
        const lb = lp.length / 3
        const c = new Vector3().copy(p).addScaledVector(right, -2.55).setY(p.y + 2.9)
        const a1 = c.clone().addScaledVector(f, -0.6)
        const a2 = c.clone().addScaledVector(f, 0.6)
        lp.push(a1.x, a1.y, a1.z, a2.x, a2.y, a2.z, a2.x, a2.y + 0.08, a2.z, a1.x, a1.y + 0.08, a1.z)
        li.push(lb, lb + 1, lb + 2, lb, lb + 2, lb + 3, lb, lb + 2, lb + 1, lb, lb + 3, lb + 2)
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3))
    g.setIndex(idx)
    this.mesh.geometry.dispose()
    this.mesh.geometry = g
    const lg = new BufferGeometry()
    lg.setAttribute('position', new BufferAttribute(new Float32Array(lp), 3))
    lg.setIndex(li)
    lg.computeVertexNormals()
    this.lamps.geometry.dispose()
    this.lamps.geometry = lg
    this.mesh.visible = this.lamps.visible = idx.length > 0
  }

  hide(): void {
    this.mesh.visible = this.lamps.visible = false
    this.age = 99
  }
}

function nameBoard(ja: string, kana: string, en: string, color: string): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 256
  const x = c.getContext('2d')!
  x.fillStyle = '#ffffff'
  x.fillRect(0, 0, 1024, 256)
  x.fillStyle = '#222'
  x.textAlign = 'center'
  x.font = '500 34px "Noto Sans JP", sans-serif'
  x.fillText(kana.split('').join(' '), 512, 52)
  x.font = '700 104px "Noto Sans JP", sans-serif'
  x.fillText(ja, 512, 158)
  x.font = '500 30px "Noto Sans JP", sans-serif'
  x.fillText(en.toUpperCase().split('').join(' '), 512, 200)
  x.fillStyle = color
  x.fillRect(0, 222, 1024, 34)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

/**
 * An underground station hall, built in a local frame: origin at the rail
 * head under the platform centre, +z along the direction of travel, the
 * island platform on the left (doors open on the left).
 */
export function buildStationHall(name: { ja: string; kana: string; en: string }, color: string, trainWidth: number, length = 210): Group {
  const g = new Group()
  const parts = []
  const half = length / 2
  // Facing +z, the train's left side is +x.
  const pl = trainWidth / 2 + 0.12 // platform edge (left of the train)
  const pw = 7.5
  const ph = 1.1
  const H = 5.6
  parts.push(colored(at(new BoxGeometry(pw, ph + 0.5, length), pl + pw / 2, ph / 2 - 0.25, 0), 0xb7b2a8)) // platform body
  parts.push(colored(at(new BoxGeometry(0.3, 0.012, length), pl + 0.85, ph + 0.006, 0), 0xd8b020)) // tactile line
  parts.push(colored(at(new BoxGeometry(0.06, 0.02, length), pl + 0.03, ph + 0.01, 0), 0xf2f2f0)) // white edge
  parts.push(colored(at(new BoxGeometry(14, 0.3, length), 2, H, 0), 0xe9e7e1)) // ceiling
  parts.push(colored(at(new BoxGeometry(0.3, H + 0.8, length), pl + pw + 0.15, H / 2 - 0.4, 0), 0xdcd8cc)) // far wall
  parts.push(colored(at(new BoxGeometry(0.3, H + 0.8, length), -(trainWidth / 2 + 1.6), H / 2 - 0.4, 0), 0xcfcabd)) // track-side wall
  parts.push(colored(at(new BoxGeometry(6, 0.2, length), 0, -0.55, 0), 0x3c3a37)) // trackbed
  for (let z = -half + 6; z < half - 4; z += 7) {
    parts.push(colored(at(new BoxGeometry(0.45, H - ph, 0.45), pl + pw / 2, (H + ph) / 2, z), 0xf0eee8)) // pillars
  }
  for (const end of [-1, 1]) parts.push(colored(at(new BoxGeometry(14, H + 1, 0.3), 2, H / 2, end * half), 0x2a2a2a))
  const mesh = new Mesh(assemble(parts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }))
  g.add(mesh)
  const lamp = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xf6f8ff, emissiveIntensity: 3.5 })
  for (const x of [pl + 1.5, pl + pw - 1.5, 0]) {
    const strip = new Mesh(new BoxGeometry(0.18, 0.04, length - 6), lamp)
    strip.position.set(x, H - 0.17, 0)
    g.add(strip)
  }
  // Name boards on the far wall and hanging over the platform.
  const tex = nameBoard(name.ja, name.kana, name.en, color)
  const board = new MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35, roughness: 0.4 })
  for (let z = -half + 20; z < half - 10; z += 40) {
    const b = new Mesh(new PlaneGeometry(3.6, 0.9), board)
    b.position.set(pl - pw + 0.02, 2.4, z)
    b.rotation.y = Math.PI / 2
    g.add(b)
    const b2 = new Mesh(new PlaneGeometry(3.6, 0.9), board)
    b2.position.set(trainWidth / 2 + 1.44, 2.4, z + 20)
    b2.rotation.y = -Math.PI / 2
    g.add(b2)
  }
  return g
}
