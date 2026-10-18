// AI traffic on the real road network: Intelligent Driver Model car
// following, signals at major junctions, yielding at busy junctions, taxis
// that can be hailed and buses that dwell at real bus stops.
import type RAPIER from '@dimforge/rapier3d-compat'
import { Group, Quaternion, Vector3, type Matrix4 } from 'three'
import type { Physics } from '../physics/Physics'
import type { VectorManager } from '../world/vector/VectorManager'
import { RoadGraph, type Lane } from './RoadGraph'
import { specById, vehicleFromScene, type CarSpec, type VehicleModel } from './carGeometry'
import { modelLibrary } from '../world/props/ModelLibrary'
import { groups, WORLD_GROUP, PLAYER_GROUP } from '../player/Player'
import { VEHICLE_GROUP } from './Vehicle'

export type AIRole = 'car' | 'taxi' | 'bus'

export class AICar {
  s = 0
  v = 0
  stopTimer = 0
  nextLane = -1
  route: number[] = []
  vacant = true
  hailed = false
  /** Passenger destination for taxi rides / player bus rides. */
  destination: Vector3 | null = null
  body: RAPIER.RigidBody | null = null
  wheelSpin = 0
  readonly pos = new Vector3()
  readonly tan = new Vector3(0, 0, -1)
  passengerAboard = false
  lastStopPoi = ''

  constructor(
    readonly model: VehicleModel,
    readonly spec: CarSpec,
    public lane: Lane,
    readonly role: AIRole,
  ) {}

  get length(): number {
    return this.spec.length
  }
}

const _q = new Quaternion()
const _up = new Vector3(0, 1, 0)
const _m = new Vector3()

const MIX: Array<[string, number]> = [
  ['kei_car', 0.28],
  ['sedan_m', 0.17],
  ['compact', 0.1],
  ['minivan', 0.12],
  ['kei_truck_m', 0.07],
  ['kei_van', 0.05],
  ['light_truck_m', 0.1],
  ['pickup_m', 0.03],
]

export class Traffic {
  readonly root = new Group()
  readonly graph = new RoadGraph()
  readonly cars: AICar[] = []
  private rebuildTimer = 0
  private tileSig = ''
  private spawnTimer = 0
  private pending = 0
  /** Bus stops (world positions) from OSM POIs, refreshed with the graph. */
  busStops: Array<{ pos: Vector3; name: string }> = []
  density = 1
  time = 0
  private ring: Lane[] = []
  private ringTime = -10
  /** Obstacles AI must not hit: the player on foot / the player's car. */
  playerPos: Vector3 | null = null
  playerCar: { pos: Vector3; length: number } | null = null

  constructor(
    private physics: Physics,
    private vector: VectorManager,
  ) {
    this.root.name = 'traffic'
  }

  /** Target number of AI vehicles near the player. */
  targetCount(): number {
    const lanes = this.graph.lanes.length
    return Math.round(Math.min(42, Math.max(2, lanes / 18)) * this.density)
  }

  update(dt: number, center: Vector3, timeOfDayH: number): void {
    this.time += dt
    this.rebuildTimer += dt
    if (this.rebuildTimer > 3) {
      this.rebuildTimer = 0
      const tiles = this.vector.readyTiles
      const sig = tiles.map((t) => t.key + t.build.paths.length).join('|')
      if (sig !== this.tileSig) {
        this.tileSig = sig
        this.rebuildGraph(tiles)
      }
    }
    // Rush hours (7–9, 17–19) are busiest; deep night is quiet.
    const h = timeOfDayH
    const tod = h < 5 ? 0.25 : h < 7 ? 0.6 : h < 9.5 ? 1.25 : h < 16.5 ? 0.9 : h < 19.5 ? 1.2 : h < 23 ? 0.7 : 0.4
    this.density = tod
    this.spawnTimer += dt
    if (this.spawnTimer > 0.7) {
      this.spawnTimer = 0
      this.maintain(center)
    }
    this.step(dt)
  }

