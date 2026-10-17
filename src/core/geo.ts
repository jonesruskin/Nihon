// Geodesy for the whole game. Everything is WGS84; all math in float64.
//
// Conventions
//   lat/lon in degrees, height in metres above the ellipsoid (we treat GSI
//   orthometric heights as ellipsoidal; the ~37 m geoid offset over Japan is
//   irrelevant visually and handled per-dataset where alignment matters).
//   World frame (Three.js, Y-up): X = east, Y = up, Z = south.

export const WGS84_A = 6378137.0
export const WGS84_F = 1 / 298.257223563
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const DEG = Math.PI / 180

export interface LatLon {
  lat: number
  lon: number
}

export interface LatLonH extends LatLon {
  h: number
}

export type Vec3 = [number, number, number]

export function geodeticToECEF(lat: number, lon: number, h: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const phi = lat * DEG
  const lam = lon * DEG
  const sp = Math.sin(phi)
  const cp = Math.cos(phi)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sp * sp)
  out[0] = (n + h) * cp * Math.cos(lam)
  out[1] = (n + h) * cp * Math.sin(lam)
  out[2] = (n * (1 - WGS84_E2) + h) * sp
  return out
}

/** Bowring-style iterative inverse; converges to < 1 mm in 3 iterations. */
export function ecefToGeodetic(x: number, y: number, z: number): LatLonH {
  const lon = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  let phi = Math.atan2(z, p * (1 - WGS84_E2))
  let h = 0
  for (let i = 0; i < 5; i++) {
    const sp = Math.sin(phi)
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sp * sp)
    h = p / Math.cos(phi) - n
    phi = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + h)))
  }
  return { lat: phi / DEG, lon: lon / DEG, h }
}

/**
 * Row-major 3x3 rotation whose columns are the world axes expressed in ECEF:
 * col0 = east, col1 = up, col2 = south.
 */
export function enuBasis(lat: number, lon: number): { east: Vec3; up: Vec3; south: Vec3 } {
  const phi = lat * DEG
  const lam = lon * DEG
  const sp = Math.sin(phi)
  const cp = Math.cos(phi)
  const sl = Math.sin(lam)
  const cl = Math.cos(lam)
  return {
    east: [-sl, cl, 0],
    up: [cp * cl, cp * sl, sp],
    south: [sp * cl, sp * sl, -cp],
  }
}

/** A local tangent frame anchored at a geodetic point (the "anchor"). */
export class LocalFrame {
  readonly origin: Vec3
  readonly east: Vec3
  readonly up: Vec3
  readonly south: Vec3

  constructor(
    readonly lat: number,
    readonly lon: number,
    readonly h = 0,
  ) {
    this.origin = geodeticToECEF(lat, lon, h)
    const b = enuBasis(lat, lon)
    this.east = b.east
    this.up = b.up
    this.south = b.south
  }

  /** ECEF -> local (x east, y up, z south). */
  fromECEF(x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const dx = x - this.origin[0]
    const dy = y - this.origin[1]
    const dz = z - this.origin[2]
    out[0] = dx * this.east[0] + dy * this.east[1] + dz * this.east[2]
    out[1] = dx * this.up[0] + dy * this.up[1] + dz * this.up[2]
    out[2] = dx * this.south[0] + dy * this.south[1] + dz * this.south[2]
    return out
  }

  /** local -> ECEF */
  toECEF(lx: number, ly: number, lz: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = this.origin[0] + lx * this.east[0] + ly * this.up[0] + lz * this.south[0]
    out[1] = this.origin[1] + lx * this.east[1] + ly * this.up[1] + lz * this.south[1]
    out[2] = this.origin[2] + lx * this.east[2] + ly * this.up[2] + lz * this.south[2]
    return out
  }

  fromGeodetic(lat: number, lon: number, h: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const e = geodeticToECEF(lat, lon, h, scratch)
    return this.fromECEF(e[0], e[1], e[2], out)
  }

  toGeodetic(lx: number, ly: number, lz: number): LatLonH {
    const e = this.toECEF(lx, ly, lz, scratch)
    return ecefToGeodetic(e[0], e[1], e[2])
  }

  /**
   * Column-major 4x4 (Three.js Matrix4.elements layout) mapping local -> ECEF.
   */
  toECEFMatrix(): number[] {
    const { east: e, up: u, south: s, origin: o } = this
    return [e[0], e[1], e[2], 0, u[0], u[1], u[2], 0, s[0], s[1], s[2], 0, o[0], o[1], o[2], 1]
  }
}

const scratch: Vec3 = [0, 0, 0]

/** Fast flat-earth metres between two nearby points (selection heuristics only). */
export function approxDistanceMeters(a: LatLon, b: LatLon): number {
  const mPerDegLat = 111132.92
  const mPerDegLon = 111412.84 * Math.cos(((a.lat + b.lat) / 2) * DEG)
  return Math.hypot((b.lat - a.lat) * mPerDegLat, (b.lon - a.lon) * mPerDegLon)
}

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const R = 6371008.8
  const dLat = (b.lat - a.lat) * DEG
  const dLon = (b.lon - a.lon) * DEG
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export function metersPerDegree(lat: number): { lat: number; lon: number } {
  return { lat: 111132.92, lon: 111412.84 * Math.cos(lat * DEG) }
}

export const deg = DEG
