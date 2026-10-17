// A train running along the real track geometry of a sequence of links.
// Driving follows simple railway physics: notch-up acceleration, curve speed
// limits from the track radius, and a braking curve that stops the train
// centred on each platform. Cars are placed bogie-by-bogie on the track and
// snapped onto the rendered OSM rails (viaducts included); where the line
// leaves the surface (subways, mountain tunnels) the train descends into a
// tunnel at a realistic gradient.
import { Group, Matrix4, Vector3 } from 'three'
import type { WorldFrame } from '../core/frame'
import type { TerrainManager } from '../world/terrain/TerrainManager'
import { RUNNING, type Line, type RailNetwork } from './RailNetwork'
import type { RailSnap } from './RailSnap'
import { buildConsist, styleForLine, type Car, type TrainStyle } from './trainModels'

export interface Stop {
  s: number // along-path position of the station (platform centre)
  station: number
  stops: boolean // false = passes through (express)
}

const GAP = 0.6
const TUNNEL_DEPTH = 11
const MAX_GRADE = 0.035

export class TrainRun {
  readonly group = new Group()
  readonly cars: Car[]
  readonly style: TrainStyle
  readonly stops: Stop[] = []
  readonly length: number
  s: number
  v = 0
  state: 'dwell' | 'run' | 'arrived' = 'dwell'
  dwell = 20
  /** Index into stops of the stop the train is heading for / standing at. */
  at = 0
  underground = false
  onArrive: ((stop: Stop, index: number) => void) | null = null
  onDepart: ((stop: Stop, index: number) => void) | null = null

  private lat: Float64Array
  private lon: Float64Array
  private cum: Float64Array
  private vlim: Float32Array
  private offset = new Vector3()
  // Height of the track above the terrain, recorded as the front advances.
  private profS: number[] = []
  private profH: number[] = []
  private noSnapRun = 0
  private snapRun = 0

  constructor(
    net: RailNetwork,
    readonly line: Line,
    links: number[],
    stations: number[],
    private world: WorldFrame,
    private terrain: TerrainManager,
    private snap: RailSnap,
    cars?: number,
  ) {
    this.style = styleForLine(line, cars)
    this.cars = buildConsist(this.style)
    for (const c of this.cars) this.group.add(c.group)
    this.length = this.cars.reduce((a, c) => a + c.length + GAP, -GAP)

    // Concatenate link geometry.
    const la: number[] = []
    const lo: number[] = []
    this.stops.push({ s: 0, station: stations[0], stops: true })
    let cum = 0
    const cumArr: number[] = []
    links.forEach((lid, i) => {
      const p = net.linkPathFrom(lid, stations[i])
      for (let k = 0; k < p.length; k += 2) {
        if (la.length && k === 0) continue
        if (la.length) {
          const d = metres(la[la.length - 1], lo[lo.length - 1], p[k], p[k + 1])
          if (d < 0.01) continue
          cum += d
        }
        la.push(p[k])
        lo.push(p[k + 1])
        cumArr.push(cum)
      }
      const last = i === links.length - 1
      this.stops.push({ s: cum, station: stations[i + 1], stops: last || net.stopsAt(stations[i + 1], line.id) })
    })
    this.lat = Float64Array.from(la)
    this.lon = Float64Array.from(lo)
    this.cum = Float64Array.from(cumArr)
    this.vlim = curveLimits(this.lat, this.lon, this.cum, line.kind === 'shinkansen' ? 0.55 : 0.85, RUNNING[line.kind].vmax)
    this.s = this.stopPos(0)
  }

  get total(): number {
    return this.cum[this.cum.length - 1]
  }

  /** Front-of-train position when stopped centred on stop i. */
  stopPos(i: number): number {
    return this.stops[i].s + this.length / 2
  }

  get nextStopIndex(): number {
    for (let i = this.at + (this.state === 'dwell' ? 1 : 0); i < this.stops.length; i++) if (this.stops[i].stops) return i
    return this.stops.length - 1
  }

  /** The upcoming station (stopping or not) for announcements/LCD. */
  get nextStation(): Stop {
    return this.stops[Math.min(this.stops.length - 1, this.nextStopIndex)]
  }

  /** Skip ahead: place the train just before its next stop (or a given one). */
  skipTo(index: number): void {
    const i = Math.min(this.stops.length - 1, index)
    this.s = Math.max(this.s, this.stopPos(i) - 260)
    this.at = i
    this.v = Math.min(this.v, 16)
    this.state = 'run'
    this.profS.length = 0
    this.profH.length = 0
  }

