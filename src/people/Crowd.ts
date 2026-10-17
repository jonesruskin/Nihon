// Pedestrians: as many as the place and hour really have. Agents walk the
// sidewalks and footpaths of the loaded OSM streets (keeping left, varying
// pace, pausing, avoiding each other), and are drawn as GPU-instanced,
// vertex-animated MakeHuman people with per-person clothing colours.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { NavPath } from '../world/vector/build'
import { createCrowdMesh, crowdTime, loadCrowdArchetypes, type CrowdArchetype } from './crowdModels'

interface Edge {
  min: Vector3
  max: Vector3
  pts: Vector3[]
  cum: number[]
  len: number
  a: number
  b: number
  width: number
  scramble: number // -1, or index of the scramble crossing this edge belongs to
  kind: 'foot' | 'sidewalk' | 'edge' | 'scramble'
}

/** A scramble crossing as the crowd sees it (world space, live phase). */
export interface CrowdScramble {
  center: Vector3
  radius: number
  /** Seconds into the walk phase, or -1 while cars have green. */
  walkTime: () => number
  pedPhase: number
}

export type CrowdPed = Ped

interface Ped {
  arch: number
  archetypeName: string
  near: boolean // drawn by NearPeople with the full model
  tint: [number, number, number, number]
  tint2: [number, number, number, number]
  slot: number
  edge: number
  t: number
  dir: 1 | -1
  lane: number // lateral offset (m) relative to travel direction, + = left
  speed: number
  pace: number
  state: 'walk' | 'idle' | 'wait'
  timer: number
  waitEdge: number
  waitX: number
  waitZ: number
  react: number
  pos: Vector3
  yaw: number
  phase: number
  umbrella: number // 0 none, 1 clear vinyl, 2 coloured
  umbrellaColor: number
}

function umbrellaGeometry(): BufferGeometry {
  // Canopy (shallow dome, 8 ribs), shaft and J handle; origin at the hand.
  const canopy = new SphereGeometry(0.55, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.32)
  canopy.scale(1, 0.55, 1)
  canopy.translate(0, 0.62, 0)
  const shaft = new CylinderGeometry(0.007, 0.007, 0.95, 5)
  shaft.translate(0, 0.45, 0)
  const handle = new CylinderGeometry(0.012, 0.012, 0.12, 5)
  handle.translate(0, -0.03, 0)
  const parts = [canopy, shaft, handle].map((g) => (g.index ? g.toNonIndexed() : g))
  for (const g of parts) g.deleteAttribute('uv')
  return mergeGeometries(parts)!
}

const SIDEWALK: Record<string, number> = { trunk: 3, primary: 3, secondary: 2.5, tertiary: 2 }
const EDGE_WALK = new Set(['minor', 'service'])

// Muted Japanese street palette: navy, black, charcoal, greige, white, olive, brown, denim.
const TOPS = [[0.03, 0.04, 0.08], [0.015, 0.015, 0.018], [0.09, 0.09, 0.1], [0.42, 0.37, 0.3], [0.75, 0.75, 0.72], [0.12, 0.14, 0.09], [0.2, 0.11, 0.07], [0.62, 0.6, 0.55], [0.05, 0.09, 0.2], [0.55, 0.12, 0.1]]
const BOTTOMS = [[0.02, 0.02, 0.03], [0.06, 0.07, 0.12], [0.1, 0.1, 0.1], [0.35, 0.3, 0.24], [0.12, 0.17, 0.28], [0.05, 0.05, 0.05]]

export class Crowd {
  readonly root = new Group()
  private arch: CrowdArchetype[] = []
  private meshes: InstancedMesh[] = []
  private slotPeds: Ped[][] = []
  peds: Ped[] = []
  private edges: Edge[] = []
  private nodeEdges: number[][] = []
  private shops: Vector3[] = []
  private sig = ''
  private rebuildTimer = 99
  private spawnTimer = 0
  /** Max radius (quality tier); the live radius shrinks in dense places. */
  maxRadius = 110
  radius = 110
  cap = 250
  scrambles: CrowdScramble[] = []
  /** Painted zebra bars along every scramble crossing path (diagonals too). */
  private stripes = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
  private corner = new Map<number, number>() // node -> scramble index
  target = 0
  ready = false
  private grid = new Map<string, Ped[]>()
  /** 0..1 how hard it is raining (umbrellas up, people hurry). */
  rain = 0
  private umbrellaClear!: InstancedMesh
  private umbrellaSolid!: InstancedMesh

