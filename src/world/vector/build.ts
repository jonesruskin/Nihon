// Turns one OpenMapTiles z14 vector tile into renderable Japanese streetscape:
// roads with markings, sidewalks, elevated expressways and railways, water,
// trees, OSM buildings (where PLATEAU has no model) with Japanese roofs,
// utility poles + wires, street lights, vending machines, POIs and a
// navigation network. Pure function; runs in a worker.
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import earcut from 'earcut'
import { HERITAGE, type HeritageStyle } from '../../data/heritage'
import { tileCenter, tileXToLon, tileYToLat, type TileId } from '../../core/tiles'
import { WGS84_A, WGS84_E2 } from '../../core/geo'
import { surfaceHeight, type DemLike } from '../terrain/surface'
import { MeshBuilder, type MeshData } from './MeshBuilder'
import { centroid, densify, hash2, minAreaRect, pointInRing, polygonArea, rng, sampleAlong, type P2 } from './geom'

export interface BuildRequest {
  id: TileId
  pbf: ArrayBuffer
  dem: DemLike
  /** PLATEAU coverage boxes [w,s,e,n] in degrees: skip OSM buildings inside. */
  coverage: Array<[number, number, number, number]>
  detail: number // 0..1 density scale for props/trees
}

export interface Poi {
  name: string
  nameEn: string
  cls: string
  sub: string
  lat: number
  lon: number
  x: number
  y: number
  z: number
}

export interface Place {
  name: string
  reading: string
  romaji: string
  nameEn: string
  cls: string
  rank: number
  lat: number
  lon: number
}

export interface NavPath {
  kind: 'road' | 'foot' | 'rail'
  cls: string
  oneway: number
  width: number
  name: string
  bridge: boolean
  pts: Float32Array // xyz triplets (anchor frame)
}

/** A wood polygon, for filling in forest at true density near the player. */
export interface WoodArea {
  rings: Float32Array[] // xz pairs (anchor frame); outer ring first, then holes
  bbox: [number, number, number, number] // minX, minZ, maxX, maxZ
  /** Mountain or plantation forest (sugi/hinoki) rather than lowland wood. */
  mountain: boolean
}

/** Building cell size (m) in near tiles. */
const CELL = 700

export interface TileBuild {
  id: TileId
  anchor: { lat: number; lon: number }
  /** Walls and roofs in ~700 m cells (near tiles), so each can be frustum- and shadow-culled. */
  buildings: MeshData[]
  roofs: MeshData[]
  roads: MeshData | null
  sidewalks: MeshData | null
  ballast: MeshData | null
  rails: MeshData | null
  structures: MeshData | null
  water: MeshData | null
  instances: Record<string, Float32Array>
  wires: Float32Array
  pois: Poi[]
  places: Place[]
  paths: NavPath[]
  woods: WoodArea[]
  stats: Record<string, number>
}

const EARTH_R = 6371000

interface RoadSpec {
  w: number
  cls: number
  side: number
  lanes: number
}
const ROADS: Record<string, RoadSpec> = {
  motorway: { w: 7.6, cls: 0, side: 0, lanes: 2 },
  trunk: { w: 12, cls: 1, side: 3, lanes: 4 },
  primary: { w: 11, cls: 2, side: 3, lanes: 4 },
  secondary: { w: 9, cls: 3, side: 2.5, lanes: 2 },
  tertiary: { w: 7, cls: 4, side: 2, lanes: 2 },
  busway: { w: 7, cls: 4, side: 0, lanes: 2 },
  minor: { w: 5, cls: 5, side: 0, lanes: 1 },
  service: { w: 3.6, cls: 6, side: 0, lanes: 1 },
  track: { w: 3, cls: 7, side: 0, lanes: 1 },
  raceway: { w: 8, cls: 4, side: 0, lanes: 2 },
}
const FOOT: Record<string, number> = { footway: 2.2, pedestrian: 5, path: 1.8, cycleway: 2.2, steps: 2.4, bridleway: 2, corridor: 0, platform: 0 }

type Inst = number[]

