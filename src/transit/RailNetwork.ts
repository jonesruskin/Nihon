// Japan's whole railway network (MLIT 国土数値情報 N02, baked by
// scripts/bake-rail.py): ~600 lines, ~10,000 stations, every link along the
// real track geometry. Provides station lookup, route planning with
// transfers, travel times from simple running physics, and real-world fares.
import { haversine } from '../core/geo'

export type LineKind = 'shinkansen' | 'jr' | 'metro' | 'private' | 'tram' | 'monorail' | 'agt' | 'cable'

export interface Line {
  id: number
  ja: string
  en: string
  operator: string
  kind: LineKind
  color: string
}

export interface Station {
  id: number
  ja: string
  kana: string
  en: string
  line: number
  group: number
  lat: number
  lon: number
  riders: number // daily passengers (MLIT S12)
  links: number[]
}

export interface Link {
  id: number
  a: number
  b: number
  line: number
  length: number
  path: number
}

export interface Leg {
  line: Line
  stations: number[] // station ids in travel order (first = board, last = alight)
  links: number[] // link ids in travel order
  length: number
  time: number // seconds incl. dwell
  fare: number
}

export interface Route {
  legs: Leg[]
  time: number
  fare: number
  transfers: number
}

/** Typical top running speed (m/s), acceleration and braking (m/s²), dwell (s). */
export const RUNNING: Record<LineKind, { vmax: number; acc: number; dec: number; dwell: number; cars: number; carLen: number }> = {
  shinkansen: { vmax: 250 / 3.6, acc: 0.72, dec: 0.75, dwell: 60, cars: 16, carLen: 25 },
  jr: { vmax: 100 / 3.6, acc: 0.9, dec: 1.0, dwell: 30, cars: 10, carLen: 20 },
  private: { vmax: 95 / 3.6, acc: 0.9, dec: 1.0, dwell: 30, cars: 8, carLen: 20 },
  metro: { vmax: 62 / 3.6, acc: 0.92, dec: 1.0, dwell: 30, cars: 8, carLen: 20 },
  monorail: { vmax: 65 / 3.6, acc: 0.9, dec: 1.0, dwell: 25, cars: 6, carLen: 15 },
  agt: { vmax: 55 / 3.6, acc: 0.9, dec: 1.0, dwell: 25, cars: 6, carLen: 9 },
  tram: { vmax: 35 / 3.6, acc: 0.9, dec: 1.1, dwell: 20, cars: 1, carLen: 15 },
  cable: { vmax: 15 / 3.6, acc: 0.3, dec: 0.3, dwell: 60, cars: 1, carLen: 14 },
}

/** Time over a link: full stop-to-stop profile, or cruising through a station the train passes. */
export function linkTime(kind: LineKind, d: number, stops: boolean): number {
  return stops ? runTime(kind, d) + RUNNING[kind].dwell : d / RUNNING[kind].vmax
}

/** Running time between two stops: accelerate, cruise, brake. */
export function runTime(kind: LineKind, d: number): number {
  const r = RUNNING[kind]
  const dAcc = (r.vmax * r.vmax) / (2 * r.acc)
  const dDec = (r.vmax * r.vmax) / (2 * r.dec)
  if (d >= dAcc + dDec) return r.vmax / r.acc + r.vmax / r.dec + (d - dAcc - dDec) / r.vmax
  // Never reaches top speed: triangular profile.
  const v = Math.sqrt((2 * d * r.acc * r.dec) / (r.acc + r.dec))
  return v / r.acc + v / r.dec
}

// Nozomi / Hayabusa-class stops: tourists ride the fast trains.
const SHINKANSEN_STOPS = new Set([
  '東京', '品川', '新横浜', '名古屋', '京都', '新大阪', '新神戸', '岡山', '広島', '小倉', '博多', // Tokaido / Sanyo Nozomi
  '熊本', '鹿児島中央', '上野', '大宮', '仙台', '盛岡', '新青森', '新函館北斗', '高崎', '長野', '富山', '金沢', '福井', '敦賀', '越後湯沢', '新潟', // Hayabusa, Kagayaki, Toki
  '武雄温泉', '長崎', '新鳥栖', '福島', '山形', '秋田',
])