  update(dt: number): void {
    const R = RUNNING[this.line.kind]
    if (this.state === 'dwell') {
      this.dwell -= dt
      if (this.dwell <= 0) {
        if (this.at >= this.stops.length - 1) this.state = 'arrived'
        else {
          this.state = 'run'
          this.onDepart?.(this.stops[this.at], this.at)
          this.at = this.nextStopIndex
        }
      }
    } else if (this.state === 'run') {
      const target = this.stopPos(this.at)
      const dist = target - this.s
      // Braking curve to the platform and to curve limits ahead.
      let allowed = Math.sqrt(Math.max(0, 2 * R.dec * 0.85 * dist))
      const look = (this.v * this.v) / (2 * R.dec) + 60
      let i = this.index(this.s)
      while (i < this.cum.length && this.cum[i] < this.s + look) {
        const d = Math.max(0, this.cum[i] - this.s - this.length * 0) // front reaches the curve first
        allowed = Math.min(allowed, Math.sqrt(this.vlim[i] * this.vlim[i] + 2 * R.dec * 0.7 * d))
        i++
      }
      allowed = Math.min(allowed, R.vmax, this.vlim[this.index(this.s - this.length)] ?? R.vmax)
      if (this.v < allowed) this.v = Math.min(allowed, this.v + R.acc * dt)
      else this.v = Math.max(allowed, this.v - R.dec * 1.4 * dt)
      if (dist < 4) this.v = Math.max(this.v, 0.6)
      this.s += this.v * dt
      if (this.s >= target - 0.05) {
        this.s = target
        this.v = 0
        this.state = 'dwell'
        this.dwell = R.dwell
        this.onArrive?.(this.stops[this.at], this.at)
      }
    }
    this.recordProfile()
    this.place()
  }

  // ------------------------------------------------------------ geometry