  async init(capacityPerArchetype = 120): Promise<void> {
    this.stripes.receiveShadow = true
    this.root.add(this.stripes)
    const ug = umbrellaGeometry()
    const cap = capacityPerArchetype * 8
    // ビニール傘: the clear vinyl umbrella sold at every konbini.
    this.umbrellaClear = new InstancedMesh(ug, new MeshStandardMaterial({ color: 0xf4f8fa, roughness: 0.15, transparent: true, opacity: 0.32, side: DoubleSide, depthWrite: false }), cap)
    this.umbrellaSolid = new InstancedMesh(ug, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, side: DoubleSide }), cap)
    for (const u of [this.umbrellaClear, this.umbrellaSolid]) {
      u.count = 0
      u.frustumCulled = false
      u.castShadow = u === this.umbrellaSolid
      this.root.add(u)
    }
    this.arch = await loadCrowdArchetypes()
    for (const a of this.arch) {
      const m = createCrowdMesh(a, capacityPerArchetype)
      m.name = `crowd:${a.name}`
      this.meshes.push(m)
      this.slotPeds.push([])
      this.root.add(m)
    }
    this.ready = true
  }

  /** Debug: the pedestrian network as line segments, coloured by kind. */
  debugLines(): { pos: Float32Array; col: Float32Array } {
    const pos: number[] = []
    const col: number[] = []
    for (const e of this.edges) {
      const c = e.scramble >= 0 ? [1, 0, 0] : e.kind === 'foot' ? [0, 1, 0] : e.kind === 'sidewalk' ? [0, 0.5, 1] : [1, 1, 0]
      for (let i = 1; i < e.pts.length; i++) {
        pos.push(e.pts[i - 1].x, e.pts[i - 1].y + 0.3, e.pts[i - 1].z, e.pts[i].x, e.pts[i].y + 0.3, e.pts[i].z)
        col.push(...c, ...c)
      }
    }
    return { pos: new Float32Array(pos), col: new Float32Array(col) }
  }

  /** Commercial POIs within r of p (for the density model). */
  shopsNear(p: Vector3, r: number): number {
    let n = 0
    for (const s of this.shops) if (Math.abs(s.x - p.x) < r && Math.abs(s.z - p.z) < r && s.distanceToSquared(p) < r * r) n++
    return n
  }

  // ------------------------------------------------------------ graph

  maybeRebuild(dt: number, tiles: Array<{ key: string; build: { paths: NavPath[]; pois: Array<{ x: number; y: number; z: number; cls: string; sub: string }> }; group: Group }>, force = false): void {
    this.rebuildTimer += dt
    if (!force && this.rebuildTimer < 3) return
    this.rebuildTimer = 0
    const sig = tiles.map((t) => t.key).join('|')
    if (!force && sig === this.sig) return
    this.sig = sig
    const nodes: Vector3[] = []
    const hash = new Map<string, number[]>()
    const node = (p: Vector3): number => {
      const kx = Math.floor(p.x / 6)
      const kz = Math.floor(p.z / 6)
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          for (const id of hash.get(`${kx + dx},${kz + dz}`) ?? []) if (nodes[id].distanceToSquared(p) < 36) return id
      const id = nodes.length
      nodes.push(p.clone())
      const k = `${kx},${kz}`
      if (!hash.has(k)) hash.set(k, [])
      hash.get(k)!.push(id)
      return id
    }
    const edges: Edge[] = []
    const add = (pts: Vector3[], width: number, kind: Edge['kind']) => {
      if (pts.length < 2) return
      const cum = [0]
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]))
      const len = cum[cum.length - 1]
      if (len < 2) return
      const min = pts[0].clone()
      const max = pts[0].clone()
      for (const p of pts) {
        min.min(p)
        max.max(p)
      }
      edges.push({ min, max, pts, cum, len, a: node(pts[0]), b: node(pts[pts.length - 1]), width, scramble: -1, kind })
    }
    this.shops = []
    for (const t of tiles) {
      t.group.updateWorldMatrix(true, false)
      const m = t.group.matrixWorld
      for (const path of t.build.paths) {
        if (path.kind === 'rail') continue
        const raw: Vector3[] = []
        for (let i = 0; i < path.pts.length; i += 3) raw.push(new Vector3(path.pts[i], path.pts[i + 1], path.pts[i + 2]).applyMatrix4(m))
        if (path.kind === 'foot') {
          if (path.cls === 'steps' || path.width <= 0) continue
          add(raw, Math.max(1.2, path.width * 0.8), 'foot')
        } else {
          const side = SIDEWALK[path.cls]
          if (side) {
            // One-way major roads are carriageways of a dual road: pavement on the left only.
            const sides = path.oneway !== 0 && path.cls !== 'tertiary' ? [path.oneway > 0 ? -1 : 1] : [-1, 1]
            for (const s of sides) add(offset(raw, s * (path.width / 2 + side / 2), 0.15), side * 0.8, 'sidewalk')
          } else if (EDGE_WALK.has(path.cls) && !path.bridge) {
            for (const s of [-1, 1]) add(offset(raw, s * (path.width / 2 - 0.6), 0), 0.8, 'edge')
          }
        }
      }
      for (const p of t.build.pois) {
        if (p.cls === 'bus' || p.cls === 'parking' || p.sub === 'bus_stop') continue
        this.shops.push(new Vector3(p.x, p.y, p.z).applyMatrix4(m))
      }
    }
    this.addScrambles(nodes, edges)
    this.paintStripes(edges)
    this.edges = edges
    this.nearEdges = []
    this.nodeEdges = nodes.map(() => [])
    edges.forEach((e, i) => {
      this.nodeEdges[e.a].push(i)
      this.nodeEdges[e.b].push(i)
    })
    // Re-seat walkers onto the rebuilt network (nearest segment within 4 m).
    const segs = new Map<string, Array<[number, number]>>()
    edges.forEach((e, ei) => {
      for (let i = 1; i < e.pts.length; i++) {
        const m = e.pts[i - 1].clone().add(e.pts[i]).multiplyScalar(0.5)
        const k = `${Math.floor(m.x / 8)},${Math.floor(m.z / 8)}`
        if (!segs.has(k)) segs.set(k, [])
        segs.get(k)!.push([ei, i])
      }
    })
    const q = new Vector3()
    for (const p of [...this.peds]) {
      const kx = Math.floor(p.pos.x / 8)
      const kz = Math.floor(p.pos.z / 8)
      let best: [number, number] | null = null
      let bd = 16
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          for (const [ei, i] of segs.get(`${kx + dx},${kz + dz}`) ?? []) {
            const e = edges[ei]
            const a = e.pts[i - 1]
            const b = e.pts[i]
            const ab = q.subVectors(b, a)
            const l2 = ab.x * ab.x + ab.z * ab.z || 1
            const u = Math.max(0, Math.min(1, ((p.pos.x - a.x) * ab.x + (p.pos.z - a.z) * ab.z) / l2))
            const d = (a.x + ab.x * u - p.pos.x) ** 2 + (a.z + ab.z * u - p.pos.z) ** 2
            if (d < bd) {
              bd = d
              best = [ei, e.cum[i - 1] + u * (e.cum[i] - e.cum[i - 1])]
            }
          }
      if (best) {
        p.edge = best[0]
        p.t = best[1]
        if (p.state === 'wait') p.state = 'walk'
        p.waitEdge = -1
      } else this.despawn(p)
    }
  }

  /**
   * Turn each scramble junction into corners joined by crossing edges in
   * every direction (diagonals included); drop the ordinary crossings inside.
   */
  private addScrambles(nodes: Vector3[], edges: Edge[]): void {
    this.corner.clear()
    this.scrambles.forEach((sc, si) => {
      const c = sc.center
      // The mapped crosswalks through the junction tell us where its corners
      // are: their endpoints. Remove them; scramble edges replace them.
      const ends: number[] = []
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i]
        if (e.scramble >= 0) continue
        const mid = e.pts[Math.floor(e.pts.length / 2)]
        if (Math.hypot(mid.x - c.x, mid.z - c.z) < sc.radius - 4) {
          if (e.kind === 'foot') ends.push(e.a, e.b)
          edges.splice(i, 1)
        }
      }
      let cand = ends
        .map((id) => ({ id, p: nodes[id], d: Math.hypot(nodes[id].x - c.x, nodes[id].z - c.z) }))
        .filter((n) => n.d > sc.radius * 0.45 && n.d < sc.radius + 20)
      if (cand.length < 3) {
        // No mapped crosswalks: use pavement nodes on a ring around the junction.
        cand = nodes.map((p, id) => ({ id, p, d: Math.hypot(p.x - c.x, p.z - c.z) })).filter((n) => n.d > sc.radius - 8 && n.d < sc.radius + 16)
      }
      // Cluster within 9 m; one corner per cluster (the node nearest the centre).
      const corners: typeof cand = []
      for (const n of cand.sort((a, b) => a.d - b.d)) if (!corners.some((k) => k.p.distanceTo(n.p) < 9)) corners.push(n)
      if (corners.length < 3) return
      for (const k of corners) this.corner.set(k.id, si)
      for (let i = 0; i < corners.length; i++)
        for (let j = i + 1; j < corners.length; j++) {
          const a = nodes[corners[i].id]
          const b = nodes[corners[j].id]
          const pts = [a.clone(), b.clone()]
          const len = a.distanceTo(b)
          if (len > sc.radius * 2.5) continue
          const min = a.clone().min(b)
          const max = a.clone().max(b)
          edges.push({ min, max, pts, cum: [0, len], len, a: corners[i].id, b: corners[j].id, width: 7, scramble: si, kind: 'scramble' })
        }
    })
  }

  private paintStripes(edges: Edge[]): void {
    const pos: number[] = []
    const idx: number[] = []
    for (const e of edges) {
      if (e.scramble < 0) continue
      const a = e.pts[0]
      const b = e.pts[e.pts.length - 1]
      const dx = (b.x - a.x) / e.len
      const dz = (b.z - a.z) / e.len
      const half = 2.0
      // Bars 45 cm deep every 90 cm, skipping the kerbside ends.
      for (let t = 3; t < e.len - 3; t += 0.9) {
        const y = a.y + ((b.y - a.y) * t) / e.len - 0.12
        const base = pos.length / 3
        for (const [u, w] of [[t, -half], [t, half], [t + 0.45, half], [t + 0.45, -half]]) {
          pos.push(a.x + dx * u - dz * w, y, a.z + dz * u + dx * w)
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2)
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
    g.setIndex(idx)
    this.stripes.geometry.dispose()
    this.stripes.geometry = g
  }

  /** Follow a floating-origin rebase, then re-seat on the rebuilt network. */
  rebase(delta: Matrix4): void {
    for (const p of this.peds) p.pos.applyMatrix4(delta)
    this.sig = ''
    this.rebuildTimer = 99
  }

  clear(): void {
    for (const p of [...this.peds]) this.despawn(p)
    this.sig = ''
    this.rebuildTimer = 99
  }

  // ------------------------------------------------------------ agents

  private nearEdges: number[] = []
  private nearAt = new Vector3(1e9, 0, 0)

  /** Edges overlapping the crowd radius (refreshed as the player moves). */
  private refreshNear(c: Vector3): void {
    if (this.nearAt.distanceToSquared(c) < 400 && this.nearEdges.length) return
    this.nearAt.copy(c)
    const r = this.radius * 1.1
    this.nearEdges = []
    // Weight by length so long sidewalks get proportionally more people.
    this.edges.forEach((e, i) => {
      if (e.max.x < c.x - r || e.min.x > c.x + r || e.max.z < c.z - r || e.min.z > c.z + r) return
      for (let k = 0; k < Math.max(1, Math.round(e.len / 25)); k++) this.nearEdges.push(i)
    })
  }

  private spawn(near: Vector3, minR: number, maxR: number): boolean {
    this.refreshNear(near)
    if (!this.nearEdges.length) return false
    for (let tries = 0; tries < 12; tries++) {
      const ei = this.nearEdges[Math.floor(Math.random() * this.nearEdges.length)]
      const e = this.edges[ei]
      if (e.scramble >= 0 && this.scrambles[e.scramble].walkTime() < 0) continue
      const t = Math.random() * e.len
      const p = sample(e, t, new Vector3())
      const d = Math.hypot(p.x - near.x, p.z - near.z)
      if (d < minR || d > maxR) continue
      if (this.spawnOn(ei, t)) return true
    }
    return false
  }

  private spawnOn(ei: number, t: number): boolean {
    const e = this.edges[ei]
    const p = sample(e, t, new Vector3())
    for (let tries = 0; tries < 3; tries++) {
      const ai = Math.floor(Math.random() * this.arch.length)
      const list = this.slotPeds[ai]
      const mesh = this.meshes[ai]
      if (list.length >= mesh.instanceMatrix.count) continue
      const pace = 0.82 + Math.random() * 0.36
      const elder = this.arch[ai].age > 0.62
      const top = TOPS[Math.floor(Math.random() * TOPS.length)]
      const bot = BOTTOMS[Math.floor(Math.random() * BOTTOMS.length)]
      const tintA: [number, number, number, number] = [top[0], top[1], top[2], Math.random() < 0.15 ? 0 : 0.9]
      const tintB: [number, number, number, number] = [bot[0], bot[1], bot[2], 0.03 + Math.random() * 0.05]
      const ped: Ped = {
        arch: ai,
        archetypeName: this.arch[ai].name,
        near: false,
        tint: tintA,
        tint2: tintB,
        slot: list.length,
        edge: ei,
        t,
        dir: Math.random() < 0.5 ? 1 : -1,
        lane: (0.15 + Math.random() * 0.35) * e.width * 0.5,
        speed: 0,
        pace: pace * (elder ? 0.78 : 1),
        state: Math.random() < 0.1 ? 'idle' : 'walk',
        timer: Math.random() * 20,
        waitEdge: -1,
        waitX: 0,
        waitZ: 0,
        react: 0,
        pos: p,
        yaw: 0,
        phase: Math.random(),
        umbrella: Math.random() < 0.08 ? 0 : Math.random() < 0.6 ? 1 : 2,
        umbrellaColor: [0x15161a, 0x1b2540, 0x3a3f46, 0x5a1d22, 0x2d4a3a, 0x7a6a55][Math.floor(Math.random() * 6)],
      }
      list.push(ped)
      this.peds.push(ped)
      mesh.count = list.length
      const tint = mesh.geometry.getAttribute('aTint')
      const tint2 = mesh.geometry.getAttribute('aTint2')
      tint.setXYZW(ped.slot, ...tintA)
      tint2.setXYZW(ped.slot, ...tintB)
      tint.needsUpdate = tint2.needsUpdate = true
      return true
    }
    return false
  }

  /** Spawn someone already waiting at a corner of scramble `si`. */
  private spawnAtCorner(si: number): boolean {
    const corners = [...this.corner].filter(([, k]) => k === si).map(([n]) => n)
    if (!corners.length) return false
    const node = corners[Math.floor(Math.random() * corners.length)]
    const inc = this.nodeEdges[node] ?? []
    const plain = inc.filter((i) => this.edges[i].scramble < 0)
    const cross = inc.filter((i) => this.edges[i].scramble >= 0)
    if (!plain.length || !cross.length) return false
    const ei = plain[Math.floor(Math.random() * plain.length)]
    const e = this.edges[ei]
    const before = this.peds.length
    // Reuse spawn() bookkeeping by spawning on the edge end, then switch to waiting.
    const ok = this.spawnOn(ei, e.a === node ? 0 : e.len)
    if (!ok || this.peds.length === before) return false
    const p = this.peds[this.peds.length - 1]
    const ni = cross[Math.floor(Math.random() * cross.length)]
    const sc = this.scrambles[si]
    const cn = this.edges[ni].a === node ? this.edges[ni].pts[0] : this.edges[ni].pts[this.edges[ni].pts.length - 1]
    const away = Math.atan2(cn.z - sc.center.z, cn.x - sc.center.x) + (Math.random() - 0.5) * 2.2
    const r = 0.6 + Math.sqrt(Math.random()) * 4.5
    p.state = 'wait'
    p.waitEdge = ni
    p.react = Math.random() * 2.5
    p.waitX = cn.x + Math.cos(away) * r - p.pos.x
    p.waitZ = cn.z + Math.sin(away) * r - p.pos.z
    return true
  }

  private despawn(p: Ped): void {
    const list = this.slotPeds[p.arch]
    const mesh = this.meshes[p.arch]
    const last = list[list.length - 1]
    if (last !== p) {
      // Move the last instance into the freed slot.
      list[p.slot] = last
      last.slot = p.slot
      const tint = mesh.geometry.getAttribute('aTint')
      const tint2 = mesh.geometry.getAttribute('aTint2')
      tint.setXYZW(p.slot, tint.getX(list.length - 1), tint.getY(list.length - 1), tint.getZ(list.length - 1), tint.getW(list.length - 1))
      tint2.setXYZW(p.slot, tint2.getX(list.length - 1), tint2.getY(list.length - 1), tint2.getZ(list.length - 1), tint2.getW(list.length - 1))
      tint.needsUpdate = tint2.needsUpdate = true
    }
    list.pop()
    mesh.count = list.length
    this.peds.splice(this.peds.indexOf(p), 1)
  }

  private m4 = new Matrix4()
  private q = new Quaternion()
  private up = new Vector3(0, 1, 0)
  private one = new Vector3(1, 1, 1)
  private zero = new Vector3(0, 0, 0)

  /** Pedestrians nearest to a point (for the full-detail near LOD). */
  nearest(p: Vector3, n: number): Ped[] {
    return this.peds
      .filter((q) => Math.abs(q.pos.x - p.x) < 15 && Math.abs(q.pos.z - p.z) < 15)
      .sort((a, b) => a.pos.distanceToSquared(p) - b.pos.distanceToSquared(p))
      .slice(0, n)
  }

  /**
   * @param perHectare real pedestrian density here. When it exceeds what the
   * budget can show over the full radius, the crowd is concentrated around
   * the player at true density instead of being thinned out.
   */
  update(dt: number, cam: Vector3, perHectare: number, time: number): void {
    if (!this.ready) return
    crowdTime.value = time
    const fit = Math.sqrt((this.cap * 10000) / (Math.PI * Math.max(1e-3, perHectare)))
    const r = Math.max(40, Math.min(this.maxRadius, fit))
    this.radius += (r - this.radius) * Math.min(1, dt * 0.5)
    this.target = Math.min(this.cap, Math.round((perHectare * Math.PI * this.radius * this.radius) / 10000))
    // Population control: fill around the player, despawn far away.
    for (const p of [...this.peds]) if (Math.hypot(p.pos.x - cam.x, p.pos.z - cam.z) > this.radius * 1.25) this.despawn(p)
    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.25
      const missing = this.target - this.peds.length
      const initial = this.peds.length < this.target * 0.3
      const sc = this.scrambles.findIndex((x) => x.walkTime() < 0 && Math.hypot(x.center.x - cam.x, x.center.z - cam.z) < this.radius)
      for (let i = 0; i < Math.min(missing, initial ? 60 : 8); i++) {
        // People keep arriving at a scramble's corners while cars have green.
        if (sc >= 0 && Math.random() < 0.5 && this.spawnAtCorner(sc)) continue
        this.spawn(cam, initial ? 4 : this.radius * 0.7, this.radius)
      }
      if (missing < -10) {
        // Thin out from the far edge.
        const far = [...this.peds].sort((a, b) => b.pos.distanceToSquared(cam) - a.pos.distanceToSquared(cam))
        for (let i = 0; i < Math.min(-missing, 6, far.length); i++) this.despawn(far[i])
      }
    }
    // Spatial hash for avoidance.
    this.grid.clear()
    for (const p of this.peds) {
      const k = `${Math.floor(p.pos.x / 2)},${Math.floor(p.pos.z / 2)}`
      let c = this.grid.get(k)
      if (!c) this.grid.set(k, (c = []))
      c.push(p)
    }
    const fwd = new Vector3()
    const tmp = new Vector3()
    for (const p of this.peds) {
      const e = this.edges[p.edge]
      if (!e) continue
      p.timer -= dt
      if (p.state === 'wait') {
        // Waiting at the kerb for the scramble: go when the walk phase starts
        // (after a human reaction delay).
        p.speed += (0 - p.speed) * Math.min(1, dt * 4)
        const ne = this.edges[p.waitEdge]
        const sc = ne ? this.scrambles[ne.scramble] : null
        const wt = sc ? sc.walkTime() : 0
        if (!ne || (wt >= 0 && wt > p.react)) {
          p.state = 'walk'
          p.timer = 30 + Math.random() * 60
          if (ne) this.enter(p, p.waitEdge, ne.a === this.cornerNodeOf(p) ? 1 : -1)
        } else {
          // Face the crossing while standing.
          sample(e, p.t, p.pos)
          const goal = ne.a === this.cornerNodeOf(p) ? ne.pts[ne.pts.length - 1] : ne.pts[0]
          const yaw = Math.atan2(goal.x - p.pos.x, goal.z - p.pos.z)
          let d = yaw - p.yaw
          while (d > Math.PI) d -= Math.PI * 2
          while (d < -Math.PI) d += Math.PI * 2
          p.yaw += d * Math.min(1, dt * 3)
          p.pos.x += p.waitX
          p.pos.z += p.waitZ
          continue
        }
      }
      if (p.state === 'idle') {
        p.speed += (0 - p.speed) * Math.min(1, dt * 3)
        if (p.timer <= 0) {
          p.state = 'walk'
          p.timer = 20 + Math.random() * 60
        }
      } else if (p.state === 'walk') {
        let want = 1.32 * p.pace * (e.scramble >= 0 ? 1.15 : 1) * (1 + this.rain * 0.12)
        // Caught on the crossing when the lights change: hurry.
        if (e.scramble >= 0 && this.scrambles[e.scramble].walkTime() < 0) want = 2.3 * p.pace
        // Slow down behind someone walking the same way; sidestep oncoming people.
        sample(e, p.t + p.dir * 0.5, tmp)
        fwd.subVectors(tmp, p.pos).setY(0).normalize()
        const kx = Math.floor(p.pos.x / 2)
        const kz = Math.floor(p.pos.z / 2)
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++)
            for (const o of this.grid.get(`${kx + dx},${kz + dz}`) ?? []) {
              if (o === p) continue
              const ox = o.pos.x - p.pos.x
              const oz = o.pos.z - p.pos.z
              const ahead = ox * fwd.x + oz * fwd.z
              if (ahead <= 0 || ahead > 1.6) continue
              const lat = Math.abs(ox * fwd.z - oz * fwd.x)
              if (lat > 0.55) continue
              if (o.edge === p.edge && o.dir === p.dir) want = Math.min(want, o.speed * 0.95)
              else p.lane = Math.min(e.width * 0.5, p.lane + dt * 0.8)
            }
        p.speed += (want - p.speed) * Math.min(1, dt * 2)
        if (p.timer <= 0) {
          // Pause now and then: phones, shop windows, waiting for a friend.
          p.state = 'idle'
          p.timer = 2 + Math.random() * 8
        }
      }
      p.t += p.dir * p.speed * dt
      if (p.t < 0 || p.t > e.len) this.nextEdge(p)
      const e2 = this.edges[p.edge]
      sample(e2, p.t, p.pos)
      sample(e2, p.t + p.dir * 0.8, tmp)
      fwd.subVectors(tmp, p.pos).setY(0)
      if (fwd.lengthSq() > 1e-6) {
        fwd.normalize()
        // Keep left (Japan): left of travel is (fz, -fx).
        p.pos.x += fwd.z * p.lane
        p.pos.z += -fwd.x * p.lane
        const yaw = Math.atan2(fwd.x, fwd.z)
        let d = yaw - p.yaw
        while (d > Math.PI) d -= Math.PI * 2
        while (d < -Math.PI) d += Math.PI * 2
        p.yaw += d * Math.min(1, dt * 6)
      }
      const laneGoal = e2.scramble >= 0 ? (p.phase - 0.5) * e2.width : (0.2 + p.phase * 0.3) * e2.width * 0.5
      p.lane += (laneGoal - p.lane) * Math.min(1, dt * 0.3)
    }
    // Umbrellas up in the rain (Japan: even in a light drizzle).
    let nc = 0
    let ns = 0
    if (this.rain > 0.08) {
      const col = new Color()
      for (const p of this.peds) {
        if (!p.umbrella) continue
        const right = new Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw))
        const at = new Vector3(p.pos.x + right.x * 0.18 + Math.sin(p.yaw) * 0.12, p.pos.y + 1.12, p.pos.z + right.z * 0.18 + Math.cos(p.yaw) * 0.12)
        this.q.setFromAxisAngle(this.up, p.yaw)
        this.m4.compose(at, this.q, this.one)
        if (p.umbrella === 1) this.umbrellaClear.setMatrixAt(nc++, this.m4)
        else {
          this.umbrellaSolid.setMatrixAt(ns, this.m4)
          this.umbrellaSolid.setColorAt(ns++, col.setHex(p.umbrellaColor))
        }
      }
    }
    this.umbrellaClear.count = nc
    this.umbrellaSolid.count = ns
    this.umbrellaClear.instanceMatrix.needsUpdate = true
    this.umbrellaSolid.instanceMatrix.needsUpdate = true
    if (this.umbrellaSolid.instanceColor) this.umbrellaSolid.instanceColor.needsUpdate = true

    // Write instances.
    for (let ai = 0; ai < this.meshes.length; ai++) {
      const mesh = this.meshes[ai]
      const list = this.slotPeds[ai]
      if (!list.length) continue
      const anim = mesh.geometry.getAttribute('aAnim')
      const fr = this.arch[ai].frames
      for (const p of list) {
        this.q.setFromAxisAngle(this.up, p.yaw)
        mesh.setMatrixAt(p.slot, this.m4.compose(p.pos, this.q, p.near ? this.zero : this.one))
        const walking = p.speed > 0.25
        const clip = walking ? fr.walk : fr.idle
        // Cycle rate matches ground speed so feet don't slide (clip ~1.1 s at 1.35 m/s).
        anim.setXYZW(p.slot, clip[0], clip[1], p.phase, walking ? p.speed / 1.35 / 1.1 : 0.15)
      }
      mesh.instanceMatrix.needsUpdate = true
      anim.needsUpdate = true
    }
  }

  private nextEdge(p: Ped): void {
    const e = this.edges[p.edge]
    const at = p.t < 0 ? e.a : e.b
    const options = this.nodeEdges[at].filter((i) => i !== p.edge)
    if (!options.length) {
      // Dead end: turn around.
      p.dir = p.dir === 1 ? -1 : 1
      p.t = Math.max(0, Math.min(e.len, p.t))
      return
    }
    let ni = options[Math.floor(Math.random() * options.length)]
    // Near a scramble, most people are heading for it: steer toward the junction.
    const here = at === e.a ? e.pts[0] : e.pts[e.pts.length - 1]
    const sc0 = this.scrambles.find((sc) => Math.hypot(here.x - sc.center.x, here.z - sc.center.z) < 90)
    if (sc0 && Math.random() < 0.65 && this.edges[p.edge].scramble < 0) {
      let best = Infinity
      for (const i of options) {
        const o = this.edges[i]
        const far = o.a === at ? o.pts[o.pts.length - 1] : o.pts[0]
        const d = Math.hypot(far.x - sc0.center.x, far.z - sc0.center.z) + Math.random() * 6
        if (d < best) {
          best = d
          ni = i
        }
      }
    }
    const cross = options.filter((i) => this.edges[i].scramble >= 0)
    if (cross.length && this.edges[p.edge].scramble < 0 && Math.random() < 0.75) {
      ni = cross[Math.floor(Math.random() * cross.length)]
      const sc = this.scrambles[this.edges[ni].scramble]
      const wt = sc.walkTime()
      if (wt < 0 || wt > sc.pedPhase - 10) {
        // Red for pedestrians: wait at the corner.
        p.state = 'wait'
        p.waitEdge = ni
        p.react = Math.random() * 2.5 // reaction delay once it turns green
        p.t = Math.max(0, Math.min(e.len, p.t))
        // Stand somewhere in the kerbside crowd, on the pavement side.
        const cn = this.edges[ni].a === at ? this.edges[ni].pts[0] : this.edges[ni].pts[this.edges[ni].pts.length - 1]
        const away = Math.atan2(cn.z - sc.center.z, cn.x - sc.center.x) + (Math.random() - 0.5) * 2.2
        const r = 0.6 + Math.sqrt(Math.random()) * 4.2
        const here = sample(e, p.t, new Vector3())
        p.waitX = cn.x + Math.cos(away) * r - here.x
        p.waitZ = cn.z + Math.sin(away) * r - here.z
        return
      }
    } else if (cross.length && this.edges[p.edge].scramble < 0) {
      const plain = options.filter((i) => this.edges[i].scramble < 0)
      if (plain.length) ni = plain[Math.floor(Math.random() * plain.length)]
    }
    this.enter(p, ni, this.edges[ni].a === at ? 1 : -1)
  }

  private enter(p: Ped, ni: number, dir: 1 | -1): void {
    const n = this.edges[ni]
    p.edge = ni
    p.dir = dir
    p.t = dir === 1 ? 0 : n.len
    p.waitEdge = -1
  }

  /** The scramble corner node a waiting pedestrian stands at. */
  private cornerNodeOf(p: Ped): number {
    const e = this.edges[p.edge]
    return p.t <= e.len / 2 ? e.a : e.b
  }
}

function sample(e: Edge, t: number, out: Vector3): Vector3 {
  const s = Math.max(0, Math.min(e.len, t))
  let i = 1
  while (i < e.cum.length - 1 && e.cum[i] < s) i++
  const a = e.pts[i - 1]
  const b = e.pts[i]
  const k = (s - e.cum[i - 1]) / (e.cum[i] - e.cum[i - 1] || 1)
  return out.lerpVectors(a, b, k)
}

/** Offset a polyline sideways (x right, -z forward), lifting it by dy. */
function offset(pts: Vector3[], d: number, dy: number): Vector3[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const tx = b.x - a.x
    const tz = b.z - a.z
    const l = Math.hypot(tx, tz) || 1
    return new Vector3(p.x + (-tz / l) * d, p.y + dy, p.z + (tx / l) * d)
  })
}
