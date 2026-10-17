// Web-Mercator XYZ tile math (the scheme used by GSI, OpenFreeMap, Terrarium).
import { deg } from './geo'

export interface TileId {
  z: number
  x: number
  y: number
}

export const tileKey = (t: TileId): string => `${t.z}/${t.x}/${t.y}`

export function parseTileKey(k: string): TileId {
  const [z, x, y] = k.split('/').map(Number)
  return { z, x, y }
}

/** Fractional tile coordinates for a lat/lon. */
export function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = ((lon + 180) / 360) * n
  const r = lat * deg
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
  return { x, y }
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

export interface TileBounds {
  west: number
  east: number
  north: number
  south: number
}

export function tileBounds(t: TileId): TileBounds {
  return {
    west: tileXToLon(t.x, t.z),
    east: tileXToLon(t.x + 1, t.z),
    north: tileYToLat(t.y, t.z),
    south: tileYToLat(t.y + 1, t.z),
  }
}

export function tileCenter(t: TileId): { lat: number; lon: number } {
  return { lon: tileXToLon(t.x + 0.5, t.z), lat: tileYToLat(t.y + 0.5, t.z) }
}

/** Approximate ground width of a tile in metres at its latitude. */
export function tileSizeMeters(t: TileId): number {
  const { lat } = tileCenter(t)
  return (40075016.686 * Math.cos(lat * deg)) / 2 ** t.z
}

export function parentAt(t: TileId, z: number): TileId {
  const s = t.z - z
  return { z, x: t.x >> s, y: t.y >> s }
}

export function children(t: TileId): TileId[] {
  const z = t.z + 1
  const x = t.x * 2
  const y = t.y * 2
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ]
}

/** Tiles at zoom z whose area intersects a circle (approx) around a point. */
export function tilesAround(lat: number, lon: number, radiusM: number, z: number): TileId[] {
  const mLat = 111132.92
  const mLon = 111412.84 * Math.cos(lat * deg)
  const dLat = radiusM / mLat
  const dLon = radiusM / mLon
  const a = lonLatToTileXY(lon - dLon, lat + dLat, z)
  const b = lonLatToTileXY(lon + dLon, lat - dLat, z)
  const out: TileId[] = []
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) out.push({ z, x, y })
  }
  return out
}