const JR_FARE_STEPS: [number, number][] = [
  [3, 150], [6, 190], [10, 200], [15, 240], [20, 330], [25, 420], [30, 510], [35, 590], [40, 680], [45, 770],
  [50, 860], [60, 990], [70, 1170], [80, 1340], [90, 1520], [100, 1690], [120, 1980], [140, 2310], [160, 2640],
  [180, 3080], [200, 3410], [220, 3740], [240, 4070], [260, 4510], [280, 4840], [300, 5170],
]
const METRO_FARE: [number, number][] = [[6, 180], [11, 210], [19, 260], [27, 300], [999, 330]]

/** Approximate 2024 adult fares (yen) per operator family. */
export function fareFor(kind: LineKind, km: number, operator: string): number {
  const k = Math.max(1, Math.ceil(km))
  const jr = (km: number) => {
    for (const [lim, f] of JR_FARE_STEPS) if (km <= lim) return f
    return Math.round((5170 + (km - 300) * 12.85) / 10) * 10
  }
  switch (kind) {
    case 'shinkansen':
      // Base fare + reserved-seat limited-express surcharge (Tokyo-Shin-Osaka ¥14,720).
      return jr(k) + Math.round((870 + 9 * Math.min(k, 1200)) / 10) * 10
    case 'jr':
      return jr(k)
    case 'metro': {
      const scale = operator === '東京都' ? 1.15 : operator === '東京地下鉄' ? 1 : 1.12
      for (const [lim, f] of METRO_FARE) if (k <= lim) return Math.round((f * scale) / 10) * 10
      return 330
    }
    case 'tram':
      return operator === '東京都' ? 170 : 200
    case 'cable':
      return 600
    case 'monorail':
    case 'agt':
      return Math.round((180 + 22 * k) / 10) * 10
    default:
      return Math.round((130 + 9.5 * k) / 10) * 10
  }
}

export class RailNetwork {
  lines: Line[] = []
  stations: Station[] = []
  links: Link[] = []
  private paths: number[][] = []
  private decoded = new Map<number, Float64Array>()
  private grid = new Map<string, number[]>()
  private byGroup = new Map<number, number[]>()

  static async load(url = `${import.meta.env.BASE_URL}data/rail.json`): Promise<RailNetwork> {
    const res = await fetch(url)
    const data = await res.json()
    return new RailNetwork(data)
  }

  constructor(data: { lines: [string, string, string, LineKind, string][]; stations: [string, string, string, number, number, number, number, number?][]; links: [number, number, number, number, number][]; paths: number[][] }) {
    this.lines = data.lines.map(([ja, en, operator, kind, color], id) => ({ id, ja, en, operator, kind, color: color || defaultColor(kind) }))
    this.stations = data.stations.map(([ja, kana, en, line, group, la, lo, riders], id) => ({ id, ja, kana, en, line, group, lat: la / 1e5, lon: lo / 1e5, riders: riders ?? 0, links: [] }))
    this.links = data.links.map(([a, b, line, length, path], id) => ({ id, a, b, line, length, path }))
    this.paths = data.paths
    for (const l of this.links) {
      this.stations[l.a].links.push(l.id)
      this.stations[l.b].links.push(l.id)
    }
    for (const s of this.stations) {
      const k = cellKey(s.lat, s.lon)
      let c = this.grid.get(k)
      if (!c) this.grid.set(k, (c = []))
      c.push(s.id)
      let g = this.byGroup.get(s.group)
      if (!g) this.byGroup.set(s.group, (g = []))
      g.push(s.id)
    }
  }

  /** Track polyline of a link as [lat, lon, lat, lon, ...] from station a to b. */
  linkPath(linkId: number): Float64Array {
    let p = this.decoded.get(linkId)
    if (p) return p
    const enc = this.paths[this.links[linkId].path]
    p = new Float64Array(enc.length)
    let la = 0
    let lo = 0
    for (let i = 0; i < enc.length; i += 2) {
      la += enc[i]
      lo += enc[i + 1]
      p[i] = la / 1e5
      p[i + 1] = lo / 1e5
    }
    this.decoded.set(linkId, p)
    return p
  }

