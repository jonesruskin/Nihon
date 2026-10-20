// Streams OSM vector tiles around the player and turns them into streets,
// buildings, rail, water, trees and props (built in a worker pool).
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type Material,
} from 'three'
import type { WorldFrame } from '../../core/frame'
import { anchorMatrix } from '../../core/frame'
import { tileBounds, tileKey, tilesAround, tileCenter, type TileId } from '../../core/tiles'
import { approxDistanceMeters } from '../../core/geo'
import type { TerrainManager } from '../terrain/TerrainManager'
import type { PlateauManager } from '../plateau/PlateauManager'
import type { MeshData } from './MeshBuilder'
import type { NavPath, Poi, TileBuild } from './build'
import type { WorkerRequest, WorkerResponse } from '../workers/vector.worker'
import { createBuildingMaterial } from '../../render/materials/building'
import {
  createBallastMaterial,
  createConcreteMaterial,
  createRailMaterial,
  createRoadMaterial,
  createRoofMaterial,
  createSidewalkMaterial,
  createWireMaterial,
} from '../../render/materials/street'
import { createWaterMaterial } from '../../render/water'
import { LAMP, type NightLights } from '../../render/NightLights'
import {
  createPillarModel,
  createPoleModel,
  createSignalModel,
  createStreetLightModel,
  createMastModel,
  createTreeModels,
  createVendingModel,
  createAcUnitModel,
  createTankModel,
  createAntennaModel,
  type PropModel,
} from '../props/models'

