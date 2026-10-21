// Elevation provider: GSI 地理院 DEM PNG tiles (Japan, 10 m at z14) with AWS
// Terrarium as a global fallback (sea, overseas coasts).
import { lonLatToTileXY, tileKey, type TileId } from '../../core/tiles'
import { fetchImageData } from '../../core/net'

export const DEM_MAX_ZOOM = 14
export const DEM_SIZE = 256
/** Height used where the DEM has no data (open sea). Sits just under the ocean surface. */
export const SEA_FLOOR = -4

export interface DemTile {
  id: TileId
  heights: Float32Array // DEM_SIZE * DEM_SIZE, row-major from north-west
  hasSea: boolean
  /** 1 where the cell is open sea (no land elevation), else 0. */
  sea?: Uint8Array
  minH: number
  maxH: number
}

const GSI_DEM = (t: TileId) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${t.z}/${t.x}/${t.y}.png`
const TERRARIUM = (t: TileId) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png`

function decodeGSI(data: Uint8ClampedArray, out: Float32Array): number {
  let na = 0
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const v = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]
    if (v === 0x800000) {
      out[i] = NaN
      na++
    } else out[i] = (v < 0x800000 ? v : v - 0x1000000) * 0.01
  }
  return na
}

function decodeTerrarium(data: Uint8ClampedArray, out: Float32Array): void {
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768
  }
}

export class DemProvider {
  private cache = new Map<string, DemTile>()
  private pending = new Map<string, Promise<DemTile>>()
  private order: string[] = []
  constructor(private maxEntries = 600) {}

  get(t: TileId): DemTile | undefined {
    return this.cache.get(tileKey(t))
  }

  /** `priority`: lower first, shared scale with the rest of the tile queue. */
  load(t: TileId, priority = 0): Promise<DemTile> {
    const k = tileKey(t)
    const hit = this.cache.get(k)
    if (hit) return Promise.resolve(hit)
    let p = this.pending.get(k)
    if (!p) {
      p = this.fetchTile(t, priority).then((tile) => {
        this.pending.delete(k)
        this.cache.set(k, tile)
        this.order.push(k)
        if (this.order.length > this.maxEntries) {
          const old = this.order.shift()!
          this.cache.delete(old)
        }
        return tile
      })
      this.pending.set(k, p)
    }
    return p
  }

  private async fetchTile(t: TileId, priority: number): Promise<DemTile> {
    const heights = new Float32Array(DEM_SIZE * DEM_SIZE)
    let na = DEM_SIZE * DEM_SIZE
    const gsi = await fetchImageData(GSI_DEM(t), priority).catch(() => null)
    if (gsi) na = decodeGSI(gsi.data, heights)
    let hasSea = na > 0
    let sea: Uint8Array | undefined
    if (na > 0) {
      sea = new Uint8Array(DEM_SIZE * DEM_SIZE)
      // Fill gaps (sea / outside Japan) from Terrarium; clamp bathymetry.
      const ter = await fetchImageData(TERRARIUM(t), priority).catch(() => null)
      const tmp = new Float32Array(DEM_SIZE * DEM_SIZE)
      if (ter) decodeTerrarium(ter.data, tmp)
      for (let i = 0; i < heights.length; i++) {
        if (Number.isNaN(heights[i])) {
          const v = ter ? tmp[i] : SEA_FLOOR
          heights[i] = v <= 0.5 ? SEA_FLOOR : v
          if (v <= 0.5) sea[i] = 1
        }
      }
    }
    let minH = Infinity
    let maxH = -Infinity
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i]
      if (h < minH) minH = h
      if (h > maxH) maxH = h
      if (h <= 0) hasSea = true
    }
    return { id: t, heights, hasSea, sea, minH, maxH }
  }

  /** Bilinear height at a point from a specific DEM tile (must be loaded). */
  static sampleTile(tile: DemTile, lon: number, lat: number): number {
    const { x, y } = lonLatToTileXY(lon, lat, tile.id.z)
    const px = Math.min(DEM_SIZE - 1.001, Math.max(0, (x - tile.id.x) * DEM_SIZE - 0.5))
    const py = Math.min(DEM_SIZE - 1.001, Math.max(0, (y - tile.id.y) * DEM_SIZE - 0.5))
    const ix = Math.floor(px)
    const iy = Math.floor(py)
    const fx = px - ix
    const fy = py - iy
    const h = tile.heights
    const i0 = iy * DEM_SIZE + ix
    const a = h[i0]
    const b = h[i0 + 1]
    const c = h[i0 + DEM_SIZE]
    const d = h[i0 + DEM_SIZE + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  }

  /**
   * Height at a point using the most detailed DEM tile already in cache.
   * Returns NaN when nothing covering the point is loaded.
   */
  heightAt(lat: number, lon: number, maxZoom = DEM_MAX_ZOOM): number {
    for (let z = maxZoom; z >= 6; z--) {
      const { x, y } = lonLatToTileXY(lon, lat, z)
      const t = this.cache.get(`${z}/${Math.floor(x)}/${Math.floor(y)}`)
      if (t) return DemProvider.sampleTile(t, lon, lat)
    }
    return NaN
  }

  /** How much of the neighbourhood of a point is open sea (0..1, bilinear). */
  seaAt(lat: number, lon: number, maxZoom = DEM_MAX_ZOOM): number {
    for (let z = maxZoom; z >= 6; z--) {
      const { x, y } = lonLatToTileXY(lon, lat, z)
      const t = this.cache.get(`${z}/${Math.floor(x)}/${Math.floor(y)}`)
      if (!t) continue
      if (!t.sea) return 0
      const px = Math.min(DEM_SIZE - 1.001, Math.max(0, (x - t.id.x) * DEM_SIZE - 0.5))
      const py = Math.min(DEM_SIZE - 1.001, Math.max(0, (y - t.id.y) * DEM_SIZE - 0.5))
      const ix = Math.floor(px)
      const iy = Math.floor(py)
      const fx = px - ix
      const fy = py - iy
      const m = t.sea
      const i0 = iy * DEM_SIZE + ix
      return (m[i0] * (1 - fx) + m[i0 + 1] * fx) * (1 - fy) + (m[i0 + DEM_SIZE] * (1 - fx) + m[i0 + DEM_SIZE + 1] * fx) * fy
    }
    return 0
  }

  /** Ensure the z14 tile under a point is loaded, then return exact height. */
  async heightAtAsync(lat: number, lon: number): Promise<number> {
    const { x, y } = lonLatToTileXY(lon, lat, DEM_MAX_ZOOM)
    const t = await this.load({ z: DEM_MAX_ZOOM, x: Math.floor(x), y: Math.floor(y) })
    return DemProvider.sampleTile(t, lon, lat)
  }
}
