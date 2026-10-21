// Real forest density around the player. Tile builds can only afford a tree
// every ~20 m across a whole mountainside, which reads as a sparse orchard
// from the road. Japanese forest - sugi/hinoki plantations above all - stands
// a trunk every 4-6 m, so within ~200 m of the player the woods are filled in
// at true density, the near ring casting shadows.
import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import type { NavPath, WoodArea } from '../vector/build'
import type { PropModel } from './models'

type TileLike = { key: string; build: { woods?: WoodArea[]; paths: NavPath[] }; group: Group }

// Tree model indices (see TREE_TYPES): broadleaf, cedar, pine, bamboo.
const TYPES = [0, 1, 4, 5]
const NEAR = 70

export class ForestFill {
  readonly root = new Group()
  radius = 190
  spacing = 5.5
  private near: InstancedMesh[] = []
  private far: InstancedMesh[] = []
  private center = new Vector3(Infinity, 0, Infinity)
  private sig = ''
  count = 0
  /** Trunks near the player, for physics: [x, base y, z, half height, radius]. */
  onColliders: ((c: Array<[number, number, number, number, number]>) => void) | null = null

  constructor(models: PropModel[], capacity = 7000) {
    this.root.name = 'forest-fill'
    for (const t of TYPES) {
      const m = models[t]
      if (!m) continue
      for (const shadow of [true, false]) {
        const im = new InstancedMesh(m.geometry, m.materials, shadow ? Math.round(capacity / 3) : capacity)
        im.count = 0
        im.castShadow = shadow
        im.receiveShadow = true
        im.frustumCulled = false
        im.name = `forest:${t}${shadow ? ':near' : ''}`
        im.userData.type = t
        ;(shadow ? this.near : this.far).push(im)
        this.root.add(im)
      }
    }
  }

  invalidate(): void {
    this.sig = ''
    this.center.set(Infinity, 0, Infinity)
  }

  /**
   * @param ground world-space ground height at (x, z), or null if unknown
   * @param occupied true where something (a building, a bridge) stands
   */
  update(cam: Vector3, tiles: TileLike[], ground: (x: number, z: number) => number | null, occupied?: (x: number, y: number, z: number) => boolean): void {
    const sig = tiles.map((t) => t.key).join('|')
    const moved = Math.hypot(cam.x - this.center.x, cam.z - this.center.z)
    if (sig === this.sig && moved < 35) return
    this.sig = sig
    this.center.copy(cam)
    const R = this.radius
    const S = this.spacing
    const inv = new Matrix4()
    const local = new Vector3()
    const w = new Vector3()
    const m4 = new Matrix4()
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    const scl = new Vector3()
    const cursor = new Map<InstancedMesh, number>()
    const byType = new Map<number, { near: InstancedMesh; far: InstancedMesh }>()
    for (const im of this.near) byType.set(im.userData.type as number, { near: im, far: this.far.find((f) => f.userData.type === im.userData.type)! })
    for (const im of [...this.near, ...this.far]) cursor.set(im, 0)
    const trunks: Array<[number, number, number, number, number]> = []

    for (const t of tiles) {
      const woods = t.build.woods
      if (!woods?.length) continue
      t.group.updateWorldMatrix(true, false)
      inv.copy(t.group.matrixWorld).invert()
      local.copy(cam).applyMatrix4(inv)
      const lx = local.x
      const lz = local.z
      // Roads, rails and paths through the wood stay clear.
      const segs: number[] = []
      for (const p of t.build.paths) {
        if (p.bridge) continue
        const clear = p.width / 2 + (p.kind === 'rail' ? 3 : p.kind === 'foot' ? 1.2 : 2.2)
        for (let i = 3; i < p.pts.length; i += 3) {
          const ax = p.pts[i - 3]
          const az = p.pts[i - 1]
          const bx = p.pts[i]
          const bz = p.pts[i + 2]
          if (Math.max(ax, bx) < lx - R - clear || Math.min(ax, bx) > lx + R + clear || Math.max(az, bz) < lz - R - clear || Math.min(az, bz) > lz + R + clear) continue
          segs.push(ax, az, bx, bz, clear)
        }
      }
      const blocked = (x: number, z: number): boolean => {
        for (let i = 0; i < segs.length; i += 5) {
          const ax = segs[i]
          const az = segs[i + 1]
          const dx = segs[i + 2] - ax
          const dz = segs[i + 3] - az
          const c = segs[i + 4]
          const l2 = dx * dx + dz * dz || 1
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2))
          const ex = ax + dx * u - x
          const ez = az + dz * u - z
          if (ex * ex + ez * ez < c * c) return true
        }
        return false
      }
      for (const wood of woods) {
        const [minX, minZ, maxX, maxZ] = wood.bbox
        if (maxX < lx - R || minX > lx + R || maxZ < lz - R || minZ > lz + R) continue
        const z0 = Math.ceil(Math.max(minZ, lz - R) / S) * S
        for (let gz = z0; gz <= Math.min(maxZ, lz + R); gz += S) {
          // Scanline fill (even-odd over the outer ring and its holes).
          const xs: number[] = []
          for (const ring of wood.rings) {
            const n = ring.length / 2
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const zi = ring[i * 2 + 1]
              const zj = ring[j * 2 + 1]
              if (zi > gz !== zj > gz) xs.push(ring[i * 2] + ((gz - zi) / (zj - zi)) * (ring[j * 2] - ring[i * 2]))
            }
          }
          if (xs.length < 2) continue
          xs.sort((a, b) => a - b)
          const half = Math.sqrt(Math.max(0, R * R - (gz - lz) * (gz - lz)))
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const a = Math.max(xs[k], lx - half)
            const b = Math.min(xs[k + 1], lx + half)
            for (let gx = Math.ceil(a / S) * S; gx < b; gx += S) {
              const h1 = hash(gx, gz)
              const h2 = hash(gz + 7.1, gx - 3.3)
              const x = gx + (h1 - 0.5) * S * 0.8
              const z = gz + (h2 - 0.5) * S * 0.8
              if (blocked(x, z)) continue
              w.set(x, 0, z).applyMatrix4(t.group.matrixWorld)
              const y = ground(w.x, w.z)
              if (y === null) continue
              if (occupied?.(w.x, y, w.z)) continue
              const r = hash(x * 1.7, z * 0.9)
              const type = wood.mountain ? (r < 0.68 ? 1 : r < 0.78 ? 4 : 0) : r < 0.3 ? 1 : r < 0.42 ? 5 : 0
              const pair = byType.get(type)
              if (!pair) continue
              const d = Math.hypot(w.x - cam.x, w.z - cam.z)
              const im = d < NEAR ? pair.near : pair.far
              const i = cursor.get(im)!
              if (i >= im.instanceMatrix.count) continue
              const s = (type === 1 ? 0.95 : 0.8) + hash(z, x * 2.3) * 0.5
              q.setFromAxisAngle(up, r * 6.283)
              w.y = y - 0.1
              im.setMatrixAt(i, m4.compose(w, q, scl.set(s, s, s)))
              cursor.set(im, i + 1)
              if (d < 60) trunks.push([w.x, w.y, w.z, 3, (type === 5 ? 0.08 : 0.24) * s])
            }
          }
        }
      }
    }
    this.count = 0
    for (const [im, n] of cursor) {
      im.count = n
      im.visible = n > 0
      im.instanceMatrix.needsUpdate = true
      this.count += n
    }
    this.onColliders?.(trunks)
  }
}

function hash(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}