  private rebuildGraph(tiles: Array<{ key: string; build: { paths: import('../world/vector/build').NavPath[]; pois: import('../world/vector/build').Poi[] }; group: Group }>): void {
    const input = tiles.map((t) => {
      t.group.updateWorldMatrix(true, false)
      return { key: t.key, paths: t.build.paths, matrix: t.group.matrixWorld }
    })
    this.graph.rebuild(input)
    this.busStops = []
    for (const t of tiles)
      for (const p of t.build.pois)
        if (p.sub === 'bus_stop' || p.cls === 'bus') this.busStops.push({ pos: new Vector3(p.x, p.y, p.z).applyMatrix4(t.group.matrixWorld), name: p.name })
    // Re-seat existing cars onto the new lanes.
    for (const c of [...this.cars]) {
      const hit = this.graph.nearestLane(c.pos, 6, (l) => l.heading !== undefined && c.tan.dot(this.laneDir(l, c.pos)) > 0.5)
      if (!hit) this.remove(c)
      else {
        c.lane = hit.lane
        c.s = hit.s
        c.nextLane = -1
        c.route = []
      }
    }
  }

  private laneDir(l: Lane, near: Vector3): Vector3 {
    const hit = this.graph.nearestLane(near, 50, (x) => x === l)
    const p = new Vector3()
    const t = new Vector3()
    this.graph.sample(l, hit?.s ?? 0, p, t)
    return t
  }

  private maintain(center: Vector3): void {
    for (const c of [...this.cars]) if (c.pos.distanceTo(center) > 480 && !c.passengerAboard) this.remove(c)
    const want = this.targetCount()
    if (this.cars.length + this.pending >= want || !this.graph.lanes.length) return
    // Lanes passing through the spawn ring (refreshed every few seconds).
    if (this.time - this.ringTime > 3 || !this.ring.length) {
      this.ringTime = this.time
      this.ring = this.graph.lanes.filter((l) => {
        if (l.cls === 'service' || l.cls === 'track' || l.length < 25) return false
        const mid = l.pts[Math.floor(l.pts.length / 2)]
        const d = mid.distanceTo(center)
        return d > 70 && d < 340
      })
    }
    if (!this.ring.length) return
    for (let tries = 0; tries < 6 && this.cars.length + this.pending < want; tries++) {
      const lane = this.ring[Math.floor(Math.random() * this.ring.length)]
      if (lane.cls === 'service' || lane.cls === 'track' || lane.length < 25) continue
      const s = Math.random() * lane.length
      const p = new Vector3()
      const t = new Vector3()
      this.graph.sample(lane, s, p, t)
      const d = p.distanceTo(center)
      if (d < 70 || d > 360) continue
      if (this.cars.some((c) => c.lane === lane && Math.abs(c.s - s) < 18)) continue
      const roll = Math.random()
      const major = ['primary', 'secondary', 'trunk', 'tertiary'].includes(lane.cls)
      const role: AIRole = major && roll < 0.07 ? 'bus' : roll < (major ? 0.2 : 0.1) ? 'taxi' : 'car'
      void this.spawn(lane, s, role)
    }
  }

