// Drivable lane graph built from OSM road centrelines of the loaded tiles.
// Japan drives on the left: each lane is offset to the left of its direction
// of travel. Lanes meet at nodes (shared way endpoints); routing is A*.
import { Vector3, type Matrix4 } from 'three'
import type { NavPath } from '../world/vector/build'

export interface Lane {
  id: number
  tile: string
  cls: string
  pts: Vector3[] // world space
  cum: number[] // cumulative distance
  length: number
  from: number // node id
  to: number
  next: number[] // lane ids continuing from `to`
  speed: number // m/s limit
  width: number
  /** Parallel lanes in this direction (wide urban roads carry 2-3). */
  lanes: number
  signal: number | null // signal id at the end node, if any
  heading: number // final heading (rad) for signal phase
  bridge: boolean
}

export interface Signal {
  id: number
  node: number
  pos: Vector3
  offset: number // phase offset (s)
  cycle: number
}

// Japanese default limits (km/h): residential 30, typical urban 40–50,
// trunk 60, urban expressway 60–80, intercity 100.
const SPEED_KMH: Record<string, number> = {
  motorway: 80,
  trunk: 60,
  primary: 50,
  secondary: 40,
  tertiary: 40,
  minor: 30,
  service: 20,
  track: 20,
  busway: 40,
}

const DRIVABLE = new Set(Object.keys(SPEED_KMH))

export class RoadGraph {
  /** Optional: is this junction currently all-red (scramble walk phase)? */
  allRed: ((pos: Vector3) => boolean) | null = null
  lanes: Lane[] = []
  private nodeIndex = new Map<string, number>()
  nodePos: Vector3[] = []
  signals: Signal[] = []
  private tileLanes = new Map<string, number[]>()
  private nextLaneId = 0

  private node(p: Vector3): number {
    const k = `${Math.round(p.x * 2)},${Math.round(p.y)},${Math.round(p.z * 2)}`
    let id = this.nodeIndex.get(k)
    if (id === undefined) {
      id = this.nodePos.length
      this.nodePos.push(p.clone())
      this.nodeIndex.set(k, id)
    }
    return id
  }

