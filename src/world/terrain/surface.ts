// Exact height of the rendered (and physical) ground surface.
//
// Near the player the terrain is drawn as z17 tiles with a 32x32 grid, i.e. a
// regular grid in Web-Mercator tile space at zoom 22, each vertex sampled
// bilinearly from the z14 DEM and each cell split into two triangles. Roads,
// buildings, props and physics must sit on *that* surface, not on the
// bilinear DEM, or they float and sink between vertices.
import { lonLatToTileXY, tileXToLon, tileYToLat } from '../../core/tiles'

export const SURFACE_GRID_ZOOM = 22 // z17 tile * 32 segments
const DEM_SIZE = 256

export interface DemLike {
  id: { z: number; x: number; y: number }
  heights: Float32Array
}

export function demBilinear(dem: DemLike, lon: number, lat: number): number {
  const { x, y } = lonLatToTileXY(lon, lat, dem.id.z)
  const px = Math.min(DEM_SIZE - 1.001, Math.max(0, (x - dem.id.x) * DEM_SIZE - 0.5))
  const py = Math.min(DEM_SIZE - 1.001, Math.max(0, (y - dem.id.y) * DEM_SIZE - 0.5))
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const fx = px - ix
  const fy = py - iy
  const h = dem.heights
  const i0 = iy * DEM_SIZE + ix
  return (h[i0] * (1 - fx) + h[i0 + 1] * fx) * (1 - fy) + (h[i0 + DEM_SIZE] * (1 - fx) + h[i0 + DEM_SIZE + 1] * fx) * fy
}

/** Height of the triangulated z17 terrain surface at a point. */
export function surfaceHeight(dem: DemLike, lon: number, lat: number): number {
  const z = SURFACE_GRID_ZOOM
  const { x, y } = lonLatToTileXY(lon, lat, z)
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j
  const lon0 = tileXToLon(i, z)
  const lon1 = tileXToLon(i + 1, z)
  const lat0 = tileYToLat(j, z)
  const lat1 = tileYToLat(j + 1, z)
  const a = demBilinear(dem, lon0, lat0)
  const b = demBilinear(dem, lon1, lat0)
  const c = demBilinear(dem, lon0, lat1)
  const d = demBilinear(dem, lon1, lat1)
  if (fx + fy <= 1) return a + (b - a) * fx + (c - a) * fy
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fy)
}