  private async spawn(lane: Lane, s: number, role: AIRole): Promise<void> {
    this.pending++
    try {
      let base: CarSpec
      if (role === 'bus') base = specById('bus_m')
      else if (role === 'taxi') base = specById('taxi_m')
      else {
        let r = Math.random()
        let id = 'kei_car'
        for (const [k, p] of MIX) {
          if ((r -= p) < 0) {
            id = k
            break
          }
        }
        base = specById(id)
      }
      if (!base.models?.length) return // AI uses real models only
      const modelId = base.models[Math.floor(Math.random() * base.models.length)]
      const scene = await modelLibrary.clone(modelId)
      const color = base.colors.length ? base.colors[Math.floor(Math.random() * base.colors.length)] : undefined
      const { model, spec } = vehicleFromScene(base, scene, color)
      if (!this.graph.lanes.includes(lane)) return
      const car = new AICar(model, spec, lane, role)
      car.s = s
      car.v = lane.speed * 0.8
      car.vacant = role === 'taxi' ? Math.random() < 0.6 : false
      // Kinematic collider so the player's car and the player collide with traffic.
      const R = this.physics.R
      car.body = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased())
      this.physics.world.createCollider(
        R.ColliderDesc.cuboid(spec.width / 2 - 0.05, spec.height / 2 - 0.1, spec.length / 2 - 0.05)
          .setTranslation(0, spec.height / 2, 0)
          .setCollisionGroups(groups(VEHICLE_GROUP, WORLD_GROUP | VEHICLE_GROUP | PLAYER_GROUP)),
        car.body,
      )
      this.place(car)
      this.root.add(model.root)
      this.cars.push(car)
    } finally {
      this.pending--
    }
  }

  remove(c: AICar): void {
    const i = this.cars.indexOf(c)
    if (i >= 0) this.cars.splice(i, 1)
    c.model.root.removeFromParent()
    if (c.body) this.physics.world.removeRigidBody(c.body)
  }

  /** Choose which lane to take at the end of the current one. */
  private chooseNext(c: AICar): number {
    if (c.route.length > 1 && c.route[0] === c.lane.id) return c.route[1]
    const opts = c.lane.next.filter((id) => {
      const l = this.graph.lanes[id]
      if (c.role === 'bus' && !['primary', 'secondary', 'tertiary', 'trunk'].includes(l.cls)) return false
      return l.cls !== 'service' || c.lane.cls === 'service'
    })
    const pool = opts.length ? opts : c.lane.next
    if (!pool.length) return -1
    // Prefer going straight-ish and staying on the same class.
    let best = pool[0]
    let bw = -Infinity
    for (const id of pool) {
      const l = this.graph.lanes[id]
      const dh = Math.abs(Math.atan2(Math.sin(l.heading - c.lane.heading), Math.cos(l.heading - c.lane.heading)))
      const w = (l.cls === c.lane.cls ? 1 : 0) + Math.cos(Math.min(dh, Math.PI / 2)) * 0.7 + Math.random() * 0.9
      if (w > bw) {
        bw = w
        best = id
      }
    }
    return best
  }

  private step(dt: number): void {
    if (!dt) return
    // Group cars per lane, sorted by s.
    const byLane = new Map<number, AICar[]>()
    for (const c of this.cars) {
      if (!byLane.has(c.lane.id)) byLane.set(c.lane.id, [])
      byLane.get(c.lane.id)!.push(c)
    }
    for (const arr of byLane.values()) arr.sort((a, b) => a.s - b.s)
    for (const c of [...this.cars]) {
      const lane = c.lane
      if (c.nextLane < 0) c.nextLane = this.chooseNext(c)
      // --- gap to the obstacle ahead
      let gap = 1e4
      let dv = 0
      const same = byLane.get(lane.id)!
      const idx = same.indexOf(c)
      if (idx + 1 < same.length) {
        const lead = same[idx + 1]
        gap = lead.s - c.s - (lead.length + c.length) / 2
        dv = c.v - lead.v
      } else if (c.nextLane >= 0) {
        const nxt = byLane.get(c.nextLane)
        if (nxt?.length) {
          const lead = nxt[0]
          gap = lane.length - c.s + lead.s - (lead.length + c.length) / 2
          dv = c.v - lead.v
        }
      }
      const toEnd = lane.length - c.s
      // Red light: stop line ~7 m before the junction centre.
      if (!this.graph.isGreen(lane, this.time) && toEnd > 3) {
        const g = toEnd - 7 - c.length / 2
        if (g < gap) {
          gap = Math.max(0.1, g)
          dv = c.v
        }
      }
      // Bus stops: dwell ~15 s when passing a stop on our (left) side.
      if (c.role === 'bus' && c.stopTimer <= 0) {
        for (const bs of this.busStops) {
          const ahead = _m.subVectors(bs.pos, c.pos)
          const along = ahead.dot(c.tan)
          const lateral = Math.hypot(ahead.x - c.tan.x * along, ahead.z - c.tan.z * along)
          if (along > 0 && along < 25 && lateral < 7 && c.lastStopPoi !== bs.name + Math.round(bs.pos.x)) {
            const g = along - 1
            if (g < gap) {
              gap = Math.max(0.1, g)
              dv = c.v
            }
            if (along < 2.5 && c.v < 0.3) {
              c.stopTimer = 15
              c.lastStopPoi = bs.name + Math.round(bs.pos.x)
            }
          }
        }
      }
      // Hailed taxi: pull over at the hailing point.
      if (c.role === 'taxi' && c.hailed && this.playerPos) {
        const ahead = _m.subVectors(this.playerPos, c.pos)
        const along = ahead.dot(c.tan)
        if (along > -2 && along < 40) {
          const g = Math.max(0.1, along - 1)
          if (g < gap) {
            gap = g
            dv = c.v
          }
        }
      }
      // Don't drive through the player or the player's car.
      for (const o of [this.playerPos ? { pos: this.playerPos, length: 0.6 } : null, this.playerCar]) {
        if (!o) continue
        const ahead = _m.subVectors(o.pos, c.pos)
        const along = ahead.dot(c.tan)
        const lateral = Math.hypot(ahead.x - c.tan.x * along, ahead.z - c.tan.z * along)
        if (along > 0 && along < 35 && lateral < c.spec.width * 0.6 + 0.8) {
          const g = along - (o.length + c.length) / 2 - 1.5
          if (g < gap) {
            gap = Math.max(0.1, g)
            dv = c.v
          }
        }
      }
      // Yield if a car is inside the junction we're approaching.
      if (toEnd < 14 && lane.signal === null) {
        const node = this.graph.nodePos[lane.to]
        for (const o of this.cars) {
          if (o === c || o.lane === lane) continue
          if (o.pos.distanceTo(node) < 7 && o.lane.id !== c.nextLane) {
            const g = toEnd - 8
            if (g < gap) {
              gap = Math.max(0.1, g)
              dv = c.v
            }
          }
        }
      }
      // --- IDM
      const v0 = lane.speed * (c.role === 'bus' ? 0.85 : 1) * (0.9 + (c.model.color % 7) * 0.03)
      const a = c.role === 'bus' ? 0.9 : 1.6
      const b = 2.2
      const s0 = 2.2
      const T = 1.4
      const sStar = s0 + Math.max(0, c.v * T + (c.v * dv) / (2 * Math.sqrt(a * b)))
      let acc = a * (1 - Math.pow(c.v / Math.max(1, v0), 4) - Math.pow(sStar / Math.max(0.1, gap), 2))
      // Slow down for curves at the end of the lane.
      if (c.nextLane >= 0 && toEnd < 20) {
        const nl = this.graph.lanes[c.nextLane]
        const turn = Math.abs(Math.atan2(Math.sin(nl.heading - lane.heading), Math.cos(nl.heading - lane.heading)))
        const vTurn = turn > 0.6 ? 4 : turn > 0.3 ? 7 : 30
        if (c.v > vTurn) acc = Math.min(acc, -1.5)
      }
      if (c.stopTimer > 0) {
        c.stopTimer -= dt
        acc = -4
      }
      c.v = Math.max(0, c.v + Math.max(-8, acc) * dt)
      c.s += c.v * dt
      // Lane transition
      if (c.s > lane.length) {
        if (c.nextLane < 0) {
          this.remove(c)
          continue
        }
        c.s -= lane.length
        c.lane = this.graph.lanes[c.nextLane]
        if (c.route.length && c.route[0] !== c.lane.id) c.route.shift()
        while (c.route.length && c.route[0] !== c.lane.id) c.route.shift()
        c.nextLane = -1
      }
      this.place(c)
      c.wheelSpin += (c.v / c.spec.wheelR) * dt
      for (let i = 0; i < 4; i++) c.model.wheels[i].children[0].rotation.x = -c.wheelSpin
    }
  }

  private place(c: AICar): void {
    this.graph.sample(c.lane, c.s, c.pos, c.tan)
    const root = c.model.root
    root.position.copy(c.pos)
    const yaw = Math.atan2(-c.tan.x, -c.tan.z)
    const pitch = Math.asin(Math.max(-0.3, Math.min(0.3, c.tan.y)))
    root.quaternion.setFromAxisAngle(_up, yaw)
    root.rotateX(pitch)
    if (c.body) {
      c.body.setNextKinematicTranslation({ x: c.pos.x, y: c.pos.y, z: c.pos.z })
      _q.copy(root.quaternion)
      c.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
    }
  }

  /** Nearest vacant taxi within range that could pick up at `p`. */
  hailTaxi(p: Vector3): AICar | null {
    let best: AICar | null = null
    let bd = 120
    for (const c of this.cars) {
      if (c.role !== 'taxi' || !c.vacant || c.hailed) continue
      const ahead = _m.subVectors(p, c.pos)
      const along = ahead.dot(c.tan)
      const d = c.pos.distanceTo(p)
      if (along > 5 && d < bd) {
        bd = d
        best = c
      }
    }
    if (best) best.hailed = true
    return best
  }

  rebase(delta: Matrix4): void {
    this.graph.applyRebase(delta)
    for (const b of this.busStops) b.pos.applyMatrix4(delta)
    for (const c of this.cars) this.place(c)
  }
}
