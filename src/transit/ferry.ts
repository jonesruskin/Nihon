// Ferries (フェリー・連絡船・高速船): Japan is 14,000 islands, and boats are
// how you reach Miyajima, Naoshima, Sado or the Okinawan islands. Routes come
// from OpenStreetMap's ferry lines in the OpenFreeMap tiles, traced at
// runtime from the terminal you are standing at to the far port: lines are
// clipped to each z11 tile so the pieces meet exactly at tile edges, and the
// trace stops at the first real port (where several routes meet).
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { lonLatToTileXY, tileXToLon, tileYToLat } from '../core/tiles'

export type LL = [number, number] // [lat, lon]

export interface FerryRoute {
  pts: LL[]
  km: number
  name: string
  nameEn: string
}

const Z = 11
const NAME_Z = 13

export const DEFAULT_TILES = (z: number, x: number, y: number) => `https://tiles.openfreemap.org/planet/20261011_080001_pt/${z}/${x}/${y}.pbf`

export function distM(a: LL, b: LL): number {
  const k = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180))
  return Math.hypot((a[0] - b[0]) * 111132, (a[1] - b[1]) * 111412 * k)
}

export function routeKm(pts: LL[]): number {
  let m = 0
  for (let i = 1; i < pts.length; i++) m += distM(pts[i - 1], pts[i])
  return m / 1000
}

/** Fares: about ¥150 plus ¥15 a km (2nd class / passenger), in ¥10 steps. */
export function ferryFare(km: number): number {
  return Math.max(180, Math.round((150 + km * 15) / 10) * 10)
}

/** Cruising speed (m/s): harbour shuttles, island ferries, long-distance car ferries. */
export function ferrySpeed(km: number): number {
  return km < 4 ? 5 : km < 40 ? 8.5 : 10.5
}

export class FerryTracer {
  private tiles = new Map<string, Promise<LL[][]>>()
  private water = new Map<string, LL[][]>()
  private names = new Map<string, Promise<Array<{ name: string; nameEn: string; pts: LL[] }>>>()
  fetched = 0

  constructor(private url = DEFAULT_TILES) {}

  /** Routes leaving from a terminal (or a pier) at this point. */
  async departures(lat: number, lon: number, maxTiles = 140): Promise<FerryRoute[]> {
    const start: LL = [lat, lon]
    const near = await this.linesNear(start, 900)
    const out: FerryRoute[] = []
    for (const line of near) {
      const d0 = distM(start, line[0])
      const d1 = distM(start, line[line.length - 1])
      if (Math.min(d0, d1) > 900) continue
      const path = d0 <= d1 ? [...line] : [...line].reverse()
      const used = new Set<LL[]>([line])
      const budget = this.fetched + maxTiles
      for (;;) {
        if (this.fetched > budget) break
        const next = await this.continuation(path, used)
        if (!next) break
        used.add(next.line)
        path.push(...next.pts.slice(1))
      }
      const km = routeKm(path)
      if (km < 0.3) continue
      const far = path[path.length - 1]
      // The same route reached twice (merged parts): keep one.
      if (out.some((r) => distM(r.pts[r.pts.length - 1], far) < 400)) continue
      out.push({ pts: path, km, name: '', nameEn: '' })
    }
    for (const r of out) {
      const n = await this.nameFor(r.pts).catch(() => null)
      if (n) {
        r.name = n.name
        r.nameEn = n.nameEn
      }
    }
    return out.sort((a, b) => a.km - b.km)
  }

