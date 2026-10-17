// PLATEAU (国土交通省) photo-textured 3D city models, streamed per city as
// 3D Tiles. Heights are ellipsoidal; we shift each city down by its local
// geoid height so buildings sit exactly on GSI (orthometric) terrain.
import {
  BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { enuBasis, approxDistanceMeters } from '../../core/geo'
import type { WorldFrame } from '../../core/frame'
import { BUILDING_KIND, createBuildingMaterial } from '../../render/materials/building'

export interface PlateauCity {
  code: string
  name: string
  pref: string
  url: string
  lod: number
  tex: boolean
  year: number
  bbox: [number, number, number, number] // w s e n
  geoid: number
}

interface ActiveCity {
  city: PlateauCity
  tiles: TilesRenderer
  coverage: Array<[number, number, number, number]> // leaf content regions in degrees
}

let draco: DRACOLoader | null = null
function getDraco(): DRACOLoader {
  if (!draco) {
    draco = new DRACOLoader()
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
  }
  return draco
}

const LOAD_MARGIN_DEG = 0.012 // ~1.2 km
const UNLOAD_MARGIN_DEG = 0.05

export class PlateauManager {
  readonly root = new Group()
  cities: PlateauCity[] = []
  private active = new Map<string, ActiveCity>()
  errorTarget = 24
  readonly facade: MeshStandardMaterial = createBuildingMaterial()
  /** Mesh lifecycle hooks (physics colliders). */
  onModel: ((key: string, mesh: Mesh) => void) | null = null
  onModelDisposed: ((key: string) => void) | null = null
  private modelSeq = 0
  /** Called when coverage changes so procedural buildings can be hidden. */
  onCoverageChange: (() => void) | null = null

  constructor(
    private world: WorldFrame,
    private camera: PerspectiveCamera,
    private renderer: WebGLRenderer,
  ) {
    this.root.name = 'plateau'
  }

  async init(): Promise<void> {
    const res = await fetch(`${import.meta.env.BASE_URL}data/plateau.json`)
    this.cities = await res.json()
  }

  /** Cities whose bounding box contains a point. */
  citiesAt(lat: number, lon: number, margin = 0): PlateauCity[] {
    return this.cities.filter(
      (c) => lon >= c.bbox[0] - margin && lon <= c.bbox[2] + margin && lat >= c.bbox[1] - margin && lat <= c.bbox[3] + margin,
    )
  }

  /** True when a PLATEAU building model covers this point (OSM duplicates get hidden). */
  covers(lat: number, lon: number): boolean {
    for (const a of this.active.values()) {
      for (const r of a.coverage) if (lon >= r[0] && lon <= r[2] && lat >= r[1] && lat <= r[3]) return true
    }
    return false
  }

  /** Whether any city with 3D models is near (even if not yet loaded). */
  hasCityNear(lat: number, lon: number): boolean {
    return this.citiesAt(lat, lon, 0.005).length > 0
  }

  /** Coverage boxes of all loaded cities intersecting a lat/lon box. */
  coverageIn(w: number, s: number, e: number, n: number): Array<[number, number, number, number]> {
    const out: Array<[number, number, number, number]> = []
    for (const a of this.active.values()) for (const r of a.coverage) if (r[0] < e && r[2] > w && r[1] < n && r[3] > s) out.push(r)
    return out
  }

  get activeNames(): string[] {
    return [...this.active.values()].map((a) => a.city.name)
  }

  update(cameraWorld: Vector3): void {
    const g = this.world.geodeticFromWorld(cameraWorld)
    for (const c of this.citiesAt(g.lat, g.lon, LOAD_MARGIN_DEG)) {
      if (!this.active.has(c.code) && this.active.size < 6) this.activate(c)
    }
    for (const [code, a] of this.active) {
      const b = a.city.bbox
      const m = UNLOAD_MARGIN_DEG
      if (g.lon < b[0] - m || g.lon > b[2] + m || g.lat < b[1] - m || g.lat > b[3] + m) this.deactivate(code)
    }
    // Far above the city, skip detail (the aerial photo carries it).
    const nearest = [...this.active.values()]
    for (const a of nearest) {
      a.tiles.errorTarget = this.errorTarget
      a.tiles.setResolutionFromRenderer(this.camera, this.renderer)
      a.tiles.update()
    }
  }

  private activate(city: PlateauCity): void {
    const tiles = new TilesRenderer(city.url)
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: getDraco(), rtc: true }))
    tiles.errorTarget = this.errorTarget
    tiles.setCamera(this.camera)
    tiles.setResolutionFromRenderer(this.camera, this.renderer)
    // The LRU cache and queues are shared by every city. PLATEAU LOD2 tiles
    // carry photo textures; the default 0.4 GB budget refuses most of a ward.
    tiles.lruCache.minSize = 300
    tiles.lruCache.maxSize = 1600
    tiles.lruCache.minBytesSize = 0.8 * 2 ** 30
    tiles.lruCache.maxBytesSize = 1.4 * 2 ** 30
    tiles.parseQueue.maxJobs = 6
    const active: ActiveCity = { city, tiles, coverage: [] }
    tiles.addEventListener('load-tileset', ({ tileset }) => {
      // Leaf content regions approximate where PLATEAU has buildings.
      type RawTile = { children?: RawTile[]; content?: { boundingVolume?: { region?: number[] } }; boundingVolume: { region?: number[] } }
      const d = 180 / Math.PI
      const walk = (t: RawTile) => {
        if (!t.children || t.children.length === 0) {
          const r = t.content?.boundingVolume?.region ?? t.boundingVolume.region
          if (r) active.coverage.push([r[0] * d, r[1] * d, r[2] * d, r[3] * d])
        } else t.children.forEach(walk)
      }
      walk((tileset as unknown as { root: RawTile }).root)
      this.onCoverageChange?.()
    })
    tiles.addEventListener('load-model', ({ scene }: { scene: Object3D }) => {
      this.prepareModel(scene)
      const key = `${city.code}:${this.modelSeq++}`
      scene.userData.nihonKey = key
      let i = 0
      scene.traverse((o) => {
        if ((o as Mesh).isMesh) this.onModel?.(`${key}:${i++}`, o as Mesh)
      })
    })
    tiles.addEventListener('dispose-model', ({ scene }: { scene: Object3D }) => {
      if (scene.userData.nihonKey) this.onModelDisposed?.(scene.userData.nihonKey + ':')
    })

    // Shift down along the local vertical by the geoid height.
    const clat = (city.bbox[1] + city.bbox[3]) / 2
    const clon = (city.bbox[0] + city.bbox[2]) / 2
    const up = enuBasis(clat, clon).up
    const shift = new Matrix4().makeTranslation(new Vector3(...up).multiplyScalar(-city.geoid))
    this.world.anchor(tiles.group, shift)
    this.root.add(tiles.group)
    this.active.set(city.code, active)
  }

  private deactivate(code: string): void {
    const a = this.active.get(code)
    if (!a) return
    this.world.unanchor(a.tiles.group)
    this.root.remove(a.tiles.group)
    a.tiles.dispose()
    this.active.delete(code)
    this.onCoverageChange?.()
  }

  /**
   * Replace PLATEAU's plain materials with the shared procedural facade and
   * derive per-building attributes (height above base, seed, kind) from the
   * per-vertex batch ids.
   */
  private prepareModel(scene: Object3D): void {
    scene.updateMatrixWorld(true)
    const v = new Vector3()
    const centre = new Vector3()
    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      const g = m.geometry as BufferGeometry
      const pos = g.getAttribute('position')
      const batch = (g.getAttribute('_batchid') ?? g.getAttribute('_BATCHID')) as BufferAttribute | undefined
      const count = pos.count
      g.computeBoundingSphere()
      centre.copy(g.boundingSphere!.center).applyMatrix4(m.matrixWorld)
      const up = centre.clone().normalize()
      const heights = new Float32Array(count)
      const ids = new Int32Array(count)
      const minH = new Map<number, number>()
      const maxH = new Map<number, number>()
      const sum = new Map<number, [number, number, number, number]>()
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
        const h = v.dot(up)
        const id = batch ? Math.round(batch.getX(i)) : 0
        heights[i] = h
        ids[i] = id
        minH.set(id, Math.min(minH.get(id) ?? Infinity, h))
        maxH.set(id, Math.max(maxH.get(id) ?? -Infinity, h))
        const acc = sum.get(id) ?? [0, 0, 0, 0]
        acc[0] += v.x
        acc[1] += v.y
        acc[2] += v.z
        acc[3]++
        sum.set(id, acc)
      }
      const seedOf = new Map<number, number>()
      const kindOf = new Map<number, number>()
      for (const [id, a] of sum) {
        const x = Math.round(a[0] / a[3])
        const y = Math.round(a[1] / a[3])
        const z = Math.round(a[2] / a[3])
        const r = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
        const seed = r - Math.floor(r)
        seedOf.set(id, seed)
        const height = (maxH.get(id) ?? 0) - (minH.get(id) ?? 0)
        let kind: number = BUILDING_KIND.generic
        if (height > 70 && seed > 0.25) kind = BUILDING_KIND.glass
        else if (height > 12) kind = BUILDING_KIND.office
        else if (height < 9) kind = BUILDING_KIND.house
        kindOf.set(id, kind)
      }
      const bh = new Float32Array(count)
      const seed = new Float32Array(count)
      const kind = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        bh[i] = heights[i] - (minH.get(ids[i]) ?? 0)
        seed[i] = seedOf.get(ids[i]) ?? 0
        kind[i] = kindOf.get(ids[i]) ?? 0
      }
      g.setAttribute('bh', new BufferAttribute(bh, 1))
      g.setAttribute('seed', new BufferAttribute(seed, 1))
      g.setAttribute('kind', new BufferAttribute(kind, 1))
      if (!g.getAttribute('normal')) g.computeVertexNormals()
      const old = Array.isArray(m.material) ? m.material : [m.material]
      old.forEach((x) => x.dispose())
      m.material = this.facade
    })
  }

  distanceToNearestCity(lat: number, lon: number): number {
    let best = Infinity
    for (const c of this.cities) {
      const clat = Math.max(c.bbox[1], Math.min(c.bbox[3], lat))
      const clon = Math.max(c.bbox[0], Math.min(c.bbox[2], lon))
      best = Math.min(best, approxDistanceMeters({ lat, lon }, { lat: clat, lon: clon }))
    }
    return best
  }
}