export function buildTile(req: BuildRequest): TileBuild {
  const { id, dem } = req
  const tile = new VectorTile(new PbfReader(new Uint8Array(req.pbf)))
  const anchor = tileCenter(id)
  const phi = (anchor.lat * Math.PI) / 180
  const sp = Math.sin(phi)
  const w = Math.sqrt(1 - WGS84_E2 * sp * sp)
  const mLat = ((WGS84_A * (1 - WGS84_E2)) / (w * w * w)) * (Math.PI / 180)
  const mLon = (WGS84_A / w) * Math.cos(phi) * (Math.PI / 180)
  const lonOf = (x: number) => anchor.lon + x / mLon
  const latOf = (n: number) => anchor.lat + n / mLat
  const ground = (x: number, n: number) => surfaceHeight(dem, lonOf(x), latOf(n))
  const drop = (x: number, n: number) => (x * x + n * n) / (2 * EARTH_R)
  const R = rng(id.x * 73856093 ^ id.y * 19349663)

  const extentToLocal = (ext: number, px: number, py: number): P2 => {
    const lon = tileXToLon(id.x + px / ext, id.z)
    const lat = tileYToLat(id.y + py / ext, id.z)
    return [(lon - anchor.lon) * mLon, (lat - anchor.lat) * mLat]
  }
  // Clip helper: features carry a buffer beyond the tile; keep geometry whose
  // reference point lies inside this tile so neighbours don't duplicate it.
  const half = 40075016.686 * Math.cos(phi) / 2 ** id.z / 2
  const inTile = (p: P2) => Math.abs(p[0]) <= half * 1.0001 && Math.abs(p[1]) <= half * 1.0001

  const instances: Record<string, Inst> = {
    tree: [],
    pole: [],
    light: [],
    vending: [],
    pillar: [],
    signal: [],
    mast: [],
    ac: [],
    tank: [],
    antenna: [],
  }
  const wires: number[] = []
  const pois: Poi[] = []
  const paths: NavPath[] = []
  const woods: WoodArea[] = []
  const stats: Record<string, number> = {}

  const V = (x: number, n: number, h: number): [number, number, number] => [x, h - drop(x, n), -n]

  // ---------------------------------------------------------------- roads
  const roads = new MeshBuilder(true, { road: 4 })
  const sidewalks = new MeshBuilder(true)
  const structures = new MeshBuilder(false)
  const ballast = new MeshBuilder(true)
  const rails = new MeshBuilder(false)

  const tl = tile.layers.transportation
  interface Line {
    pts: P2[]
    props: VectorTileFeature['properties']
    ext: number
    keys: string[]
  }
  const lines: Line[] = []
  const degree = new Map<string, number>()
  const bridgeEnds = new Map<string, number>()
  if (tl) {
    for (let i = 0; i < tl.length; i++) {
      const f = tl.feature(i)
      if (f.type !== 2) continue
      const props = f.properties
      if (props.brunnel === 'tunnel') continue
      for (const g of f.loadGeometry()) {
        if (g.length < 2) continue
        const keys = g.map((p) => `${p.x},${p.y}`)
        keys.forEach((k, j) => degree.set(k, (degree.get(k) ?? 0) + (j === 0 || j === keys.length - 1 ? 1 : 2)))
        if (props.brunnel === 'bridge') {
          for (const k of [keys[0], keys[keys.length - 1]]) bridgeEnds.set(k, (bridgeEnds.get(k) ?? 0) + 1)
        }
        lines.push({ pts: g.map((p) => extentToLocal(tl.extent, p.x, p.y)), props, ext: tl.extent, keys })
      }
    }
  }

  /** Distance along a polyline to the nearest junction at either end. */
  const junctionAt = (k: string) => (degree.get(k) ?? 0) >= 3

  for (const L of lines) {
    const cls = String(L.props.class ?? '')
    const sub = String(L.props.subclass ?? '')
    const isRail = cls === 'rail' || cls === 'transit'
    const spec = ROADS[cls]
    const footW = cls === 'path' ? FOOT[sub] ?? 1.8 : 0
    if (!spec && !footW && !isRail) continue
    const mid = L.pts[Math.floor(L.pts.length / 2)]
    if (!inTile(mid)) continue
    const bridge = L.props.brunnel === 'bridge'
    const layer = Number(L.props.layer ?? (bridge ? 1 : 0))
    const ramp = Number(L.props.ramp ?? 0) === 1
    const width = isRail ? 3.6 : spec ? (ramp ? 5 : spec.w) : footW
    const pts = densify(L.pts, 6)
    // Distances along
    const sAlong: number[] = [0]
    for (let i = 1; i < pts.length; i++) sAlong.push(sAlong[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    const total = sAlong[sAlong.length - 1]
    if (total < 0.5) continue
    const startJ = junctionAt(L.keys[0])
    const endJ = junctionAt(L.keys[L.keys.length - 1])

    // Deck/ground heights.
    const g = pts.map((p) => ground(p[0], p[1]))
    let h = g.map((v) => v + (isRail ? 0.25 : 0.12) + (spec ? (6 - spec.cls) * 0.004 : 0))
    let elevated = false
    if (bridge) {
      const g0 = g[0]
      const g1 = g[g.length - 1]
      const bigStructure = (cls === 'motorway' || cls === 'trunk' || isRail) && layer >= 1
      const lift = bigStructure ? 6.5 * Math.min(layer, 3) : 0
      const startHeld = (bridgeEnds.get(L.keys[0]) ?? 0) >= 2
      const endHeld = (bridgeEnds.get(L.keys[L.keys.length - 1]) ?? 0) >= 2
      h = pts.map((_, i) => {
        const t = sAlong[i] / total
        const base = g0 + (g1 - g0) * t
        const rampIn = startHeld ? 1 : Math.min(1, sAlong[i] / 140)
        const rampOut = endHeld ? 1 : Math.min(1, (total - sAlong[i]) / 140)
        const deck = base + lift * Math.min(rampIn, rampOut) + 0.6
        return Math.max(deck, g[i] + 0.4)
      })
      elevated = h.some((v, i) => v - g[i] > 3)
    }

    // Ribbon
    const target = isRail ? ballast : spec ? roads : sidewalks
    const halfW = width / 2
    let prev: number[] | null = null
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(pts.length - 1, i + 1)]
      let tx = b[0] - a[0]
      let ty = b[1] - a[1]
      const tl2 = Math.hypot(tx, ty) || 1
      tx /= tl2
      ty /= tl2
      const nx = ty
      const ny = -tx // right-hand normal
      const s = sAlong[i]
      const jd = Math.min(startJ ? s : 1e4, endJ ? total - s : 1e4)
      const p = pts[i]
      const l = V(p[0] - nx * halfW, p[1] - ny * halfW, h[i])
      const r = V(p[0] + nx * halfW, p[1] + ny * halfW, h[i])
      const extra = spec ? [halfW, spec.cls + (ramp ? 0.5 : 0), jd, spec.lanes] : []
      const vl = target.vertex(l[0], l[1], l[2], 0, 1, 0, -halfW, s, ...extra)
      const vr = target.vertex(r[0], r[1], r[2], 0, 1, 0, halfW, s, ...extra)
      if (prev) target.quadUp(prev[0], vl, vr, prev[1])
      prev = [vl, vr]
    }
    // Sidewalks along major roads (Japan: raised kerb, pavers).
    if (spec && spec.side > 0 && !bridge && req.detail >= 1) {
      // A one-way major road is one carriageway of a dual road: its kerb and
      // pavement are on the left of travel (Japan), the median on the right.
      const ow = Number(L.props.oneway ?? 0)
      const sides = ow !== 0 && spec.cls <= 3 ? [ow > 0 ? -1 : 1] : [-1, 1]
      for (const sign of sides) {
        let pv: number[] | null = null
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)]
          const b = pts[Math.min(pts.length - 1, i + 1)]
          let tx = b[0] - a[0]
          let ty = b[1] - a[1]
          const l2 = Math.hypot(tx, ty) || 1
          tx /= l2
          ty /= l2
          const nx = ty * sign
          const ny = -tx * sign
          const s = sAlong[i]
          const jd = Math.min(startJ ? s : 1e4, endJ ? total - s : 1e4)
          if (jd < 6) {
            pv = null
            continue
          }
          const p = pts[i]
          const hh = h[i] + 0.15
          const i0 = V(p[0] + nx * halfW, p[1] + ny * halfW, hh)
          const o0 = V(p[0] + nx * (halfW + spec.side), p[1] + ny * (halfW + spec.side), hh)
          const k0 = V(p[0] + nx * halfW, p[1] + ny * halfW, h[i])
          const vi = sidewalks.vertex(i0[0], i0[1], i0[2], 0, 1, 0, 0, s)
          const vo = sidewalks.vertex(o0[0], o0[1], o0[2], 0, 1, 0, spec.side, s)
          const vk = sidewalks.vertex(k0[0], k0[1], k0[2], nx * -1, 0, ny, -0.15, s)
          const vk2 = sidewalks.vertex(i0[0], i0[1], i0[2], nx * -1, 0, ny, 0, s)
          if (pv) {
            sidewalks.quadUp(pv[0], vi, vo, pv[1])
            sidewalks.quad(pv[2], vk, vk2, pv[3])
            sidewalks.quad(pv[2], vk2, vk, pv[3])
          }
          pv = [vi, vo, vk, vk2]
        }
      }
    }
    // Viaduct structure: deck slab sides + parapets + pillars.
    if (bridge && elevated) {
      const thick = 1.6
      for (const sign of [-1, 1]) {
        let pv: number[] | null = null
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)]
          const b = pts[Math.min(pts.length - 1, i + 1)]
          let tx = b[0] - a[0]
          let ty = b[1] - a[1]
          const l2 = Math.hypot(tx, ty) || 1
          tx /= l2
          ty /= l2
          const nx = ty * sign
          const ny = -tx * sign
          const p = pts[i]
          const ex = p[0] + nx * (halfW + 0.3)
          const ey = p[1] + ny * (halfW + 0.3)
          const top = V(ex, ey, h[i] + 1.1)
          const bot = V(ex, ey, h[i] - thick)
          const vt = structures.vertex(top[0], top[1], top[2], nx, 0, -ny)
          const vb = structures.vertex(bot[0], bot[1], bot[2], nx, 0, -ny)
          if (pv) {
            if (sign > 0) structures.quad(pv[1], vb, vt, pv[0])
            else structures.quad(pv[0], vt, vb, pv[1])
          }
          pv = [vt, vb]
        }
      }
      // underside
      let pu: number[] | null = null
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)]
        const b = pts[Math.min(pts.length - 1, i + 1)]
        let tx = b[0] - a[0]
        let ty = b[1] - a[1]
        const l2 = Math.hypot(tx, ty) || 1
        tx /= l2
        ty /= l2
        const p = pts[i]
        const l = V(p[0] - ty * (halfW + 0.3), p[1] + tx * (halfW + 0.3), h[i] - 1.6)
        const r = V(p[0] + ty * (halfW + 0.3), p[1] - tx * (halfW + 0.3), h[i] - 1.6)
        const vl = structures.vertex(l[0], l[1], l[2], 0, -1, 0)
        const vr = structures.vertex(r[0], r[1], r[2], 0, -1, 0)
        if (pu) {
          structures.quad(pu[1], vr, vl, pu[0])
          structures.quad(pu[0], vl, vr, pu[1])
        }
        pu = [vl, vr]
      }
      for (const sm of sampleAlong(pts, 28)) {
        const gh = ground(sm.p[0], sm.p[1])
        const i = Math.min(pts.length - 1, Math.round((sm.s / total) * (pts.length - 1)))
        const clearance = h[i] - 1.6 - gh
        if (clearance > 2.5) {
          const v = V(sm.p[0], sm.p[1], gh)
          instances.pillar.push(v[0], v[1], v[2], Math.atan2(sm.t[0], sm.t[1]), clearance, Math.max(1, width / 7))
        }
      }
    }

    // Rails: two steel rails per track.
    if (isRail) {
      const gauge = sub === 'rail' && /新幹線|Shinkansen/.test(String(L.props.name ?? '')) ? 1.435 : 1.067
      for (const off of [-gauge / 2, gauge / 2]) {
        let pv: number[] | null = null
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)]
          const b = pts[Math.min(pts.length - 1, i + 1)]
          let tx = b[0] - a[0]
          let ty = b[1] - a[1]
          const l2 = Math.hypot(tx, ty) || 1
          tx /= l2
          ty /= l2
          const p = pts[i]
          const c = [p[0] + ty * off, p[1] - tx * off]
          const t1 = V(c[0] - ty * 0.035, c[1] + tx * 0.035, h[i] + 0.17)
          const t2 = V(c[0] + ty * 0.035, c[1] - tx * 0.035, h[i] + 0.17)
          const vt1 = rails.vertex(t1[0], t1[1], t1[2], 0, 1, 0)
          const vt2 = rails.vertex(t2[0], t2[1], t2[2], 0, 1, 0)
          if (pv) rails.quadUp(pv[0], vt1, vt2, pv[1])
          pv = [vt1, vt2]
        }
      }
    }

    // Overhead catenary (架線): masts every ~50 m with a cantilever over the
    // track, contact wire at 5.1 m and the messenger wire above it.
    if (isRail && req.detail >= 1 && total > 30) {
      const masts = sampleAlong(pts, 50, 10)
      let prevC: number[] | null = null
      let prevM: number[] | null = null
      for (const sm of masts) {
        const i = Math.min(pts.length - 1, Math.round((sm.s / total) * (pts.length - 1)))
        const rh = h[i] + 0.17
        const nx = sm.t[1]
        const ny = -sm.t[0]
        const mx = sm.p[0] + nx * 2.7
        const my = sm.p[1] + ny * 2.7
        const base = V(mx, my, Math.min(rh - 0.2, bridge ? rh - 0.2 : ground(mx, my)))
        const c = V(sm.p[0], sm.p[1], rh + 5.1)
        const m = V(sm.p[0], sm.p[1], rh + 6.15)
        const yaw = Math.atan2(c[0] - base[0], c[2] - base[2])
        instances.mast.push(base[0], base[1], base[2], yaw, rh + 6.6 - (base[1] + drop(mx, my)), 0)
        if (prevC && prevM) {
          wires.push(...prevC, ...c)
          const SEG = 4
          for (let k = 0; k < SEG; k++) {
            const t0 = k / SEG
            const t1 = (k + 1) / SEG
            const sag = (t: number) => 4 * t * (1 - t) * 0.5
            wires.push(
              prevM[0] + (m[0] - prevM[0]) * t0, prevM[1] + (m[1] - prevM[1]) * t0 - sag(t0), prevM[2] + (m[2] - prevM[2]) * t0,
              prevM[0] + (m[0] - prevM[0]) * t1, prevM[1] + (m[1] - prevM[1]) * t1 - sag(t1), prevM[2] + (m[2] - prevM[2]) * t1,
            )
          }
        }
        prevC = c
        prevM = m
      }
    }

    // Navigation path
    const p3 = new Float32Array(pts.length * 3)
    pts.forEach((p, i) => p3.set(V(p[0], p[1], h[i]), i * 3))
    paths.push({
      kind: isRail ? 'rail' : spec ? 'road' : 'foot',
      cls: isRail ? sub || cls : cls,
      oneway: Number(L.props.oneway ?? 0),
      width,
      name: String(L.props.name ?? ''),
      bridge,
      pts: p3,
    })

    // Roadside furniture (not on bridges).
    if (spec && !bridge) {
      const urbanMajor = spec.cls >= 1 && spec.cls <= 3
      const seed = hash2(mid[0], mid[1])
      if (urbanMajor && req.detail >= 1) {
        for (const sm of sampleAlong(pts, 30)) {
          const side = (Math.floor(sm.s / 30) % 2) * 2 - 1
          const off = halfW + 0.45
          const px = sm.p[0] + sm.t[1] * off * side
          const py = sm.p[1] - sm.t[0] * off * side
          const v = V(px, py, ground(px, py) + 0.15)
          instances.light.push(v[0], v[1], v[2], Math.atan2(-sm.t[1] * side, sm.t[0] * side), 1, 0)
        }
        if (spec.side > 0) {
          for (const sm of sampleAlong(pts, 9)) {
            for (const side of [-1, 1]) {
              if (R() < 0.25) continue
              const off = halfW + Math.min(1.4, spec.side * 0.55)
              const px = sm.p[0] + sm.t[1] * off * side
              const py = sm.p[1] - sm.t[0] * off * side
              const v = V(px, py, ground(px, py) + 0.15)
              instances.tree.push(v[0], v[1], v[2], R() * 6.28, 0.8 + R() * 0.35, seed < 0.5 ? 3 : 0)
            }
          }
        }
      }
      // Utility poles + overhead wires: the defining look of Japanese streets.
      if (req.detail >= 1 && spec.cls >= 3 && spec.cls <= 6) {
        const side = seed < 0.5 ? -1 : 1
        const spacing = 32
        let last: [number, number, number] | null = null
        for (const sm of sampleAlong(pts, spacing, 8 + seed * 10)) {
          const off = halfW + 0.35
          const px = sm.p[0] + sm.t[1] * off * side
          const py = sm.p[1] - sm.t[0] * off * side
          const v = V(px, py, ground(px, py))
          instances.pole.push(v[0], v[1], v[2], Math.atan2(sm.t[0], sm.t[1]), 1, R())
          if (last) {
            for (const [hgt, lat] of [
              [10.6, -0.55],
              [10.6, 0.55],
              [9.9, 0],
              [7.4, 0.25],
              [6.6, 0.25],
            ] as const) {
              const ax = last[0] + sm.t[1] * lat * side
              const az = last[2] - sm.t[0] * lat * side * -1
              const bx = v[0] + sm.t[1] * lat * side
              const bz = v[2] - sm.t[0] * lat * side * -1
              const SEG = 4
              for (let k = 0; k < SEG; k++) {
                const t0 = k / SEG
                const t1 = (k + 1) / SEG
                const sag = (t: number) => 4 * t * (1 - t) * 0.35
                wires.push(
                  ax + (bx - ax) * t0,
                  last[1] + hgt + (v[1] - last[1]) * t0 - sag(t0),
                  az + (bz - az) * t0,
                  ax + (bx - ax) * t1,
                  last[1] + hgt + (v[1] - last[1]) * t1 - sag(t1),
                  az + (bz - az) * t1,
                )
              }
            }
          }
          last = v
        }
      }
      // Vending machines: ~4 million in Japan, roughly one per 30 people.
      if (req.detail >= 1 && spec.cls >= 4 && spec.cls <= 6) {
        for (const sm of sampleAlong(pts, 70, 20 + R() * 40)) {
          if (R() > 0.35 * req.detail + 0.1) continue
          const side = R() < 0.5 ? -1 : 1
          const off = halfW + 0.9
          const px = sm.p[0] + sm.t[1] * off * side
          const py = sm.p[1] - sm.t[0] * off * side
          const v = V(px, py, ground(px, py))
          const yaw = Math.atan2(-sm.t[1] * side, -sm.t[0] * side * -1)
          const count = 1 + Math.floor(R() * 3)
          for (let k = 0; k < count; k++) {
            instances.vending.push(v[0] + sm.t[0] * k * 1.05, v[1], v[2] - sm.t[1] * k * 1.05, yaw, 1, R())
          }
        }
      }
    }
  }
  // Traffic signals at junctions of major roads.
  for (const [k, d] of degree) {
    if (d < 3) continue
    const [ex, ey] = k.split(',').map(Number)
    if (!tl) break
    const p = extentToLocal(tl.extent, ex, ey)
    if (!inTile(p)) continue
    // Only where a tertiary-or-bigger road meets.
    const major = lines.some((L) => (L.keys[0] === k || L.keys[L.keys.length - 1] === k) && ['primary', 'secondary', 'tertiary', 'trunk'].includes(String(L.props.class)))
    if (!major) continue
    const v = V(p[0] + 5, p[1] + 5, ground(p[0] + 5, p[1] + 5) + 0.15)
    instances.signal.push(v[0], v[1], v[2], R() * 6.28, 1, 0)
  }
  stats.roads = lines.length

  // --------------------------------------------------------------- water
  const water = new MeshBuilder(true)
  const wl = tile.layers.water
  if (wl) {
    for (let i = 0; i < wl.length; i++) {
      const f = wl.feature(i)
      const cls = String(f.properties.class)
      if (cls === 'ocean') continue
      for (const poly of classifyRings(f.loadGeometry())) {
        const rings = poly.map((r) => r.map((p) => extentToLocal(wl.extent, p.x, p.y)))
        const outer = rings[0]
        if (!inTile(centroid(outer))) continue
        const hs = outer.map((p) => ground(p[0], p[1]))
        const lo = Math.min(...hs)
        const hi = Math.max(...hs)
        if (hi - lo > 4 && cls === 'river') continue
        const flat: number[] = []
        const holes: number[] = []
        for (const r of rings) {
          if (flat.length) holes.push(flat.length / 2)
          for (const p of r) flat.push(p[0], p[1])
        }
        const tri = earcut(flat, holes)
        const base = water.vertexCount
        for (let k = 0; k < flat.length; k += 2) {
          const v = V(flat[k], flat[k + 1], lo - 0.35)
          water.vertex(v[0], v[1], v[2], 0, 1, 0, flat[k] / 30, flat[k + 1] / 30)
        }
        for (let k = 0; k < tri.length; k += 3) water.triUp(base + tri[k], base + tri[k + 1], base + tri[k + 2])
      }
    }
  }

  // ------------------------------------------------------------- platforms
  // Station platforms (ホーム): raised concrete slabs at the height of the
  // train floor, the yellow tactile line ~80 cm from the edge, and a canopy
  // on columns over the middle. Underground/indoor platforms are skipped.
  if (tl) {
    for (let i = 0; i < tl.length; i++) {
      const f = tl.feature(i)
      if (f.type !== 3 || f.properties.subclass !== 'platform') continue
      const pr = f.properties
      const layer = Number(pr.layer ?? 0)
      if (pr.indoor || Number(pr.level ?? 0) < 0 || layer < 0 || pr.brunnel === 'tunnel') continue
      for (const poly of classifyRings(f.loadGeometry())) {
        const outer = poly[0].map((p) => extentToLocal(tl.extent, p.x, p.y))
        if (outer.length < 3 || !inTile(centroid(outer))) continue
        const area = Math.abs(polygonArea(outer))
        if (area < 20) continue
        const hs = outer.map((p) => ground(p[0], p[1]))
        // ~1.1 m above the rail head, which sits 0.42 m above ground (0.77 m on viaduct decks).
        const top = Math.min(...hs) + 1.1 + (layer >= 1 ? 6.5 * Math.min(layer, 3) + 0.77 : 0.42)
        // Inward offset ring for the tactile border.
        const ccw = polygonArea(outer) > 0
        const inset = 1.2
        const inner: P2[] = outer.map((p, k) => {
          const a = outer[(k - 1 + outer.length) % outer.length]
          const b = outer[(k + 1) % outer.length]
          let e1x = p[0] - a[0], e1y = p[1] - a[1]
          let e2x = b[0] - p[0], e2y = b[1] - p[1]
          const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1
          e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2
          // inward normal of each edge (left of travel for CCW rings)
          const s = ccw ? 1 : -1
          const n1x = -e1y * s, n1y = e1x * s, n2x = -e2y * s, n2y = e2x * s
          let bx = n1x + n2x, by = n1y + n2y
          const bl = Math.hypot(bx, by) || 1
          bx /= bl; by /= bl
          const miter = Math.min(2.5, 1 / Math.max(0.3, bx * n1x + by * n1y))
          return [p[0] + bx * inset * miter, p[1] + by * inset * miter]
        })
        const narrow = Math.abs(polygonArea(inner)) < area * 0.25
        const ring = narrow ? outer : inner
        // Top surface.
        const flat: number[] = []
        for (const p of ring) flat.push(p[0], p[1])
        const tri = earcut(flat)
        const base = sidewalks.vertexCount
        for (const p of ring) {
          const v = V(p[0], p[1], top)
          sidewalks.vertex(v[0], v[1], v[2], 0, 1, 0, 5, 0)
        }
        for (let k = 0; k < tri.length; k += 3) sidewalks.triUp(base + tri[k], base + tri[k + 1], base + tri[k + 2])
        // Tactile border ribbon (u = metres from the edge).
        if (!narrow) {
          for (let k = 0; k < outer.length; k++) {
            const k2 = (k + 1) % outer.length
            const o1 = V(outer[k][0], outer[k][1], top), o2 = V(outer[k2][0], outer[k2][1], top)
            const i1 = V(inner[k][0], inner[k][1], top), i2 = V(inner[k2][0], inner[k2][1], top)
            const a = sidewalks.vertex(o1[0], o1[1], o1[2], 0, 1, 0, 0, 0)
            const b = sidewalks.vertex(o2[0], o2[1], o2[2], 0, 1, 0, 0, 0)
            const c = sidewalks.vertex(i2[0], i2[1], i2[2], 0, 1, 0, inset, 0)
            const d = sidewalks.vertex(i1[0], i1[1], i1[2], 0, 1, 0, inset, 0)
            sidewalks.triUp(a, b, c)
            sidewalks.triUp(a, c, d)
          }
        }
        // Platform walls down to the ground.
        for (let k = 0; k < outer.length; k++) {
          const p = outer[k]
          const q = outer[(k + 1) % outer.length]
          const ex = q[0] - p[0], ey = q[1] - p[1]
          const l = Math.hypot(ex, ey) || 1
          const nx = ey / l, ny = -ex / l
          const g0 = Math.min(ground(p[0], p[1]), ground(q[0], q[1])) - 0.3
          const t1 = V(p[0], p[1], top), t2 = V(q[0], q[1], top)
          const b1 = V(p[0], p[1], g0), b2 = V(q[0], q[1], g0)
          const a = sidewalks.vertex(t1[0], t1[1], t1[2], nx, 0, -ny, -0.15, 0)
          const b = sidewalks.vertex(t2[0], t2[1], t2[2], nx, 0, -ny, -0.15, 0)
          const c = sidewalks.vertex(b2[0], b2[1], b2[2], nx, 0, -ny, -0.15, 0)
          const d = sidewalks.vertex(b1[0], b1[1], b1[2], nx, 0, -ny, -0.15, 0)
          sidewalks.quad(a, b, c, d)
          sidewalks.quad(d, c, b, a)
        }
        // Canopy over long platforms, carried on a row of columns.
        const obb = minAreaRect(outer)
        if (obb.halfLong > 15 && obb.halfShort > 1.6 && obb.halfShort < 9) {
          const roofY = top + 3.3
          const hw = obb.halfShort * 0.92
          const hl = obb.halfLong - 3
          const ux = obb.ax, uy = obb.ay
          const vx = -uy, vy = ux
          const corner = (su: number, sv: number, h: number) => V(obb.cx + ux * hl * su + vx * hw * sv, obb.cy + uy * hl * su + vy * hw * sv, h)
          const box = (pts: Array<[number, number, number]>) => {
            // pts: 8 corners (bottom 4 then top 4, ccw)
            const faces = [[0, 1, 2, 3, 0, -1, 0], [7, 6, 5, 4, 0, 1, 0]]
            for (const [a, b, c, d, nx, ny, nz] of faces) {
              const ia = structures.vertex(...pts[a], nx, ny, nz)
              const ib = structures.vertex(...pts[b], nx, ny, nz)
              const ic = structures.vertex(...pts[c], nx, ny, nz)
              const id2 = structures.vertex(...pts[d], nx, ny, nz)
              structures.quad(ia, ib, ic, id2)
              structures.quad(id2, ic, ib, ia)
            }
            for (let k = 0; k < 4; k++) {
              const k2 = (k + 1) % 4
              const ex = pts[k2][0] - pts[k][0], ez = pts[k2][2] - pts[k][2]
              const el = Math.hypot(ex, ez) || 1
              const nx = ez / el, nz = -ex / el
              const ia = structures.vertex(...pts[k], nx, 0, nz)
              const ib = structures.vertex(...pts[k2], nx, 0, nz)
              const ic = structures.vertex(...pts[k2 + 4], nx, 0, nz)
              const id2 = structures.vertex(...pts[k + 4], nx, 0, nz)
              structures.quad(ia, ib, ic, id2)
              structures.quad(id2, ic, ib, ia)
            }
          }
          box([corner(-1, -1, roofY), corner(1, -1, roofY), corner(1, 1, roofY), corner(-1, 1, roofY), corner(-1, -1, roofY + 0.22), corner(1, -1, roofY + 0.22), corner(1, 1, roofY + 0.22), corner(-1, 1, roofY + 0.22)])
          for (let t = -hl + 4; t <= hl - 4; t += 10) {
            const cxp = obb.cx + ux * t, cyp = obb.cy + uy * t
            const c = (su: number, sv: number, h: number) => V(cxp + ux * 0.15 * su + vx * 0.15 * sv, cyp + uy * 0.15 * su + vy * 0.15 * sv, h)
            box([c(-1, -1, top), c(1, -1, top), c(1, 1, top), c(-1, 1, top), c(-1, -1, roofY), c(1, -1, roofY), c(1, 1, roofY), c(-1, 1, roofY)])
          }
        }
        stats.platforms = (stats.platforms ?? 0) + 1
      }
    }
  }

  // ------------------------------------------------------------- landcover
  const lc = tile.layers.landcover
  const treeBudget = req.detail >= 1 ? 14000 : 0
  let treeCount = instances.tree.length / 6
  // Spread the budget evenly over all woods and parks in the tile (instead of
  // first come, first served): widen the spacing if there is too much forest.
  let wanted = 0
  if (lc && treeBudget) {
    for (let i = 0; i < lc.length; i++) {
      const f = lc.feature(i)
      const cls = String(f.properties.class)
      const sub = String(f.properties.subclass)
      const isWood = cls === 'wood'
      const isPark = cls === 'grass' && (sub === 'park' || sub === 'garden' || sub === 'grass')
      if (!isWood && !isPark) continue
      for (const poly of classifyRings(f.loadGeometry())) {
        const outer = poly[0].map((p) => extentToLocal(lc.extent, p.x, p.y))
        const a = Math.min(Math.abs(polygonArea(outer)), (2 * half) ** 2)
        wanted += a / (isWood ? 81 : 256)
      }
    }
  }
  const spread = Math.max(1, Math.sqrt(wanted / Math.max(1, treeBudget)))
  if (lc) {
    for (let i = 0; i < lc.length; i++) {
      const f = lc.feature(i)
      const cls = String(f.properties.class)
      const sub = String(f.properties.subclass)
      const isWood = cls === 'wood'
      const isPark = cls === 'grass' && (sub === 'park' || sub === 'garden' || sub === 'grass')
      if (!isWood && !isPark) continue
      const spacing = (isWood ? 9 : 16) * spread
      for (const poly of classifyRings(f.loadGeometry())) {
        const rings = poly.map((r) => r.map((p) => extentToLocal(lc.extent, p.x, p.y)))
        const outer = rings[0]
        if (isWood && outer.length >= 3) {
          const wr = rings.map((r) => {
            const a = new Float32Array(r.length * 2)
            r.forEach((p, k) => {
              const v = V(p[0], p[1], 0)
              a[k * 2] = v[0]
              a[k * 2 + 1] = v[2]
            })
            return a
          })
          const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
          for (let k = 0; k < wr[0].length; k += 2) {
            bb[0] = Math.min(bb[0], wr[0][k])
            bb[1] = Math.min(bb[1], wr[0][k + 1])
            bb[2] = Math.max(bb[2], wr[0][k])
            bb[3] = Math.max(bb[3], wr[0][k + 1])
          }
          let cx = 0
          let cy = 0
          for (const p of outer) {
            cx += p[0] / outer.length
            cy += p[1] / outer.length
          }
          woods.push({ rings: wr, bbox: bb, mountain: sub === 'forest' || ground(Math.max(-half, Math.min(half, cx)), Math.max(-half, Math.min(half, cy))) > 150 })
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const p of outer) {
          minX = Math.min(minX, p[0])
          maxX = Math.max(maxX, p[0])
          minY = Math.min(minY, p[1])
          maxY = Math.max(maxY, p[1])
        }
        minX = Math.max(minX, -half)
        minY = Math.max(minY, -half)
        maxX = Math.min(maxX, half)
        maxY = Math.min(maxY, half)
        if (treeCount >= treeBudget) continue
        for (let gx = Math.ceil(minX / spacing) * spacing; gx < maxX; gx += spacing) {
          for (let gy = Math.ceil(minY / spacing) * spacing; gy < maxY; gy += spacing) {
            if (treeCount >= treeBudget) break
            const jx = gx + (hash2(gx, gy) - 0.5) * spacing * 0.9
            const jy = gy + (hash2(gy, gx) - 0.5) * spacing * 0.9
            if (!pointInRing(jx, jy, outer)) continue
            if (rings.slice(1).some((r) => pointInRing(jx, jy, r))) continue
            const gh = ground(jx, jy)
            const v = V(jx, jy, gh)
            const r = hash2(jx * 1.3, jy * 0.7)
            // Type: conifer plantations (sugi/hinoki) dominate Japanese mountain
            // forests; parks mix broadleaf, sakura and pine.
            let type = 0
            if (isWood) type = gh > 150 || sub === 'forest' ? (r < 0.65 ? 1 : r < 0.75 ? 4 : 0) : r < 0.3 ? 1 : r < 0.4 ? 5 : 0
            else type = r < 0.35 ? 2 : r < 0.5 ? 4 : r < 0.6 ? 3 : 0
            instances.tree.push(v[0], v[1], v[2], r * 6.28, 0.75 + hash2(jy, jx * 3) * 0.6, type)
            treeCount++
          }
        }
      }
    }
  }
  stats.trees = treeCount

  // Commercial POIs (shops, restaurants, bars) inform building character.
  const shopGrid = new Map<string, number>()
  const plc0 = tile.layers.poi
  if (plc0) {
    const commercialCls = new Set(['shop', 'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'beer', 'clothing_store', 'grocery', 'alcohol_shop', 'mobile_phone', 'karaoke', 'cinema', 'bank'])
    for (let i = 0; i < plc0.length; i++) {
      const f = plc0.feature(i)
      if (!commercialCls.has(String(f.properties.class))) continue
      const g = f.loadGeometry()[0]?.[0]
      if (!g) continue
      const p = extentToLocal(plc0.extent, g.x, g.y)
      const k = `${Math.floor(p[0] / 20)},${Math.floor(p[1] / 20)}`
      shopGrid.set(k, (shopGrid.get(k) ?? 0) + 1)
    }
  }
  // Shrines and temples: nearby buildings become their halls.
  const worship: Array<{ x: number; y: number; shrine: boolean; vermilion: boolean }> = []
  // Lacquered vermilion (朱塗り) shrines vs. unpainted cypress (白木: Meiji Jingu, Ise, Izumo...).
  const VERMILION = /稲荷|八幡|天満宮|天神|厳島|春日|平安|八坂|日枝|住吉|鶴岡|浅草|北野|生田|熊野|東照宮|氷川|伏見|祇園/
  const PLAIN = /神宮|出雲|大神|靖國|靖国/
  if (plc0) {
    for (let i = 0; i < plc0.length; i++) {
      const f = plc0.feature(i)
      const n = String(f.properties.name ?? '')
      const isPow = f.properties.class === 'place_of_worship'
      const shrineName = /神社|大社|神宮|稲荷|八幡|天満宮|社$|宮$|殿/.test(n)
      const templeName = /寺|院$|堂|観音|不動/.test(n)
      if (!isPow && !shrineName && !templeName) continue
      const g = f.loadGeometry()[0]?.[0]
      if (!g) continue
      const p = extentToLocal(plc0.extent, g.x, g.y)
      const h = Math.abs(Math.sin(n.length * 12.9898 + (n.charCodeAt(0) || 0) * 0.37) * 43758.5453) % 1
      worship.push({ x: p[0], y: p[1], shrine: shrineName && !(templeName && !/神社|神宮|大社/.test(n)), vermilion: VERMILION.test(n) || (!PLAIN.test(n) && h < 0.4) })
    }
  }
  const worshipNear = (x: number, y: number): { shrine: boolean; vermilion: boolean } | null => {
    let best: { shrine: boolean; vermilion: boolean } | null = null
    let bd = 45 * 45
    for (const w of worship) {
      const d = (w.x - x) ** 2 + (w.y - y) ** 2
      if (d < bd) {
        bd = d
        best = w
      }
    }
    return best
  }
  // Historic districts overlapping this tile.
  const zones = HERITAGE.map((z) => ({ ...z, x: (z.lon - anchor.lon) * mLon, y: (z.lat - anchor.lat) * mLat })).filter(
    (z) => Math.abs(z.x) < half + z.radius && Math.abs(z.y) < half + z.radius,
  )
  const styleAt = (x: number, y: number): HeritageStyle | null => {
    for (const z of zones) if ((z.x - x) ** 2 + (z.y - y) ** 2 < z.radius * z.radius) return z.style
    return null
  }

  const shopsNear = (x: number, y: number) => {
    let n = 0
    const cx = Math.floor(x / 20)
    const cy = Math.floor(y / 20)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) n += shopGrid.get(`${cx + dx},${cy + dy}`) ?? 0
    return n
  }

  // ------------------------------------------------------------- buildings
  const cells = new Map<string, { buildings: MeshBuilder; roofs: MeshBuilder }>()
  // Near tiles split into cells (culling, shadows); far ones stay one draw.
  const cell = req.detail >= 1 ? CELL : 1e6
  const cellAt = (x: number, z: number) => {
    const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`
    let c = cells.get(k)
    if (!c) cells.set(k, (c = { buildings: new MeshBuilder(false, { bh: 1, seed: 1, kind: 1, wall: 2 }), roofs: new MeshBuilder(true, { seed: 1 }) }))
    return c
  }
  const bl = tile.layers.building
  let skipped = 0
  if (bl) {
    for (let i = 0; i < bl.length; i++) {
      const f = bl.feature(i)
      if (f.properties.hide_3d) continue
      const height = Number(f.properties.render_height ?? 6)
      const minH = Number(f.properties.render_min_height ?? 0)
      for (const poly of classifyRings(f.loadGeometry())) {
        const rings = poly.map((r) => r.map((p) => extentToLocal(bl.extent, p.x, p.y)))
        const outer = rings[0]
        if (outer.length < 3) continue
        const c = centroid(outer)
        if (!inTile(c)) continue
        const clat = latOf(c[1])
        const clon = lonOf(c[0])
        const area = Math.abs(polygonArea(outer))
        // PLATEAU wins, except for small buildings in historic districts,
        // where we draw the vernacular house (PLATEAU hides its LOD1 box).
        const heritageHouse = area < 700 && height <= 12 && styleAt(c[0], c[1]) !== null
        if (!heritageHouse && req.coverage.some((b) => clon >= b[0] && clon <= b[2] && clat >= b[1] && clat <= b[3])) {
          skipped++
          continue
        }
        if (area < 6) continue
        const { buildings, roofs } = cellAt(c[0], c[1])
        const seed = hash2(Math.round(c[0] * 10), Math.round(c[1] * 10))
        const gs = outer.map((p) => ground(p[0], p[1]))
        const gmin = Math.min(...gs)
        const gmax = Math.max(...gs)
        let kind = 0
        // OSM in Japan: untagged heights default to ~5 m; most are houses.
        const shops = shopsNear(c[0], c[1])
        if (area < 220 && height <= 10) kind = shops >= 3 && height > 7 ? 7 : 1
        else if (area > 2500 && height < 16) kind = shops >= 2 ? 7 : 4
        else if (height > 70) kind = seed > 0.35 ? 3 : 2
        else if (shops >= 2) kind = 7
        else if (height >= 9 && height < 50 && seed < 0.6) kind = 6
        else kind = 2
        // Vernacular architecture: historic districts, shrine and temple halls.
        const style = area < 700 && height <= 12 ? styleAt(c[0], c[1]) : null
        const pow = area < 2500 && height <= 20 ? worshipNear(c[0], c[1]) : null
        let roofStyle = 0 // 0 by seed, 2 thatch, 4 kawara, 6 red Ryukyu tile, 8 shrine copper/bark
        let hip: boolean | undefined
        let pitch = 0.42 + seed * 0.15
        let over = 0.45
        let lowWalls = 0
        if (pow) {
          kind = pow.shrine ? (pow.vermilion ? 10 : 12) : 5
          roofStyle = pow.shrine ? 8 : 4
          hip = !pow.shrine
          pitch = pow.shrine ? 0.6 : 0.72
          over = 1.1
        } else if (style === 'machiya') {
          kind = 8
          roofStyle = 4
          hip = false
          pitch = 0.5
          over = 0.75
        } else if (style === 'gassho' || style === 'kayabuki') {
          kind = 9
          roofStyle = 2
          hip = style === 'kayabuki'
          pitch = style === 'gassho' ? 1.75 : 1.2
          over = 1.0
          lowWalls = 2.7
        } else if (style === 'ryukyu') {
          kind = 11
          roofStyle = 6
          hip = true
          pitch = 0.45
          over = 0.7
          lowWalls = 2.8
        }
        const vernacular = kind >= 8 || kind === 5
        let wallTop = gmax + (lowWalls || Math.max(height, kind === 1 || kind === 8 ? 6.2 : 3))
        const base = gmin - 1.2 + minH
        const obb = kind === 1 || vernacular ? minAreaRect(outer) : null
        const pitched = !!obb && area / obb.area > (vernacular ? 0.66 : 0.74) && obb.halfShort < (vernacular ? 14 : 9) && obb.halfShort > 1.5
        let roofH = 0
        if (pitched) {
          roofH = obb!.halfShort * pitch
          if (!lowWalls) wallTop -= roofH * 0.35
        }
        // Walls
        for (const ring of rings) {
          for (let k = 0; k < ring.length; k++) {
            const a = ring[k]
            const b = ring[(k + 1) % ring.length]
            const dx = b[0] - a[0]
            const dy = b[1] - a[1]
            const len = Math.hypot(dx, dy)
            if (len < 0.05) continue
            const nx = dy / len
            const ny = -dx / len
            const a0 = V(a[0], a[1], base)
            const a1 = V(a[0], a[1], wallTop)
            const b0 = V(b[0], b[1], base)
            const b1 = V(b[0], b[1], wallTop)
            const ga = ground(a[0], a[1])
            const gb = ground(b[0], b[1])
            // wall = (metres along this wall, its length): windows fit each
            // wall exactly instead of being cut at the corners.
            const v0 = buildings.vertex(a0[0], a0[1], a0[2], nx, 0, -ny, 0, 0, base - ga, seed, kind, 0, len)
            const v1 = buildings.vertex(b0[0], b0[1], b0[2], nx, 0, -ny, 0, 0, base - gb, seed, kind, len, len)
            const v2 = buildings.vertex(b1[0], b1[1], b1[2], nx, 0, -ny, 0, 0, wallTop - gb, seed, kind, len, len)
            const v3 = buildings.vertex(a1[0], a1[1], a1[2], nx, 0, -ny, 0, 0, wallTop - ga, seed, kind, 0, len)
            buildings.quad(v0, v1, v2, v3)
          }
        }
        if (pitched) {
          addHouseRoof(roofs, buildings, obb!, wallTop, roofH, seed, V, kind, hip, over, roofStyle)
        } else {
          // Flat roof
          const flat: number[] = []
          const holes: number[] = []
          for (const r of rings) {
            if (flat.length) holes.push(flat.length / 2)
            for (const p of r) flat.push(p[0], p[1])
          }
          const tri = earcut(flat, holes)
          const b0 = buildings.vertexCount
          for (let k = 0; k < flat.length; k += 2) {
            const v = V(flat[k], flat[k + 1], wallTop)
            buildings.vertex(v[0], v[1], v[2], 0, 1, 0, 0, 0, wallTop - gmin, seed, kind)
          }
          for (let k = 0; k < tri.length; k += 3) buildings.triUp(b0 + tri[k], b0 + tri[k + 1], b0 + tri[k + 2])
          if (!vernacular) rooftop(buildings, outer, wallTop, wallTop - gmin, area, kind, seed)
        }
        // TV aerials: still on most Japanese house roofs.
        if (pitched && kind === 1 && seed < 0.45) {
          const v = V(obb!.cx + obb!.ax * obb!.halfLong * 0.4, obb!.cy + obb!.ay * obb!.halfLong * 0.4, wallTop + roofH * 0.95)
          instances.antenna.push(v[0], v[1], v[2], Math.atan2(obb!.ax, obb!.ay) + seed * 2, 0.9 + seed * 0.4, 0)
        }
      }
    }
  }

  /**
   * What sits on a Japanese flat roof: a parapet, the stair/elevator house
   * (塔屋), rows of air-conditioner outdoor units and, on apartment blocks, a
   * water tank. These break the flat-box silhouette more than anything else.
   */
  function rooftop(b: MeshBuilder, ring: P2[], top: number, tall: number, area: number, kind: number, seed: number): void {
    if (tall < 5 || area < 40) return
    // Parapet: 0.6-1.1 m, both faces (seen from neighbouring roofs).
    const ph = 0.6 + seed * 0.5
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k]
      const c = ring[(k + 1) % ring.length]
      const dx = c[0] - a[0]
      const dy = c[1] - a[1]
      const len = Math.hypot(dx, dy)
      if (len < 0.05) continue
      const nx = dy / len
      const ny = -dx / len
      const A0 = V(a[0], a[1], top)
      const A1 = V(a[0], a[1], top + ph)
      const C0 = V(c[0], c[1], top)
      const C1 = V(c[0], c[1], top + ph)
      for (const side of [1, -1]) {
        const q = [A0, C0, C1, A1].map((P, i) => b.vertex(P[0], P[1], P[2], nx * side, 0, -ny * side, 0, 0, i < 2 ? tall : tall + ph, seed, kind + 20, i === 1 || i === 2 ? len : 0, len))
        if (side === 1) b.quad(q[0], q[1], q[2], q[3])
        else b.quad(q[0], q[3], q[2], q[1])
      }
    }
    const obb = minAreaRect(ring)
    const inside = (x: number, y: number) => pointInRing(x, y, ring)
    const pick = (margin: number): [number, number] | null => {
      for (let t = 0; t < 8; t++) {
        const u = (R() * 2 - 1) * Math.max(0, obb.halfLong - margin)
        const w = (R() * 2 - 1) * Math.max(0, obb.halfShort - margin)
        const x = obb.cx + obb.ax * u - obb.ay * w
        const y = obb.cy + obb.ay * u + obb.ax * w
        if (inside(x, y)) return [x, y]
      }
      return null
    }
    const yaw = Math.atan2(obb.ax, obb.ay)
    // Stair house on anything with a lift or a staircase to the roof.
    if (tall > 11 && area > 120 && obb.halfShort > 3) {
      const p = pick(3)
      if (p) box(b, p[0], p[1], obb.ax, obb.ay, 1.8, 1.4, top, 2.7, seed, kind + 20)
    }
    // AC outdoor units in rows (offices and shops have many).
    const units = Math.min(14, Math.round(area / (kind === 7 || kind === 2 ? 70 : 140)))
    for (let i = 0; i < units; i++) {
      const p = pick(1.2)
      if (!p) continue
      const v = V(p[0], p[1], top)
      instances.ac.push(v[0], v[1], v[2], yaw + (R() < 0.5 ? 0 : Math.PI), 0.9 + R() * 0.3, 0)
    }
    if ((kind === 6 || (tall > 14 && seed > 0.55)) && area > 150) {
      const p = pick(2.5)
      if (p) {
        const v = V(p[0], p[1], top)
        instances.tank.push(v[0], v[1], v[2], yaw, 0.85 + seed * 0.5, 0)
      }
    }
  }

  /** Closed box (walls + lid) in the building mesh, axis (ax, ay) along x. */
  function box(b: MeshBuilder, cx: number, cy: number, ax: number, ay: number, hx: number, hy: number, z0: number, h: number, seed: number, kind: number): void {
    const c = [
      [cx - ax * hx + ay * hy, cy - ay * hx - ax * hy],
      [cx + ax * hx + ay * hy, cy + ay * hx - ax * hy],
      [cx + ax * hx - ay * hy, cy + ay * hx + ax * hy],
      [cx - ax * hx - ay * hy, cy - ay * hx + ax * hy],
    ] as P2[]
    if (polygonArea(c) < 0) c.reverse()
    for (let k = 0; k < 4; k++) {
      const a = c[k]
      const d = c[(k + 1) % 4]
      const len = Math.hypot(d[0] - a[0], d[1] - a[1])
      const nx = (d[1] - a[1]) / len
      const ny = -(d[0] - a[0]) / len
      const q = [V(a[0], a[1], z0), V(d[0], d[1], z0), V(d[0], d[1], z0 + h), V(a[0], a[1], z0 + h)].map((P, i) => b.vertex(P[0], P[1], P[2], nx, 0, -ny, 0, 0, i < 2 ? 0 : h, seed, kind, i === 1 || i === 2 ? len : 0, len))
      b.quad(q[0], q[1], q[2], q[3])
    }
    const t = c.map((p) => V(p[0], p[1], z0 + h)).map((P) => b.vertex(P[0], P[1], P[2], 0, 1, 0, 0, 0, h, seed, kind, 0, 0))
    b.quadUp(t[0], t[1], t[2], t[3])
  }
  stats.osmBuildings = bl ? bl.length - skipped : 0
  stats.skippedForPlateau = skipped

  // ------------------------------------------------------------------ POIs
  const pl = tile.layers.poi
  if (pl) {
    for (let i = 0; i < pl.length; i++) {
      const f = pl.feature(i)
      const g = f.loadGeometry()[0]?.[0]
      if (!g) continue
      const p = extentToLocal(pl.extent, g.x, g.y)
      if (!inTile(p)) continue
      const props = f.properties
      const v = V(p[0], p[1], ground(p[0], p[1]))
      pois.push({
        name: String(props.name ?? ''),
        nameEn: String(props['name:en'] ?? props.name_en ?? props['name:latin'] ?? ''),
        cls: String(props.class ?? ''),
        sub: String(props.subclass ?? ''),
        lat: latOf(p[1]),
        lon: lonOf(p[0]),
        x: v[0],
        y: v[1],
        z: v[2],
      })
      if (props.class === 'shop' && props.subclass === 'convenience') {
        const vv = V(p[0] + 3, p[1], ground(p[0] + 3, p[1]))
        instances.vending.push(vv[0], vv[1], vv[2], R() * 6.28, 1, R())
      }
    }
  }

  // Airports (the label sits on the airfield): somewhere to catch a flight.
  const al = tile.layers.aerodrome_label
  if (al) {
    for (let i = 0; i < al.length; i++) {
      const f = al.feature(i)
      const g = f.loadGeometry()[0]?.[0]
      if (!g) continue
      const p = extentToLocal(al.extent, g.x, g.y)
      if (!inTile(p)) continue
      const pr = f.properties
      const v = V(p[0], p[1], ground(p[0], p[1]))
      pois.push({ name: String(pr['name:ja'] ?? pr.name ?? ''), nameEn: String(pr['name:en'] ?? pr.name_en ?? ''), cls: 'aerodrome', sub: String(pr.iata ?? ''), lat: latOf(p[1]), lon: lonOf(p[0]), x: v[0], y: v[1], z: v[2] })
    }
  }

  // ---------------------------------------------------------------- places
  const places: Place[] = []
  const plc = tile.layers.place
  if (plc) {
    for (let i = 0; i < plc.length; i++) {
      const f = plc.feature(i)
      const g = f.loadGeometry()[0]?.[0]
      if (!g) continue
      const p = extentToLocal(plc.extent, g.x, g.y)
      if (!inTile(p)) continue
      const pr = f.properties
      places.push({
        name: String(pr.name ?? ''),
        reading: String(pr['name:ja-Hira'] ?? pr['name:ja_kana'] ?? ''),
        romaji: String(pr['name:ja-Latn'] ?? pr['name:ja_rm'] ?? pr['name:latin'] ?? pr.name_en ?? ''),
        nameEn: String(pr['name:en'] ?? pr.name_en ?? ''),
        cls: String(pr.class ?? ''),
        rank: Number(pr.rank ?? 99),
        lat: latOf(p[1]),
        lon: lonOf(p[0]),
      })
    }
  }

  const inst: Record<string, Float32Array> = {}
  for (const [k, v] of Object.entries(instances)) inst[k] = new Float32Array(v)
  return {
    id,
    anchor,
    buildings: [...cells.values()].filter((c) => !c.buildings.empty).map((c) => c.buildings.build()),
    roofs: [...cells.values()].filter((c) => !c.roofs.empty).map((c) => c.roofs.build()),
    roads: roads.empty ? null : roads.build(),
    sidewalks: sidewalks.empty ? null : sidewalks.build(),
    ballast: ballast.empty ? null : ballast.build(),
    rails: rails.empty ? null : rails.build(),
    structures: structures.empty ? null : structures.build(),
    water: water.empty ? null : water.build(),
    instances: inst,
    wires: new Float32Array(wires),
    pois,
    places,
    paths,
    woods,
    stats,
  }
}

/** Group vector-tile rings into polygons (outer ring + holes). */
function classifyRings(rings: Array<Array<{ x: number; y: number }>>): Array<Array<Array<{ x: number; y: number }>>> {
  const out: Array<Array<Array<{ x: number; y: number }>>> = []
  let cur: Array<Array<{ x: number; y: number }>> | null = null
  for (const r of rings) {
    if (r.length < 3) continue
    let a = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[i].x - r[j].x) * (r[i].y + r[j].y)
    if (a === 0) continue
    // Spec: exterior rings are clockwise in tile space (y down).
    const outer = a < 0
    if (outer || !cur) {
      // A polygon that opens with a hole-wound ring (invalid, but it happens
      // in generalised tiles) would get inward-facing walls: invisible from
      // the street, with the roof seemingly floating. Re-wind it.
      cur = [outer ? r : [...r].reverse()]
      out.push(cur)
    } else cur.push(r)
  }
  // Drop the closing duplicate point.
  for (const poly of out)
    for (const r of poly) {
      const f = r[0]
      const l = r[r.length - 1]
      if (r.length > 1 && f.x === l.x && f.y === l.y) r.pop()
    }
  return out
}

type VFn = (x: number, n: number, h: number) => [number, number, number]

/** Hipped (寄棟) or gabled (切妻) roof on the oriented bounding box. */
function addHouseRoof(
  roofs: MeshBuilder,
  walls: MeshBuilder,
  obb: ReturnType<typeof minAreaRect>,
  eave: number,
  roofH: number,
  seed: number,
  V: VFn,
  kind: number,
  hipRoof?: boolean,
  over = 0.45,
  roofStyle = 0,
): void {
  const L = obb.halfLong + over
  const S = obb.halfShort + over
  const ax = obb.ax
  const ay = obb.ay
  const bx = -ay
  const by = ax
  const P = (u: number, v: number, h: number) => V(obb.cx + ax * u + bx * v, obb.cy + ay * u + by * v, h)
  const hip = hipRoof ?? seed > 0.45
  const ridge = hip ? Math.max(0, L - S) : L
  const top = eave + roofH
  const eaveH = eave - over * (roofH / S)
  const face = (pts: Array<[number, number, number]>, uvs: Array<[number, number]>) => {
    const ab = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]]
    const ac = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]]
    let nx = ab[1] * ac[2] - ab[2] * ac[1]
    let ny = ab[2] * ac[0] - ab[0] * ac[2]
    let nz = ab[0] * ac[1] - ab[1] * ac[0]
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
      pts.reverse()
      uvs.reverse()
    }
    const idx = pts.map((p, i) => roofs.vertex(p[0], p[1], p[2], nx, ny, nz, uvs[i][0], uvs[i][1], seed + roofStyle))
    for (let i = 1; i < idx.length - 1; i++) roofs.tri(idx[0], idx[i], idx[i + 1])
  }
  const slope = Math.hypot(S, roofH)
  // Long sides
  for (const s of [-1, 1]) {
    face(
      [P(-L, s * S, eaveH), P(L, s * S, eaveH), P(ridge, 0, top), P(-ridge, 0, top)],
      [
        [-L, 0],
        [L, 0],
        [ridge, slope],
        [-ridge, slope],
      ],
    )
  }
  if (hip) {
    for (const s of [-1, 1]) face([P(s * L, -S, eaveH), P(s * L, S, eaveH), P(s * ridge, 0, top)], [
      [-S, 0],
      [S, 0],
      [0, Math.hypot(L - ridge, roofH)],
    ])
  } else {
    // Gable end walls (wall material).
    for (const s of [-1, 1]) {
      const a = P(s * obb.halfLong, -obb.halfShort, eave)
      const b = P(s * obb.halfLong, obb.halfShort, eave)
      const c = P(s * obb.halfLong, 0, top - over * (roofH / S))
      const nx = ax * s
      const nz = -ay * s
      const i0 = walls.vertex(a[0], a[1], a[2], nx, 0, nz, 0, 0, 6, seed, kind)
      const i1 = walls.vertex(b[0], b[1], b[2], nx, 0, nz, 0, 0, 6, seed, kind)
      const i2 = walls.vertex(c[0], c[1], c[2], nx, 0, nz, 0, 0, 6 + roofH, seed, kind)
      // Two-sided: cheap and immune to footprint winding.
      walls.tri(i0, i1, i2)
      walls.tri(i1, i0, i2)
    }
  }
}