  /** The line continuing the path: across a tile edge, or through a simple joint. */
  private async continuation(path: LL[], used: Set<LL[]>): Promise<{ line: LL[]; pts: LL[] } | null> {
    const end = path[path.length - 1]
    const prev = path[Math.max(0, path.length - 2)]
    const lines = await this.linesNear(end, 60)
    const ends: Array<{ line: LL[]; rev: boolean; d: number }> = []
    for (const l of lines) {
      if (used.has(l)) continue
      const d0 = distM(end, l[0])
      const d1 = distM(end, l[l.length - 1])
      if (d0 < 40) ends.push({ line: l, rev: false, d: d0 })
      else if (d1 < 40) ends.push({ line: l, rev: true, d: d1 })
    }
    if (!ends.length) return null
    const k = Math.cos((end[0] * Math.PI) / 180)
    const a = Math.atan2((end[1] - prev[1]) * k, end[0] - prev[0])
    const turnOf = (e: (typeof ends)[number]) => {
      const pts = e.rev ? [...e.line].reverse() : e.line
      const q = pts[Math.min(1, pts.length - 1)]
      let t = Math.abs(a - Math.atan2((q[1] - pts[0][1]) * k, q[0] - pts[0][0]))
      if (t > Math.PI) t = Math.PI * 2 - t
      return t
    }
    // One way on: follow it unless it doubles back (another route leaving the
    // same pier). Several: a port where routes meet - unless one carries
    // straight on (routes sharing a sea lane), which we follow.
    const best = ends.map((e) => ({ e, t: turnOf(e) })).sort((x, y) => x.t - y.t)[0]
    // Pieces of one line meet at tile seams; anywhere else, a joint close to
    // land is a port of call - the end of this crossing.
    const t = lonLatToTileXY(end[1], end[0], Z)
    const fx = t.x - Math.floor(t.x)
    const fy = t.y - Math.floor(t.y)
    const seam = Math.min(fx, 1 - fx, fy, 1 - fy) < 2e-4
    if (ends.length > 1 && best.t > 0.5) return null
    if (!seam && (await this.nearLand(end))) return null
    if (path.length > 1 && best.t > Math.PI * 0.6) return null
    return { line: best.e.line, pts: best.e.rev ? [...best.e.line].reverse() : best.e.line }
  }

