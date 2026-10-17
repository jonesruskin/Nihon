// Real-world props from free models (public/models/objs, CC BY 4.0), placed
// where they belong: a torii across the approach to every shrine, stone
// lanterns flanking shrine and temple approaches, the red ポスト outside post
// offices, and rows of parked mamachari bicycles outside stations and shops.
import { Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D } from 'three'
import type { NavPath, Poi } from '../vector/build'
import { modelLibrary } from './ModelLibrary'

interface Kind {
  id: string
  parts: { geometry: BufferGeometry; material: Material | Material[] }[]
  meshes: InstancedMesh[]
  cap: number
  count: number
}

interface Placement {
  pos: Vector3
  yaw: number
  scale: number
}

type TileLike = { key: string; build: { pois: Poi[]; paths: NavPath[] }; group: Group }

const MODELS: Record<string, number> = { torii: 160, lantern_stone: 400, postbox_red: 120, bicycle: 900, bicycle_yellow: 600 }

export class PlacedProps {
  readonly root = new Group()
  private kinds = new Map<string, Kind>()
  private sig = ''
  ready = false
  /** Pillar/lantern colliders for physics: [x, base y, z, half height, radius]. */
  colliders: Array<[number, number, number, number, number]> = []
  onColliders: ((c: Array<[number, number, number, number, number]>) => void) | null = null

  async init(): Promise<void> {
    await Promise.all(
      Object.entries(MODELS).map(async ([id, cap]) => {
        try {
          const scene = await modelLibrary.load(id)
          this.kinds.set(id, this.instanced(id, scene, cap))
        } catch (e) {
          console.warn('prop model failed', id, e)
        }
      }),
    )
    this.ready = true
  }