/** OSM POI classes that are lit, open-fronted businesses at night. */
const SHOP_CLASSES = new Set(['shop', 'grocery', 'convenience', 'restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'clothing_store', 'bakery', 'pharmacy', 'alcohol_shop', 'ice_cream', 'hairdresser', 'laundry', 'mobile_phone', 'books', 'bank', 'karaoke', 'cinema', 'theatre', 'entertainment', 'pub', 'nightclub'])

/** Max draw distance (m) per prop type. */
const PROP_RANGE: Record<string, number> = { pole: 450, light: 600, vending: 220, signal: 500, pillar: 3000, tree: 900, wires: 350, mast: 550, ac: 260, tank: 700, antenna: 320 }

const TILE_URL = (t: TileId) => `https://tiles.openfreemap.org/planet/20261011_080001_pt/${t.z}/${t.x}/${t.y}.pbf`
const Z = 14

interface VTile {
  id: TileId
  key: string
  group: Group | null
  build: TileBuild | null
  state: 'loading' | 'ready' | 'error'
  detail: number
  coverageSig: string
  lastUsed: number
  rebuilding: boolean
}

export class VectorManager {
  readonly root = new Group()
  private tiles = new Map<string, VTile>()
  private workers: Worker[] = []
  private jobs = new Map<number, (r: WorkerResponse) => void>()
  private nextJob = 1
  private rr = 0
  private mats: Record<string, Material>
  private props: Record<string, PropModel> = {}
  /** Tree models by TREE_TYPES index (shared with the forest fill). */
  trees: PropModel[] = []
  private lastCull = 0
  private tmp = new Vector3()
  nearRadius = 1500
  farRadius = 2600
  /** Night light pool; sources are registered per tile. */
  lights: NightLights | null = null
  /** Called whenever a tile's build becomes available (traffic, crowds, culture). */
  onTile: ((t: { id: TileId; build: TileBuild; group: Group }) => void) | null = null
  onTileRemoved: ((key: string) => void) | null = null

  constructor(
    private world: WorldFrame,
    private terrain: TerrainManager,
    private plateau: PlateauManager,
  ) {
    this.root.name = 'vector'
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1))
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../workers/vector.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const cb = this.jobs.get(e.data.job)
        this.jobs.delete(e.data.job)
        cb?.(e.data)
      }
      this.workers.push(w)
    }
    this.mats = {
      buildings: plateau.facade ?? createBuildingMaterial(),
      roofs: createRoofMaterial(),
      roads: createRoadMaterial(),
      sidewalks: createSidewalkMaterial(),
      ballast: createBallastMaterial(),
      rails: createRailMaterial(),
      structures: createConcreteMaterial(),
      water: createWaterMaterial(8),
      wires: createWireMaterial(),
    }
    this.props = {
      pole: createPoleModel(),
      light: createStreetLightModel(),
      mast: createMastModel(),
      vending: createVendingModel(),
      ac: createAcUnitModel(),
      tank: createTankModel(),
      antenna: createAntennaModel(),
      pillar: createPillarModel(),
      signal: createSignalModel(),
    }
    this.trees = createTreeModels()
    plateau.onCoverageChange = () => this.checkCoverage()
  }

  get loadedCount(): number {
    let c = 0
    for (const t of this.tiles.values()) if (t.state === 'ready') c++
    return c
  }

  get pending(): number {
    return this.jobs.size
  }

  /** Every tile within `radius` m has been built once (rebuilds don't count). */
  readyNear(lat: number, lon: number, radius: number): boolean {
    const g = { lat, lon }
    let any = false
    for (const id of tilesAround(lat, lon, radius, Z)) {
      const b = tileBounds(id)
      const dx = Math.max(0, b.west - lon, lon - b.east) * 111412 * Math.cos((lat * Math.PI) / 180)
      const dy = Math.max(0, b.south - lat, lat - b.north) * 111132
      if (Math.hypot(dx, dy) > radius) continue
      const t = this.tiles.get(tileKey(id))
      if (!t || t.state === 'loading') return false
      any = true
    }
    void g
    return any
  }

  /** All POIs from loaded tiles. */
  *pois(): Generator<{ poi: Poi; tile: VTile }> {
    for (const t of this.tiles.values()) if (t.build) for (const poi of t.build.pois) yield { poi, tile: t }
  }

  /** Navigation paths in world coordinates (copied, for consumers). */
  pathsFor(key: string): { paths: NavPath[]; matrix: Matrix4 } | null {
    const t = this.tiles.get(key)
    if (!t?.build || !t.group) return null
    return { paths: t.build.paths, matrix: t.group.matrix }
  }

  get readyTiles(): Array<{ key: string; build: TileBuild; group: Group }> {
    const out: Array<{ key: string; build: TileBuild; group: Group }> = []
    for (const t of this.tiles.values()) if (t.build && t.group) out.push({ key: t.key, build: t.build, group: t.group })
    return out
  }

  update(cameraWorld: Vector3, now: number): void {
    const g = this.world.geodeticFromWorld(cameraWorld)
    const groundH = this.terrain.heightAt(g.lat, g.lon)
    const alt = g.h - (Number.isNaN(groundH) ? 0 : groundH)
    // From an aircraft view, vector detail is pointless: aerial photo + PLATEAU.
    if (alt > 900) return
    const want = tilesAround(g.lat, g.lon, this.farRadius, Z)
      .map((id) => {
        const c = tileCenter(id)
        const b = tileBounds(id)
        const dx = Math.max(0, b.west - g.lon, g.lon - b.east) * 111412 * Math.cos((g.lat * Math.PI) / 180)
        const dy = Math.max(0, b.south - g.lat, g.lat - b.north) * 111132
        return { id, d: Math.hypot(dx, dy), c }
      })
      .filter((t) => t.d < this.farRadius)
      .sort((a, b) => a.d - b.d)
    for (const w of want) {
      const key = tileKey(w.id)
      let t = this.tiles.get(key)
      const detail = w.d < this.nearRadius ? 1 : 0.35
      if (!t) {
        t = { id: w.id, key, group: null, build: null, state: 'loading', detail, coverageSig: '', lastUsed: now, rebuilding: false }
        this.tiles.set(key, t)
        void this.load(t, w.d)
      }
      t.lastUsed = now
      if (t.state === 'ready' && detail > t.detail && !t.rebuilding) {
        t.detail = detail
        t.rebuilding = true
        void this.load(t, w.d)
      }
    }
    // Distance-cull prop buckets (bounding sphere centre vs camera).
    if (now - this.lastCull > 400) {
      this.lastCull = now
      for (const t of this.tiles.values()) {
        if (!t.group) continue
        for (const o of t.group.children) {
          const range = o.userData.cullRange as number | undefined
          if (!range) continue
          const m = o as Mesh
          // Instanced buckets carry their own (instance-aware) bounds.
          const bs = (m as unknown as { boundingSphere?: import('three').Sphere | null }).boundingSphere ?? m.geometry.boundingSphere
          if (!bs) continue
          this.tmp.copy(bs.center).applyMatrix4(t.group.matrixWorld)
          o.visible = this.tmp.distanceTo(cameraWorld) - bs.radius < range
        }
      }
    }
    // Evict far tiles.
    for (const [key, t] of this.tiles) {
      if (now - t.lastUsed > 8000 && t.state !== 'loading') {
        const c = tileCenter(t.id)
        if (approxDistanceMeters(g, c) > this.farRadius * 1.6) this.remove(key)
      }
    }
  }

  private coverageFor(id: TileId): Array<[number, number, number, number]> {
    const b = tileBounds(id)
    return this.plateau.coverageIn(b.west, b.south, b.east, b.north)
  }

  private checkCoverage(): void {
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || t.rebuilding) continue
      const sig = String(this.coverageFor(t.id).length)
      if (sig !== t.coverageSig) {
        t.rebuilding = true
        void this.load(t, 0)
      }
    }
  }

  private async load(t: VTile, distance: number): Promise<void> {
    try {
      const dem = await this.terrain.dem.load(t.id, distance / 1000)
      const coverage = this.coverageFor(t.id)
      const job = this.nextJob++
      const req: WorkerRequest = {
        job,
        url: TILE_URL(t.id),
        priority: distance / 1000,
        id: t.id,
        dem: { id: dem.id, heights: dem.heights.slice() },
        coverage,
        detail: t.detail,
      }
      const res = await new Promise<WorkerResponse>((resolve) => {
        this.jobs.set(job, resolve)
        this.workers[this.rr++ % this.workers.length].postMessage(req, [req.dem.heights.buffer as ArrayBuffer])
      })
      if (!this.tiles.has(t.key)) return
      if (!res.ok) throw new Error(res.error)
      const group = this.materialize(res.build)
      if (t.group) this.disposeGroup(t.group)
      t.group = group
      t.build = res.build
      t.coverageSig = String(coverage.length)
      t.state = 'ready'
      t.rebuilding = false
      this.onTile?.({ id: t.id, build: res.build, group })
    } catch (e) {
      console.warn('vector tile failed', t.key, e)
      t.state = 'error'
      t.rebuilding = false
    }
  }

  private geometry(m: MeshData): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(m.position, 3))
    g.setAttribute('normal', new BufferAttribute(m.normal, 3))
    if (m.uv) g.setAttribute('uv', new BufferAttribute(m.uv, 2))
    for (const [k, a] of Object.entries(m.attrs)) g.setAttribute(k, new BufferAttribute(a.array, a.size))
    g.setIndex(new BufferAttribute(m.index, 1))
    g.computeBoundingSphere()
    return g
  }

  private materialize(b: TileBuild): Group {
    const group = new Group()
    group.name = `vector ${tileKey(b.id)}`
    const add = (key: keyof TileBuild & string, cast: boolean, receive = true, data = b[key] as MeshData | null) => {
      if (!data) return
      const mesh = new Mesh(this.geometry(data), this.mats[key])
      mesh.name = key
      mesh.castShadow = cast
      mesh.receiveShadow = receive
      group.add(mesh)
    }
    for (const d of b.buildings) add('buildings', true, true, d)
    for (const d of b.roofs) add('roofs', true, true, d)
    add('roads', false)
    add('sidewalks', false)
    add('ballast', false)
    add('rails', false)
    add('structures', true)
    add('water', false)
    if (b.wires.length) {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(b.wires, 3))
      const lines = new LineSegments(g, this.mats.wires)
      lines.name = 'wires'
      lines.userData.cullRange = PROP_RANGE.wires + 1400
      group.add(lines)
    }
    // Instanced props
    const m4 = new Matrix4()
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    const pos = new Vector3()
    const scl = new Vector3()
    // Instances are bucketed into ~400 m cells so each bucket can be frustum-
    // and distance-culled on its own (thousands of poles per Tokyo tile).
    const CELL = 400
    const instance = (kind: string, model: PropModel, data: Float32Array, filter: (extra: number) => boolean, scale: (s: number, e: number) => Vector3) => {
      const buckets = new Map<string, number[]>()
      for (let i = 0; i < data.length; i += 6) {
        if (!filter(data[i + 5])) continue
        const k = `${Math.floor(data[i] / CELL)},${Math.floor(data[i + 2] / CELL)}`
        let arr = buckets.get(k)
        if (!arr) buckets.set(k, (arr = []))
        arr.push(i)
      }
      for (const idx of buckets.values()) {
        const mesh = new InstancedMesh(model.geometry, model.materials, idx.length)
        idx.forEach((i, k) => {
          pos.set(data[i], data[i + 1], data[i + 2])
          q.setFromAxisAngle(up, data[i + 3])
          scl.copy(scale(data[i + 4], data[i + 5]))
          mesh.setMatrixAt(k, m4.compose(pos, q, scl))
        })
        mesh.castShadow = model.castShadow
        mesh.receiveShadow = true
        mesh.computeBoundingSphere()
        mesh.name = `props:${kind}`
        mesh.userData.cullRange = PROP_RANGE[kind] ?? 600
        group.add(mesh)
      }
    }
    const I = b.instances
    instance('pole', this.props.pole, I.pole, () => true, () => new Vector3(1, 1, 1))
    instance('light', this.props.light, I.light, () => true, () => new Vector3(1, 1, 1))
    instance('vending', this.props.vending, I.vending, () => true, () => new Vector3(1, 1, 1))
    instance('signal', this.props.signal, I.signal, () => true, () => new Vector3(1, 1, 1))
    instance('pillar', this.props.pillar, I.pillar, () => true, (s, e) => new Vector3(e, s, 1))
    if (I.mast) instance('mast', this.props.mast, I.mast, () => true, (s) => new Vector3(1, s / 7, 1))
    for (const k of ['ac', 'tank', 'antenna'] as const) if (I[k]?.length) instance(k, this.props[k], I[k], () => true, (s) => new Vector3(s, s, s))
    this.trees.forEach((model, type) => instance('tree', model, I.tree, (e) => Math.round(e) === type, (s) => new Vector3(s, s, s)))

    if (this.lights) {
      // Light sources for the night pool: lamp heads, pole LEDs, vending machines.
      const L: number[] = []
      for (let i = 0; i < I.light.length; i += 6) {
        const a = I.light[i + 3]
        L.push(I.light[i] + 2.05 * Math.sin(a), I.light[i + 1] + 8.0, I.light[i + 2] + 2.05 * Math.cos(a), a, LAMP.street)
      }
      // Most poles on Japanese side streets carry a 防犯灯 (security LED).
      for (let i = 0; i < I.pole.length; i += 6) {
        if (I.pole[i + 5] < 0.65) L.push(I.pole[i], I.pole[i + 1] + 5.2, I.pole[i + 2], 0, LAMP.pole)
      }
      // Shops, restaurants and konbini spill light onto the pavement.
      for (const p of b.pois) if (SHOP_CLASSES.has(p.cls)) L.push(p.x, p.y + 2.8, p.z, 0, LAMP.shop)
      for (let i = 0; i < I.vending.length; i += 6) L.push(I.vending[i], I.vending[i + 1], I.vending[i + 2], I.vending[i + 3], LAMP.vending)
      this.lights.register(group, new Float32Array(L))
    }

    const c = b.anchor
    this.world.anchor(group, anchorMatrix(c.lat, c.lon, 0))
    this.root.add(group)
    return group
  }

  private disposeGroup(group: Group): void {
    this.lights?.unregister(group)
    this.world.unanchor(group)
    this.root.remove(group)
    group.traverse((o) => {
      if (o instanceof InstancedMesh) o.dispose()
      else if (o instanceof Mesh || o instanceof LineSegments) o.geometry.dispose()
    })
  }

  private remove(key: string): void {
    const t = this.tiles.get(key)
    if (!t) return
    if (t.group) this.disposeGroup(t.group)
    this.tiles.delete(key)
    this.onTileRemoved?.(key)
  }
}