  /** Land within ~250 m (so a junction here is a port, not a shared sea lane)? */
  private async nearLand(p: LL): Promise<boolean> {
    const dLat = 250 / 111132
    const dLon = 250 / (111412 * Math.cos((p[0] * Math.PI) / 180))
    for (const q of [p, [p[0] + dLat, p[1]], [p[0] - dLat, p[1]], [p[0], p[1] + dLon], [p[0], p[1] - dLon]] as LL[]) {
      const t = lonLatToTileXY(q[1], q[0], Z)
      const tx = Math.floor(t.x)
      const ty = Math.floor(t.y)
      await this.tile(tx, ty)
      const rings = this.water.get(`${tx},${ty}`) ?? []
      let inside = false
      for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          if (r[i][0] > q[0] !== r[j][0] > q[0] && q[1] < ((r[j][1] - r[i][1]) * (q[0] - r[i][0])) / (r[j][0] - r[i][0]) + r[i][1]) inside = !inside
        }
      }
      if (!inside) return true
    }
    return false
  }

  /** Ferry lines in the tiles within r metres of a point. */
  private async linesNear(p: LL, r: number): Promise<LL[][]> {
    const dLat = r / 111132
    const dLon = r / (111412 * Math.cos((p[0] * Math.PI) / 180))
    const keys = new Set<string>()
    for (const [la, lo] of [
      [p[0], p[1]],
      [p[0] + dLat, p[1] + dLon],
      [p[0] + dLat, p[1] - dLon],
      [p[0] - dLat, p[1] + dLon],
      [p[0] - dLat, p[1] - dLon],
    ]) {
      const t = lonLatToTileXY(lo, la, Z)
      keys.add(`${Math.floor(t.x)},${Math.floor(t.y)}`)
    }
    const all = await Promise.all([...keys].map((k) => this.tile(Number(k.split(',')[0]), Number(k.split(',')[1]))))
    return all.flat()
  }

  private tile(x: number, y: number): Promise<LL[][]> {
    const k = `${x},${y}`
    let p = this.tiles.get(k)
    if (!p) {
      this.fetched++
      p = this.load(Z, x, y).then((t) => {
        const w = t?.layers.water
        const rings: LL[][] = []
        if (w) {
          for (let i = 0; i < w.length; i++) {
            const f = w.feature(i)
            if (f.type !== 3) continue
            for (const r of f.loadGeometry()) rings.push(r.map((q) => [tileYToLat(y + q.y / w.extent, Z), tileXToLon(x + q.x / w.extent, Z)] as LL))
          }
        }
        this.water.set(k, rings)
        const l = t?.layers.transportation
        const out: LL[][] = []
        if (!l) return out
        for (let i = 0; i < l.length; i++) {
          const f = l.feature(i)
          if (f.properties.class !== 'ferry') continue
          for (const g of f.loadGeometry()) for (const part of clip(g, l.extent)) out.push(part.map(([px, py]) => [tileYToLat(y + py / l.extent, Z), tileXToLon(x + px / l.extent, Z)] as LL))
        }
        return out
      })
      this.tiles.set(k, p)
    }
    return p
  }

  /** The OSM name of the route (e.g. JR宮島連絡船), from a detailed tile near the start. */
  private async nameFor(pts: LL[]): Promise<{ name: string; nameEn: string } | null> {
    // A point a little way out from the pier.
    let acc = 0
    let probe = pts[pts.length - 1]
    for (let i = 1; i < pts.length; i++) {
      acc += distM(pts[i - 1], pts[i])
      if (acc > 350) {
        probe = pts[i]
        break
      }
    }
    const t = lonLatToTileXY(probe[1], probe[0], NAME_Z)
    const x = Math.floor(t.x)
    const y = Math.floor(t.y)
    const k = `${x},${y}`
    let p = this.names.get(k)
    if (!p) {
      p = this.load(NAME_Z, x, y).then((vt) => {
        const l = vt?.layers.transportation_name
        const out: Array<{ name: string; nameEn: string; pts: LL[] }> = []
        if (!l) return out
        for (let i = 0; i < l.length; i++) {
          const f = l.feature(i)
          if (f.properties.class !== 'ferry') continue
          const pr = f.properties
          const pts: LL[] = f.loadGeometry().flat().map((q) => [tileYToLat(y + q.y / l.extent, NAME_Z), tileXToLon(x + q.x / l.extent, NAME_Z)])
          out.push({ name: String(pr['name:ja'] ?? pr.name ?? ''), nameEn: String(pr['name:en'] ?? pr.name_en ?? pr['name:latin'] ?? ''), pts })
        }
        return out
      })
      this.names.set(k, p)
    }
    let best: { name: string; nameEn: string } | null = null
    let bd = 250
    for (const n of await p) {
      for (const q of n.pts) {
        const d = distM(q, probe)
        if (d < bd) {
          bd = d
          best = n
        }
      }
    }
    return best
  }

  private async load(z: number, x: number, y: number): Promise<VectorTile | null> {
    try {
      const res = await fetch(this.url(z, x, y))
      if (!res.ok) return null
      return new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())))
    } catch {
      return null
    }
  }
}

/** Clip a polyline (tile extent coordinates) to the tile square. */
export function clip(g: Array<{ x: number; y: number }>, ext: number): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = []
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.x <= ext && p.y >= 0 && p.y <= ext
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1]
    const b = g[i]
    // Liang-Barsky
    let t0 = 0
    let t1 = 1
    const dx = b.x - a.x
    const dy = b.y - a.y
    let ok = true
    for (const [p, q] of [
      [-dx, a.x],
      [dx, ext - a.x],
      [-dy, a.y],
      [dy, ext - a.y],
    ]) {
      if (p === 0) {
        if (q < 0) ok = false
      } else {
        const t = q / p
        if (p < 0) t0 = Math.max(t0, t)
        else t1 = Math.min(t1, t)
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) out.push(cur)
      cur = []
      continue
    }
    const pa: [number, number] = [a.x + dx * t0, a.y + dy * t0]
    const pb: [number, number] = [a.x + dx * t1, a.y + dy * t1]
    if (!cur.length || t0 > 0) {
      if (cur.length > 1) out.push(cur)
      cur = [pa]
    }
    cur.push(pb)
    if (t1 < 1 || !inside(b)) {
      if (cur.length > 1) out.push(cur)
      cur = []
    }
  }
  if (cur.length > 1) out.push(cur)
  return out
}