  /** (Re)build the whole graph from the given tiles. Cheap enough to redo. */
  rebuild(tiles: Array<{ key: string; paths: NavPath[]; matrix: Matrix4 }>): void {
    this.lanes = []
    this.nodeIndex.clear()
    this.nodePos = []
    this.signals = []
    this.tileLanes.clear()
    this.nextLaneId = 0
    const degree = new Map<number, number>()
    const majorAt = new Set<number>()
    for (const t of tiles) {
      for (const p of t.paths) {
        if (p.kind !== 'road' || !DRIVABLE.has(p.cls)) continue
        const pts: Vector3[] = []
        for (let i = 0; i < p.pts.length; i += 3) pts.push(new Vector3(p.pts[i], p.pts[i + 1], p.pts[i + 2]).applyMatrix4(t.matrix))
        if (pts.length < 2) continue
        const speed = (SPEED_KMH[p.cls] ?? 30) / 3.6
        const a = this.node(pts[0])
        const b = this.node(pts[pts.length - 1])
        degree.set(a, (degree.get(a) ?? 0) + 1)
        degree.set(b, (degree.get(b) ?? 0) + 1)
        if (['primary', 'secondary', 'tertiary', 'trunk'].includes(p.cls)) {
          majorAt.add(a)
          majorAt.add(b)
        }
        const laneW = p.cls === 'motorway' ? 3.5 : Math.min(3.25, p.width / 2)
        const oneway = p.oneway !== 0 || p.cls === 'motorway'
        const forward = p.oneway === -1 ? [...pts].reverse() : pts
        // Lanes per direction from the carriageway width (OSM has no lane
        // counts in the tiles): a 14 m primary carries two each way.
        const multi = ['motorway', 'trunk', 'primary', 'secondary'].includes(p.cls)
        const perDir = multi ? Math.max(1, Math.min(3, Math.floor((oneway ? p.width : p.width / 2) / 3.1))) : 1
        if (oneway) this.addLane(t.key, p, offsetLine(forward, perDir > 1 ? -laneW * (perDir - 1) * 0.5 : 0), speed, laneW, perDir)
        else {
          this.addLane(t.key, p, offsetLine(pts, laneW * 0.5), speed, laneW, perDir)
          this.addLane(t.key, p, offsetLine([...pts].reverse(), laneW * 0.5), speed, laneW, perDir)
        }
      }
    }
    // Lanes are offset from the centreline: connect them via the nearest
    // centreline node (spatial hash, 4 m cells).
    this.grid.clear()
    this.nodePos.forEach((p, i) => {
      const k = `${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`
      if (!this.grid.has(k)) this.grid.set(k, [])
      this.grid.get(k)!.push(i)
    })
    const startsAt = new Map<number, number[]>()
    for (const lane of this.lanes) {
      lane.from = this.nearestNode(lane.pts[0])
      lane.to = this.nearestNode(lane.pts[lane.pts.length - 1])
      if (!startsAt.has(lane.from)) startsAt.set(lane.from, [])
      startsAt.get(lane.from)!.push(lane.id)
    }
    for (const lane of this.lanes) {
      const cands = startsAt.get(lane.to) ?? []
      lane.next = cands.filter((id) => {
        const n = this.lanes[id]
        // no U-turns
        return n.to !== lane.from || cands.length === 1
      })
    }
    // Signals at junctions where a major road meets ≥2 others.
    let sid = 0
    for (const [n, d] of degree) {
      if (d >= 3 && majorAt.has(n)) {
        const pos = this.nodePos[n]
        const h = Math.sin(pos.x * 0.013 + pos.z * 0.007) * 0.5 + 0.5
        this.signals.push({ id: sid++, node: n, pos, offset: h * 60, cycle: 60 })
      }
    }
    const sigByNode = new Map(this.signals.map((s) => [s.node, s.id]))
    for (const lane of this.lanes) lane.signal = sigByNode.get(lane.to) ?? null
  }

  private grid = new Map<string, number[]>()