  private index(s: number): number {
    const c = this.cum
    let lo = 0
    let hi = c.length - 1
    if (s <= 0) return 0
    if (s >= c[hi]) return hi
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (c[m] <= s) lo = m
      else hi = m
    }
    return lo
  }

  /** Geodetic point at distance s (linear extrapolation past the ends). */
  private geo(s: number): { lat: number; lon: number } {
    const c = this.cum
    const n = c.length
    let i = Math.min(n - 2, this.index(s))
    if (s < 0) i = 0
    const span = c[i + 1] - c[i] || 1
    const t = (s - c[i]) / span
    return { lat: this.lat[i] + (this.lat[i + 1] - this.lat[i]) * t, lon: this.lon[i] + (this.lon[i + 1] - this.lon[i]) * t }
  }

  private lastGround = 0

  private ground(lat: number, lon: number): number {
    const h = this.terrain.heightAt(lat, lon)
    if (Number.isFinite(h)) this.lastGround = h
    return this.lastGround
  }

  /** Raw surface point of the N02 centreline at s (terrain height). */
  private base(s: number, out: Vector3): Vector3 {
    const g = this.geo(s)
    return this.world.worldFromGeodetic(g.lat, g.lon, this.ground(g.lat, g.lon), out)
  }

  private tmpA = new Vector3()
  private tmpB = new Vector3()
  private tmpD = new Vector3()

  private recordProfile(): void {
    const ahead = this.s + 40
    const last = this.profS.length ? this.profS[this.profS.length - 1] : -Infinity
    if (ahead - last < 3) return
    const p = this.base(ahead, this.tmpA)
    const q = this.base(ahead + 4, this.tmpB)
    const dir = this.tmpD.subVectors(q, p).normalize()
    // Japan runs on the left: start on the left-hand track of a double line.
    if (!this.profS.length && this.offset.lengthSq() === 0) this.offset.set(dir.z, 0, -dir.x).multiplyScalar(1.9)
    const hit = this.snap.query(p, dir, this.offset)
    let rel: number
    const loaded = this.snap.hasDataNear(p)
    if (hit) {
      this.snapRun += 3
      this.noSnapRun = 0
      this.offset.lerp(new Vector3(hit.point.x - p.x, 0, hit.point.z - p.z), 0.35)
      rel = hit.point.y + 0.17 - p.y
    } else {
      this.noSnapRun += 3
      this.snapRun = 0
      const tunnel = (loaded && this.noSnapRun > 45) || (!loaded && this.line.kind === 'metro')
      rel = tunnel ? -TUNNEL_DEPTH : 0.42
    }
    const prevH = this.profH.length ? this.profH[this.profH.length - 1] : rel
    const ds = Number.isFinite(last) ? ahead - last : 0
    const lim = Math.max(0.5, ds * MAX_GRADE)
    const h = this.profS.length ? prevH + Math.max(-lim, Math.min(lim, rel - prevH)) : rel
    this.profS.push(ahead)
    this.profH.push(h)
    // Keep ~1.5 train lengths of history.
    while (this.profS.length > 2 && this.profS[1] < this.s - this.length - 80) {
      this.profS.shift()
      this.profH.shift()
    }
  }

  private heightAt(s: number): number {
    const S = this.profS
    if (!S.length) return 0.42
    if (s <= S[0]) return this.profH[0]
    for (let i = S.length - 1; i > 0; i--) {
      if (S[i - 1] <= s) {
        const t = (s - S[i - 1]) / (S[i] - S[i - 1] || 1)
        return this.profH[i - 1] + (this.profH[i] - this.profH[i - 1]) * t
      }
    }
    return this.profH[S.length - 1]
  }

  /** World position of the rail centre at s, snapped to the rendered track. */
  railPoint(s: number, out = new Vector3()): Vector3 {
    const p = this.base(s, out)
    const h = this.heightAt(s)
    const q = this.base(s + 3, this.tmpB)
    const dir = this.tmpD.subVectors(q, p)
    if (h > -2) {
      const hit = this.snap.query(p, dir, this.offset, 18)
      if (hit) return out.set(hit.point.x, hit.point.y + 0.17, hit.point.z)
    }
    return out.set(p.x + this.offset.x, p.y + h, p.z + this.offset.z)
  }

  private m = new Matrix4()
  private up = new Vector3(0, 1, 0)

  place(): void {
    let off = 0
    const f = new Vector3()
    const r = new Vector3()
    for (const car of this.cars) {
      const centre = this.s - off - car.length / 2
      const half = car.length / 2 - 2.6
      this.railPoint(centre + half, f)
      this.railPoint(centre - half, r)
      const g = car.group
      g.position.addVectors(f, r).multiplyScalar(0.5)
      this.m.lookAt(f, r, this.up) // +z toward the front bogie
      g.quaternion.setFromRotationMatrix(this.m)
      g.updateMatrixWorld()
      off += car.length + GAP
    }
    this.underground = this.heightAt(this.s - this.length / 2) < -4
  }

  /** Depth of the track relative to the surface at s (negative = tunnel). */
  trackDepth(s: number): number {
    return this.heightAt(s)
  }

  /** World rail-head position and direction at absolute path distance s. */
  frameAtDistance(s: number, pos: Vector3, fwd: Vector3): void {
    this.railPoint(s, pos)
    this.railPoint(s + 4, fwd)
    fwd.sub(pos).normalize()
  }

  /** World position and forward direction at a point along the train (0 = front). */
  frameAt(back: number, pos: Vector3, fwd: Vector3): void {
    this.railPoint(this.s - back, pos)
    this.railPoint(this.s - back + 4, fwd)
    fwd.sub(pos).normalize()
  }

  dispose(): void {
    this.group.removeFromParent()
  }
}

function metres(la1: number, lo1: number, la2: number, lo2: number): number {
  const k = Math.PI / 180
  const x = (lo2 - lo1) * k * Math.cos(((la1 + la2) / 2) * k) * 6371008
  const y = (la2 - la1) * k * 6371008
  return Math.hypot(x, y)
}

/** Per-vertex curve speed limit from the circumscribed radius, smoothed over ~60 m. */
function curveLimits(lat: Float64Array, lon: Float64Array, cum: Float64Array, aLat: number, vmax: number): Float32Array {
  const n = lat.length
  const out = new Float32Array(n).fill(vmax)
  const k = Math.PI / 180
  const xy = (i: number) => [lon[i] * k * Math.cos(lat[i] * k) * 6371008, lat[i] * k * 6371008]
  for (let i = 1; i < n - 1; i++) {
    // Use points ~25 m apart to keep the 2 m simplification noise out.
    let a = i
    while (a > 0 && cum[i] - cum[a] < 25) a--
    let b = i
    while (b < n - 1 && cum[b] - cum[i] < 25) b++
    const [x1, y1] = xy(a)
    const [x2, y2] = xy(i)
    const [x3, y3] = xy(b)
    const A = Math.hypot(x2 - x1, y2 - y1)
    const B = Math.hypot(x3 - x2, y3 - y2)
    const C = Math.hypot(x3 - x1, y3 - y1)
    const area2 = Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1))
    if (area2 < 1e-6) continue
    const R = (A * B * C) / (2 * area2)
    out[i] = Math.max(25 / 3.6, Math.min(vmax, Math.sqrt(aLat * R)))
  }
  return out
}