  private instanced(id: string, scene: Object3D, cap: number): Kind {
    scene.updateMatrixWorld(true)
    const inv = new Matrix4().copy(scene.matrixWorld).invert()
    const parts: Kind['parts'] = []
    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      const g = m.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld))
      parts.push({ geometry: g, material: m.material })
    })
    const meshes = parts.map((p) => {
      const im = new InstancedMesh(p.geometry, p.material, cap)
      im.count = 0
      im.castShadow = true
      im.receiveShadow = true
      im.frustumCulled = false
      im.name = `prop:${id}`
      this.root.add(im)
      return im
    })
    return { id, parts, meshes, cap, count: 0 }
  }

  invalidate(): void {
    this.sig = ''
  }

  update(tiles: TileLike[]): void {
    if (!this.ready) return
    const sig = tiles.map((t) => t.key).join('|')
    if (sig === this.sig) return
    this.sig = sig
    const place: Record<string, Placement[]> = {}
    for (const id of this.kinds.keys()) place[id] = []
    this.colliders = []

    // Walkable polylines in world space (paths and road edges), for anchoring.
    const lines: { pts: Vector3[]; kind: string; cls: string; width: number }[] = []
    const pois: (Poi & { w: Vector3 })[] = []
    for (const t of tiles) {
      t.group.updateWorldMatrix(true, false)
      const m = t.group.matrixWorld
      for (const p of t.build.paths) {
        if (p.kind === 'rail' || p.bridge) continue
        const pts: Vector3[] = []
        for (let i = 0; i < p.pts.length; i += 3) pts.push(new Vector3(p.pts[i], p.pts[i + 1], p.pts[i + 2]).applyMatrix4(m))
        lines.push({ pts, kind: p.kind, cls: p.cls, width: p.width })
      }
      for (const p of t.build.pois) pois.push({ ...p, w: new Vector3(p.x, p.y, p.z).applyMatrix4(m) })
    }
    const nearestOn = (c: Vector3, minD: number, maxD: number, filter: (l: (typeof lines)[number]) => boolean) => {
      let best: { p: Vector3; dir: Vector3; d: number; line: (typeof lines)[number] } | null = null
      for (const l of lines) {
        if (!filter(l)) continue
        for (let i = 1; i < l.pts.length; i++) {
          const a = l.pts[i - 1]
          const b = l.pts[i]
          const mid = a.clone().add(b).multiplyScalar(0.5)
          const d = Math.hypot(mid.x - c.x, mid.z - c.z)
          if (d < minD || d > maxD) continue
          if (!best || d < best.d) best = { p: mid, dir: b.clone().sub(a).setY(0).normalize(), d, line: l }
        }
      }
      return best
    }
    const rand = (x: number) => {
      const s = Math.sin(x * 12.9898) * 43758.5453
      return s - Math.floor(s)
    }
    const shrineRe = /神社|大社|神宮|稲荷|八幡|天満宮|宮$/
    const templeRe = /寺|院$|観音|不動/
    const done: Vector3[] = []
    for (const p of pois) {
      const isShrine = shrineRe.test(p.name)
      const isTemple = !isShrine && (templeRe.test(p.name) || p.cls === 'place_of_worship')
      if (!isShrine && !isTemple) continue
      if (done.some((d) => d.distanceTo(p.w) < 35)) continue
      done.push(p.w)
      // The approach (参道): a footpath or lane leading toward the hall.
      const at = nearestOn(p.w, 14, 60, (l) => l.kind === 'foot' || l.cls === 'minor' || l.cls === 'service') ?? nearestOn(p.w, 8, 45, () => true)
      if (!at) continue
      const toHall = p.w.clone().sub(at.p).setY(0).normalize()
      const dir = at.dir.dot(toHall) < 0 ? at.dir.clone().negate() : at.dir.clone()
      const yaw = Math.atan2(dir.x, dir.z)
      const big = /大社|神宮/.test(p.name) ? 1 : 0.6 + rand(p.w.x) * 0.25
      if (isShrine) {
        place.torii?.push({ pos: at.p.clone(), yaw, scale: big })
        const right = new Vector3(dir.z, 0, -dir.x)
        for (const s of [-1, 1]) this.colliders.push([at.p.x + right.x * s * 2.9 * big, at.p.y, at.p.z + right.z * s * 2.9 * big, 2.7 * big, 0.25 * big])
      }
      // Pair of stone lanterns a little way along the approach.
      const right = new Vector3(dir.z, 0, -dir.x)
      const along = at.p.clone().addScaledVector(dir, 4)
      for (const s of [-1, 1]) {
        const l = along.clone().addScaledVector(right, s * (2.3 + big))
        place.lantern_stone?.push({ pos: l, yaw: yaw + (s > 0 ? Math.PI : 0), scale: 0.8 + big * 0.3 })
        this.colliders.push([l.x, l.y, l.z, 0.65, 0.45])
      }
    }
    // Post boxes outside post offices.
    for (const p of pois) {
      if (p.cls !== 'post') continue
      const at = nearestOn(p.w, 2, 30, (l) => l.kind === 'road' || l.kind === 'foot')
      if (!at) continue
      const side = new Vector3(at.dir.z, 0, -at.dir.x)
      const towards = p.w.clone().sub(at.p).setY(0)
      const s = side.dot(towards) > 0 ? 1 : -1
      const pos = at.p.clone().addScaledVector(side, s * (at.line.width / 2 + 0.6))
      place.postbox_red?.push({ pos, yaw: Math.atan2(-side.x * s, -side.z * s), scale: 1 })
      this.colliders.push([pos.x, pos.y, pos.z, 0.68, 0.3])
    }
    // Mamachari rows outside stations, konbini and supermarkets.
    for (const p of pois) {
      const station = p.cls === 'railway' && /station|halt/.test(p.sub)
      const shop = (p.cls === 'shop' && /convenience|supermarket/.test(p.sub)) || p.cls === 'grocery'
      if (!station && !shop) continue
      const at = nearestOn(p.w, 3, station ? 60 : 30, (l) => l.kind === 'road' && l.cls !== 'motorway' && l.cls !== 'trunk')
      if (!at) continue
      const side = new Vector3(at.dir.z, 0, -at.dir.x)
      const towards = p.w.clone().sub(at.p).setY(0)
      const s = side.dot(towards) > 0 ? 1 : -1
      const n = station ? 10 + Math.floor(rand(p.w.z) * 16) : 3 + Math.floor(rand(p.w.z) * 6)
      const start = -n * 0.3
      for (let i = 0; i < n; i++) {
        const pos = at.p.clone().addScaledVector(at.dir, start + i * 0.62).addScaledVector(side, s * (at.line.width / 2 + 1.1))
        const id = rand(p.w.x + i) < 0.6 ? 'bicycle' : 'bicycle_yellow'
        place[id]?.push({ pos, yaw: Math.atan2(side.x * s, side.z * s) + (rand(i + p.w.x) - 0.5) * 0.25, scale: 1 })
      }
    }
    // Write instances.
    const m4 = new Matrix4()
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    for (const [id, list] of Object.entries(place)) {
      const k = this.kinds.get(id)
      if (!k) continue
      const n = Math.min(k.cap, list.length)
      for (const im of k.meshes) {
        for (let i = 0; i < n; i++) {
          const pl = list[i]
          q.setFromAxisAngle(up, pl.yaw)
          im.setMatrixAt(i, m4.compose(pl.pos, q, new Vector3(pl.scale, pl.scale, pl.scale)))
        }
        im.count = n
        im.instanceMatrix.needsUpdate = true
      }
    }
    this.onColliders?.(this.colliders)
  }
}