  private nearestNode(p: Vector3): number {
    let best = -1
    let bd = Infinity
    const cx = Math.floor(p.x / 4)
    const cz = Math.floor(p.z / 4)
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const i of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const d = this.nodePos[i].distanceToSquared(p)
          if (d < bd) {
            bd = d
            best = i
          }
        }
    return best
  }

  private addLane(tile: string, p: NavPath, pts: Vector3[], speed: number, width: number, lanes = 1): void {
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]))
    const n = pts.length
    const dx = pts[n - 1].x - pts[n - 2].x
    const dz = pts[n - 1].z - pts[n - 2].z
    const lane: Lane = {
      id: this.nextLaneId++,
      tile,
      cls: p.cls,
      pts,
      cum,
      length: cum[cum.length - 1],
      from: -1,
      to: -1,
      next: [],
      speed,
      width,
      lanes,
      signal: null,
      heading: Math.atan2(-dx, -dz),
      bridge: p.bridge,
    }
    this.lanes.push(lane)
    if (!this.tileLanes.has(tile)) this.tileLanes.set(tile, [])
    this.tileLanes.get(tile)!.push(lane.id)
  }

  /** Position + tangent at distance s along a lane. */
  sample(lane: Lane, s: number, outP: Vector3, outT: Vector3): void {
    s = Math.max(0, Math.min(lane.length, s))
    let i = 1
    while (i < lane.cum.length - 1 && lane.cum[i] < s) i++
    const a = lane.pts[i - 1]
    const b = lane.pts[i]
    const seg = lane.cum[i] - lane.cum[i - 1] || 1
    const f = (s - lane.cum[i - 1]) / seg
    outP.lerpVectors(a, b, f)
    outT.subVectors(b, a).normalize()
  }

  /** Is the signal at the end of this lane green for its approach direction? */
  isGreen(lane: Lane, time: number): boolean {
    if (lane.signal === null) return true
    const s = this.signals[lane.signal]
    // All-red while a scramble crossing gives pedestrians every direction.
    if (this.allRed?.(s.pos)) return false
    const t = (time + s.offset) % s.cycle
    // Two phases by approach axis; 3 s amber + 2 s all-red between phases.
    const axisNS = Math.abs(Math.cos(lane.heading)) > Math.abs(Math.sin(lane.heading))
    const phaseA = t < s.cycle / 2 - 5
    const phaseB = t >= s.cycle / 2 && t < s.cycle - 5
    return axisNS ? phaseA : phaseB
  }

  /** Signal state for rendering pedestrians/crossings: 0 green NS, 1 green EW, 2 transition. */
  phase(signal: Signal, time: number): number {
    const t = (time + signal.offset) % signal.cycle
    if (t < signal.cycle / 2 - 5) return 0
    if (t >= signal.cycle / 2 && t < signal.cycle - 5) return 1
    return 2
  }

  nearestLane(p: Vector3, maxDist = 30, filter?: (l: Lane) => boolean): { lane: Lane; s: number; d: number } | null {
    let best: { lane: Lane; s: number; d: number } | null = null
    const tmp = new Vector3()
    for (const lane of this.lanes) {
      if (filter && !filter(lane)) continue
      for (let i = 1; i < lane.pts.length; i++) {
        const a = lane.pts[i - 1]
        const b = lane.pts[i]
        const ab = tmp.subVectors(b, a)
        const len2 = ab.lengthSq() || 1
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / len2))
        const q = a.clone().addScaledVector(ab, t)
        const d = q.distanceTo(p)
        if (d < maxDist && (!best || d < best.d)) best = { lane, s: lane.cum[i - 1] + Math.sqrt(len2) * t, d }
      }
    }
    return best
  }

  /** A* over lanes from a lane to the lane closest to `goal`. Returns lane ids. */
  route(fromLane: number, goal: Vector3, maxExpand = 6000): number[] {
    const goalLane = this.nearestLane(goal, 1e9)
    if (!goalLane) return [fromLane]
    const target = goalLane.lane.id
    const open = new Map<number, number>([[fromLane, 0]])
    const g = new Map<number, number>([[fromLane, 0]])
    const came = new Map<number, number>()
    let expanded = 0
    let bestId = fromLane
    let bestH = Infinity
    while (open.size && expanded++ < maxExpand) {
      let cur = -1
      let cf = Infinity
      for (const [id, f] of open) if (f < cf) [cur, cf] = [id, f]
      open.delete(cur)
      if (cur === target) {
        bestId = cur
        break
      }
      const lane = this.lanes[cur]
      const h = lane.pts[lane.pts.length - 1].distanceTo(goal)
      if (h < bestH) {
        bestH = h
        bestId = cur
      }
      for (const n of lane.next) {
        const nl = this.lanes[n]
        const cost = g.get(cur)! + nl.length / Math.max(5, nl.speed)
        if (cost < (g.get(n) ?? Infinity)) {
          g.set(n, cost)
          came.set(n, cur)
          open.set(n, cost + nl.pts[nl.pts.length - 1].distanceTo(goal) / 15)
        }
      }
    }
    const path = [bestId]
    while (came.has(path[0])) path.unshift(came.get(path[0])!)
    return path
  }

  applyRebase(delta: Matrix4): void {
    for (const l of this.lanes) for (const p of l.pts) p.applyMatrix4(delta)
    for (const p of this.nodePos) p.applyMatrix4(delta)
  }
}

/** Offset a polyline to the LEFT of its direction by d metres (x right, -z forward). */
export function offsetLine(pts: Vector3[], d: number): Vector3[] {
  if (d === 0) return pts.map((p) => p.clone())
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const tx = b.x - a.x
    const tz = b.z - a.z
    const l = Math.hypot(tx, tz) || 1
    // left of forward (tx,tz) in a right-handed, y-up frame is (tz, -tx)
    return new Vector3(p.x + (tz / l) * d, p.y, p.z + (-tx / l) * d)
  })
}
