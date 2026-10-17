// Quadtree terrain streamed from GSI elevation + GSI aerial photographs.
// Each tile is a real photo of that patch of Japan draped on real terrain.
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Texture,
  Vector3,
  type Material,
} from 'three'
import { LocalFrame } from '../../core/geo'
import { anchorMatrix, type WorldFrame } from '../../core/frame'
import {
  children,
  parentAt,
  tileBounds,
  tileCenter,
  tileKey,
  tileSizeMeters,
  tilesAround,
  tileXToLon,
  tileYToLat,
  type TileId,
} from '../../core/tiles'
import { fetchImageBitmap } from '../../core/net'
import { DEM_MAX_ZOOM, DemProvider, type DemTile } from './dem'
import { createWaterMaterial } from '../../render/water'

const GRID = 32 // segments per tile edge
const ROOT_ZOOM = 9
const PHOTO = (t: TileId) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${t.z}/${t.x}/${t.y}.jpg`

export interface TerrainSettings {
  maxZoom: number
  splitFactor: number
  farRadius: number
}

type State = 'idle' | 'loading' | 'ready' | 'error'

class TerrainTile {
  state: State = 'idle'
  group: Group | null = null
  lastUsed = 0
  positions: Float32Array | null = null
  indices: Uint32Array | null = null
  dem: DemTile | null = null
  constructor(readonly id: TileId) {}
}

export interface GridData {
  positions: Float32Array // anchor-frame xyz for (GRID+1)^2 verts (no skirt)
  heights: Float32Array
}

/** Sample the terrain grid for a tile. Shared by rendering and physics. */
export function sampleGrid(id: TileId, dem: DemTile, frame: LocalFrame, grid = GRID): GridData {
  const n = grid + 1
  const positions = new Float32Array(n * n * 3)
  const heights = new Float32Array(n * n)
  const p: [number, number, number] = [0, 0, 0]
  for (let j = 0; j < n; j++) {
    const lat = tileYToLat(id.y + j / grid, id.z)
    for (let i = 0; i < n; i++) {
      const lon = tileXToLon(id.x + i / grid, id.z)
      const h = DemProvider.sampleTile(dem, lon, lat)
      frame.fromGeodetic(lat, lon, h, p)
      const k = j * n + i
      heights[k] = h
      positions[k * 3] = p[0]
      positions[k * 3 + 1] = p[1]
      positions[k * 3 + 2] = p[2]
    }
  }
  return { positions, heights }
}

export function gridIndices(grid = GRID): Uint32Array {
  const n = grid + 1
  const idx = new Uint32Array(grid * grid * 6)
  let o = 0
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      idx[o++] = a
      idx[o++] = c
      idx[o++] = b
      idx[o++] = b
      idx[o++] = c
      idx[o++] = d
    }
  }
  return idx
}

const GRID_INDICES = gridIndices()

function buildGeometry(id: TileId, grid: GridData, frame: LocalFrame, skirtDepth: number): BufferGeometry {
  const n = GRID + 1
  const ring = 4 * GRID
  const vCount = n * n + ring
  const pos = new Float32Array(vCount * 3)
  const uv = new Float32Array(vCount * 2)
  pos.set(grid.positions)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      uv[k * 2] = i / GRID
      uv[k * 2 + 1] = j / GRID // image rows run north->south; texture.flipY = false
    }
  // Skirt: duplicate the border ring pushed down along local up.
  const border: number[] = []
  for (let i = 0; i < GRID; i++) border.push(i) // top
  for (let j = 0; j < GRID; j++) border.push(j * n + GRID) // right
  for (let i = GRID; i > 0; i--) border.push(GRID * n + i) // bottom
  for (let j = GRID; j > 0; j--) border.push(j * n) // left
  const p: [number, number, number] = [0, 0, 0]
  border.forEach((src, r) => {
    const j = Math.floor(src / n)
    const i = src % n
    const lat = tileYToLat(id.y + j / GRID, id.z)
    const lon = tileXToLon(id.x + i / GRID, id.z)
    frame.fromGeodetic(lat, lon, grid.heights[src] - skirtDepth, p)
    const k = n * n + r
    pos.set(p, k * 3)
    uv[k * 2] = uv[src * 2]
    uv[k * 2 + 1] = uv[src * 2 + 1]
  })
  const idx = new Uint32Array(GRID_INDICES.length + ring * 6)
  idx.set(GRID_INDICES)
  let o = GRID_INDICES.length
  for (let r = 0; r < ring; r++) {
    const a = border[r]
    const b = border[(r + 1) % ring]
    const a2 = n * n + r
    const b2 = n * n + ((r + 1) % ring)
    idx[o++] = a
    idx[o++] = b
    idx[o++] = a2
    idx[o++] = b
    idx[o++] = b2
    idx[o++] = a2
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('uv', new BufferAttribute(uv, 2))
  // Normals from the surface grid only; skirts copy their source normal so
  // any crack between LODs shades exactly like the ground around it.
  g.setIndex(new BufferAttribute(GRID_INDICES, 1))
  g.computeVertexNormals()
  const nrm = g.getAttribute('normal') as BufferAttribute
  border.forEach((src, r) => {
    const k = n * n + r
    nrm.setXYZ(k, nrm.getX(src), nrm.getY(src), nrm.getZ(src))
  })
  g.setIndex(new BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  return g
}

function buildSeaGeometry(id: TileId, frame: LocalFrame): BufferGeometry {
  const n = 17
  const pos = new Float32Array(n * n * 3)
  const uv = new Float32Array(n * n * 2)
  const p: [number, number, number] = [0, 0, 0]
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const lat = tileYToLat(id.y + j / (n - 1), id.z)
      const lon = tileXToLon(id.x + i / (n - 1), id.z)
      frame.fromGeodetic(lat, lon, 0, p)
      const k = j * n + i
      pos.set(p, k * 3)
      uv[k * 2] = i / (n - 1)
      uv[k * 2 + 1] = j / (n - 1)
    }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('uv', new BufferAttribute(uv, 2))
  g.setIndex(new BufferAttribute(gridIndices(n - 1), 1))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

export class TerrainManager {
  readonly root = new Group()
  readonly dem = new DemProvider()
  private tiles = new Map<string, TerrainTile>()
  private visible = new Set<TerrainTile>()
  private seaMaterial: Material
  private frameCount = 0
  readonly settings: TerrainSettings = { maxZoom: 17, splitFactor: 1.6, farRadius: 90_000 }
  private camLat = 0
  private camLon = 0
  private camH = 0
  /** Fires when a max-zoom tile becomes ready (physics attaches its grid). */
  onDetailTile: ((key: string, group: Group, grid: GridData) => void) | null = null
  onTileDisposed: ((key: string) => void) | null = null

  constructor(
    private world: WorldFrame,
    private anisotropy = 8,
  ) {
    this.root.name = 'terrain'
    this.seaMaterial = createWaterMaterial()
  }

  get readyCount(): number {
    let c = 0
    for (const t of this.tiles.values()) if (t.state === 'ready') c++
    return c
  }

  get visibleCount(): number {
    return this.visible.size
  }

  /** Height (m) at a geodetic point from the finest loaded DEM. */
  heightAt(lat: number, lon: number): number {
    return this.dem.heightAt(lat, lon)
  }

  /** Is the terrain around a point loaded at full detail (used before spawning). */
  async prefetchAround(lat: number, lon: number, radius = 600): Promise<void> {
    await Promise.all(tilesAround(lat, lon, radius, DEM_MAX_ZOOM).map((t) => this.dem.load(t)))
  }

  update(cameraWorld: Vector3, now: number): void {
    this.frameCount++
    if (this.frameCount % 6 !== 1) return
    const g = this.world.geodeticFromWorld(cameraWorld)
    this.camLat = g.lat
    this.camLon = g.lon
    const ground = this.dem.heightAt(g.lat, g.lon)
    this.camH = Math.max(0, g.h - (Number.isNaN(ground) ? 0 : ground))

    const next = new Set<TerrainTile>()
    const roots = tilesAround(g.lat, g.lon, this.settings.farRadius, ROOT_ZOOM)
    for (const r of roots) this.select(r, next, now)

    for (const t of this.visible) if (!next.has(t) && t.group) t.group.visible = false
    for (const t of next) if (t.group) t.group.visible = true
    this.visible = next
    this.evict(now)
  }

  private distanceTo(id: TileId): number {
    const b = tileBounds(id)
    const mLat = 111132.92
    const mLon = 111412.84 * Math.cos((this.camLat * Math.PI) / 180)
    const dx = this.camLon < b.west ? b.west - this.camLon : this.camLon > b.east ? this.camLon - b.east : 0
    const dy = this.camLat < b.south ? b.south - this.camLat : this.camLat > b.north ? this.camLat - b.north : 0
    return Math.hypot(dx * mLon, dy * mLat, this.camH)
  }

  private select(id: TileId, out: Set<TerrainTile>, now: number): void {
    const size = tileSizeMeters(id)
    const d = this.distanceTo(id)
    if (d > this.settings.farRadius && id.z > ROOT_ZOOM) return
    const tile = this.ensure(id, d)
    tile.lastUsed = now
    if (id.z < this.settings.maxZoom && d < size * this.settings.splitFactor) {
      const kids = children(id).map((k) => {
        const t = this.ensure(k, this.distanceTo(k))
        t.lastUsed = now
        return t
      })
      // Only refine once every child can be drawn, so there are never holes.
      if (kids.every((k) => k.state === 'ready')) {
        for (const k of kids) this.select(k.id, out, now)
        return
      }
    }
    if (tile.state === 'ready') out.add(tile)
  }

  private ensure(id: TileId, distance: number): TerrainTile {
    const k = tileKey(id)
    let t = this.tiles.get(k)
    if (!t) {
      t = new TerrainTile(id)
      this.tiles.set(k, t)
    }
    if (t.state === 'idle') {
      t.state = 'loading'
      void this.load(t, distance)
    }
    return t
  }

  private async load(t: TerrainTile, distance: number): Promise<void> {
    const id = t.id
    const priority = distance / tileSizeMeters(id) + (18 - id.z) * 0.05
    try {
      const demId = id.z > DEM_MAX_ZOOM ? parentAt(id, DEM_MAX_ZOOM) : id
      const [dem, photo] = await Promise.all([
        this.dem.load(demId),
        fetchImageBitmap(PHOTO(id), priority).catch(() => null),
      ])
      const c = tileCenter(id)
      const frame = new LocalFrame(c.lat, c.lon, 0)
      const grid = sampleGrid(id, dem, frame)
      const size = tileSizeMeters(id)
      const geom = buildGeometry(id, grid, frame, Math.max(4, size * 0.015))
      const mat = new MeshStandardMaterial({ roughness: 0.93, metalness: 0, color: photo ? 0xffffff : 0x3d5a40 })
      if (photo) {
        const tex = new Texture(photo)
        tex.colorSpace = SRGBColorSpace
        tex.flipY = false
        tex.anisotropy = this.anisotropy
        tex.minFilter = LinearMipmapLinearFilter
        tex.generateMipmaps = true
        tex.needsUpdate = true
        mat.map = tex
      }
      const group = new Group()
      group.name = `terrain ${tileKey(id)}`
      const mesh = new Mesh(geom, mat)
      mesh.receiveShadow = id.z >= 15
      mesh.name = 'ground'
      mesh.userData.terrain = true
      group.add(mesh)
      if (dem.hasSea && dem.minH <= 0.5) {
        const sea = new Mesh(buildSeaGeometry(id, frame), this.seaMaterial)
        sea.name = 'sea'
        sea.renderOrder = 1
        sea.receiveShadow = id.z >= 15
        group.add(sea)
      }
      group.visible = false
      this.world.anchor(group, anchorMatrix(c.lat, c.lon, 0))
      this.root.add(group)
      t.group = group
      t.dem = dem
      t.positions = grid.positions
      t.state = 'ready'
      if (id.z >= 17 && this.onDetailTile) this.onDetailTile(tileKey(id), group, grid)
    } catch (e) {
      console.warn('terrain tile failed', tileKey(id), e)
      t.state = 'error'
    }
  }

  private evict(now: number): void {
    if (this.tiles.size < 500) return
    for (const [k, t] of this.tiles) {
      if (now - t.lastUsed > 15_000 && t.state !== 'loading' && !this.visible.has(t)) {
        if (t.group) {
          this.world.unanchor(t.group)
          this.root.remove(t.group)
          t.group.traverse((o) => {
            if (o instanceof Mesh) {
              o.geometry.dispose()
              if (o.material !== this.seaMaterial) {
                const m = o.material as MeshStandardMaterial
                m.map?.dispose()
                m.dispose()
              }
            }
          })
        }
        this.tiles.delete(k)
        this.onTileDisposed?.(k)
      }
    }
  }

  /** Is the terrain under a point drawn at full detail yet? */
  isDetailedAt(lat: number, lon: number): boolean {
    for (const t of this.visible) {
      if (t.id.z < 17) continue
      const b = tileBounds(t.id)
      if (lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north) return true
    }
    return false
  }
}

export { GRID_INDICES }