  /** Path of a link oriented to run from station `from`. */
  linkPathFrom(linkId: number, from: number): Float64Array {
    const p = this.linkPath(linkId)
    if (this.links[linkId].a === from) return p
    const r = new Float64Array(p.length)
    for (let i = 0; i < p.length; i += 2) {
      r[i] = p[p.length - 2 - i]
      r[i + 1] = p[p.length - 1 - i]
    }
    return r
  }

  other(linkId: number, s: number): number {
    const l = this.links[linkId]
    return l.a === s ? l.b : l.a
  }

  /** All platforms (one per line) of the station complex a station belongs to. */
  complex(stationId: number): Station[] {
    return (this.byGroup.get(this.stations[stationId].group) ?? [stationId]).map((i) => this.stations[i])
  }

  nearby(lat: number, lon: number, radius: number): { station: Station; d: number }[] {
    const out: { station: Station; d: number }[] = []
    const r = Math.ceil(radius / 1000) + 1
    const cy = Math.floor(lat * 100)
    const cx = Math.floor(lon * 100)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        for (const id of this.grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          const s = this.stations[id]
          const d = haversine({ lat, lon }, s)
          if (d <= radius) out.push({ station: s, d })
        }
      }
    return out.sort((a, b) => a.d - b.d)
  }

  /** Station complexes matching a query in kanji, kana or romaji. One result per complex. */
  search(q: string, limit = 12, near?: { lat: number; lon: number }): Station[] {
    const n = normalize(q)
    if (!n) return []
    const scored: { s: Station; score: number }[] = []
    const seen = new Set<number>()
    for (const s of this.stations) {
      if (seen.has(s.group)) continue
      const ja = s.ja
      const en = normalize(s.en)
      let score = 0
      if (ja === q || en === n || s.kana === q) score = 100
      else if (ja.startsWith(q) || en.startsWith(n) || s.kana.startsWith(q)) score = 60
      else if (ja.includes(q) || en.includes(n)) score = 30
      if (!score) continue
      seen.add(s.group)
      // Prefer big hubs (many lines) and, slightly, nearby stations.
      score += Math.min(20, (this.byGroup.get(s.group)?.length ?? 1) * 3)
      if (near) score -= Math.min(15, haversine(near, s) / 40000)
      scored.push({ s, score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.s)
  }

  private walkCache = new Map<number, { id: number; d: number }[]>()

  /** Stations of other complexes within a short walk. */
  private walkable(id: number): { id: number; d: number }[] {
    let w = this.walkCache.get(id)
    if (w) return w
    const s = this.stations[id]
    w = this.nearby(s.lat, s.lon, 400)
      .filter((n) => n.station.group !== s.group)
      .map((n) => ({ id: n.station.id, d: n.d }))
    this.walkCache.set(id, w)
    return w
  }

  /** Does the train on this line stop here (express Shinkansen skip small stops)? */
  stopsAt(stationId: number, lineId: number): boolean {
    const line = this.lines[lineId]
    if (line.kind !== 'shinkansen') return true
    return SHINKANSEN_STOPS.has(this.stations[stationId].ja)
  }

  /**
   * Fastest route between two station complexes. Dijkstra over
   * (station, line) with link running times, dwell at intermediate stops and
   * a transfer penalty between platforms of the same complex.
   */
  route(fromStation: number, toStation: number): Route | null {
    const sources = this.complex(fromStation).map((s) => s.id)
    const targets = new Set(this.complex(toStation).map((s) => s.id))
    const N = this.stations.length
    const dist = new Float64Array(N).fill(Infinity)
    const prev = new Int32Array(N).fill(-1) // previous station
    const via = new Int32Array(N).fill(-1) // link used (-1 = transfer)
    const heap = new MinHeap()
    for (const s of sources) {
      dist[s] = 0
      heap.push(0, s)
    }
    let end = -1
    while (heap.size) {
      const [d, u] = heap.pop()
      if (d > dist[u]) continue
      if (targets.has(u)) {
        end = u
        break
      }
      const su = this.stations[u]
      for (const lid of su.links) {
        const l = this.links[lid]
        const v = l.a === u ? l.b : l.a
        const line = this.lines[l.line]
        const nd = d + linkTime(line.kind, l.length, this.stopsAt(v, l.line))
        if (nd < dist[v]) {
          dist[v] = nd
          prev[v] = u
          via[v] = lid
          heap.push(nd, v)
        }
      }
      // Transfers inside the complex: walk + wait for the next train.
      for (const w of this.byGroup.get(su.group) ?? []) {
        if (w === u) continue
        const sameOp = this.lines[this.stations[w].line].operator === this.lines[su.line].operator
        const nd = d + (sameOp ? 360 : 540)
        if (nd < dist[w]) {
          dist[w] = nd
          prev[w] = u
          via[w] = -1
          heap.push(nd, w)
        }
      }
      // Out-of-station walking transfers (e.g. Asakusa TX <-> Ginza line).
      for (const w of this.walkable(u)) {
        const nd = d + 300 + w.d / 1.1
        if (nd < dist[w.id]) {
          dist[w.id] = nd
          prev[w.id] = u
          via[w.id] = -1
          heap.push(nd, w.id)
        }
      }
    }
    if (end < 0) return null
    // Unwind into legs.
    const chain: number[] = []
    for (let s = end; s !== -1; s = prev[s]) chain.push(s)
    chain.reverse()
    const legs: Leg[] = []
    let cur: Leg | null = null
    for (let i = 1; i < chain.length; i++) {
      const lid = via[chain[i]]
      if (lid < 0) {
        cur = null
        continue
      }
      const l = this.links[lid]
      if (!cur || cur.line.id !== l.line) {
        cur = { line: this.lines[l.line], stations: [chain[i - 1]], links: [], length: 0, time: 0, fare: 0 }
        legs.push(cur)
      }
      cur.stations.push(chain[i])
      cur.links.push(lid)
      cur.length += l.length
    }
    for (const leg of legs) {
      leg.time = leg.links.reduce((t, lid, i) => {
        const l = this.links[lid]
        const stop = i === leg.links.length - 1 || this.stopsAt(leg.stations[i + 1], l.line)
        return t + linkTime(leg.line.kind, l.length, stop)
      }, 0)
    }
    // Fares: consecutive legs on the same operator (or JR group) are one journey.
    let fare = 0
    let i = 0
    while (i < legs.length) {
      const fam = fareFamily(legs[i].line)
      let km = 0
      let j = i
      let kind = legs[i].line.kind
      while (j < legs.length && fareFamily(legs[j].line) === fam) {
        km += legs[j].length / 1000
        if (legs[j].line.kind === 'shinkansen') kind = 'shinkansen'
        j++
      }
      const f = fareFor(kind, km, legs[i].line.operator)
      legs[i].fare = f
      fare += f
      i = j
    }
    const transfers = Math.max(0, legs.length - 1)
    return { legs, time: dist[end], fare, transfers }
  }
}

function fareFamily(l: Line): string {
  if (l.kind === 'jr' || l.kind === 'shinkansen') return 'JR'
  return l.operator
}

function defaultColor(kind: LineKind): string {
  return { shinkansen: '#1d4fa0', jr: '#3a8c4a', metro: '#7b6fb0', private: '#c0392b', tram: '#d98e04', monorail: '#2a7fb8', agt: '#2a9db8', cable: '#8a6d3b' }[kind]
}

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat * 100)},${Math.floor(lon * 100)}`
}

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+|-|station$/g, '')
}

class MinHeap {
  private k: number[] = []
  private v: number[] = []
  get size(): number {
    return this.k.length
  }
  push(key: number, val: number): void {
    const k = this.k
    const v = this.v
    let i = k.length
    k.push(key)
    v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]
      v[i] = v[p]
      i = p
    }
    k[i] = key
    v[i] = val
  }
  pop(): [number, number] {
    const k = this.k
    const v = this.v
    const rk = k[0]
    const rv = v[0]
    const lk = k.pop()!
    const lv = v.pop()!
    if (k.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= k.length) break
        if (c + 1 < k.length && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]
        v[i] = v[c]
        i = c
      }
      k[i] = lk
      v[i] = lv
    }
    return [rk, rv]
  }
}
