// AI traffic on the real road network: Intelligent Driver Model car
// following, signals at major junctions, yielding at busy junctions, taxis
// that can be hailed and buses that dwell at real bus stops.
import type RAPIER from '@dimforge/rapier3d-compat'
import { Color, Group, Mesh, Quaternion, Vector3, type Matrix4 } from 'three'
import type { Physics } from '../physics/Physics'
import type { VectorManager } from '../world/vector/VectorManager'
import { RoadGraph, type Lane } from './RoadGraph'
import { buildVehicle, specById, vehicleFromScene, type CarSpec, type VehicleModel } from './carGeometry'
import { FarTraffic, lampGeometry } from './FarTraffic'
import type { DynamicLamp } from '../render/NightLights'
import { mergeInto, modelLibrary } from '../world/props/ModelLibrary'
import { groups, WORLD_GROUP, PLAYER_GROUP } from '../player/Player'
import { VEHICLE_GROUP } from './Vehicle'

export type AIRole = 'car' | 'taxi' | 'bus'

export class AICar {
  s = 0
  v = 0
  /** Which of the lane's parallel lanes (0 = nearest the centreline). */
  sub = 0
  /** Full textured model, only while near the camera (null = far LOD). */
  model: VehicleModel | null = null
  loading = false
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
    public spec: CarSpec,
    public lane: Lane,
    readonly role: AIRole,
    readonly modelId: string | null,
    readonly color: number,
  ) {}

  get length(): number {
    return this.spec.length
  }
}

const _q = new Quaternion()
const HEADLAMP = new Color(1, 0.95, 0.86)
/** Everyday Japanese car colours: white, pearl, silver, black, grey dominate. */
const DEFAULT_COLORS = [0xf2f2f0, 0xf2f2f0, 0xe9e7e0, 0xb9bdc2, 0x8d9297, 0x15161a, 0x2b2e33, 0x5b1f24, 0x1d2b46, 0x6a7b5a]
const _up = new Vector3(0, 1, 0)
const _m = new Vector3()

/** Cars per km of lane at a typical daytime hour (Tokyo-area counts). */
const PER_KM: Record<string, number> = { motorway: 40, trunk: 36, primary: 30, secondary: 20, tertiary: 11, minor: 3, busway: 4, service: 0, track: 0 }
/** Full models within this distance (a scanned car is 20-40 draw calls); instanced bodies beyond. */
const NEAR = 55
const MAX_NEAR = 8
/** Simulated traffic disc around the player (m). */
const RADIUS = 195

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
  /** Bus stops (world positions) from OSM POIs, refreshed with the graph. */
  busStops: Array<{ pos: Vector3; name: string }> = []
  density = 1
  time = 0
  private ring: Lane[] = []
  /** Arc-length span [lo, hi] of each ring lane that lies inside the disc. */
  private ringSpan: number[] = []
  private ringTime = -10
  /** Obstacles AI must not hit: the player on foot / the player's car. */
  playerPos: Vector3 | null = null
  playerCar: { pos: Vector3; length: number } | null = null
  /** Where the camera is and looks (full models near it; spawns out of its view). */
  camPos = new Vector3()
  camDir = new Vector3(0, 0, -1)
  /** Quality tier cap on simulated vehicles. */
  cap = 140
  night = 0
  private far: FarTraffic
  private laneKm = 0
  private ringWeights: number[] = []
  private ringTotal = 0
  private pool = new Map<string, VehicleModel[]>()
  /** Head lamps of the nearest cars, fed to the shader-lamp pool. */
  readonly headlamps: DynamicLamp[] = []

  constructor(
    private physics: Physics,
    private vector: VectorManager,
  ) {
    this.root.name = 'traffic'
    this.far = new FarTraffic(this.root)
  }

  /**
   * Target number of AI vehicles: real-world density per km of lane within
   * the spawn ring, by road class, times the hour's traffic level.
   */
  targetCount(): number {
    return Math.round(Math.min(this.cap, Math.max(2, this.laneKm)) * this.density)
  }

  update(dt: number, center: Vector3, timeOfDayH: number): void {
    this.time += dt
    this.rebuildTimer += dt
    // Rebuild as tiles arrive (every few seconds), and at once on arrival so
    // the streets are never empty for the first seconds.
    if (this.rebuildTimer > 3 || (!this.graph.lanes.length && this.vector.readyTiles.length)) {
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
    this.ring = [] // the old lanes are gone: rebuild the spawn ring next tick
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
        c.sub = Math.min(c.sub, hit.lane.lanes - 1)
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
    // Traffic is simulated where it can be seen: a disc around the player,
    // recycled as cars leave it (the far LOD makes the edge invisible).
    for (const c of [...this.cars]) if (c.pos.distanceTo(center) > RADIUS + 60 && !c.passengerAboard && !c.hailed) this.remove(c)
    if (!this.graph.lanes.length) return
    // Lanes through the spawn ring, weighted by how much traffic they carry
    // (refreshed every few seconds): arterials fill up, side streets don't.
    if (this.time - this.ringTime > 3 || !this.ring.length) {
      this.ringTime = this.time
      this.ring = []
      this.ringSpan = []
      this.ringWeights = []
      this.ringTotal = 0
      let km = 0
      for (const l of this.graph.lanes) {
        if (l.length < 20) continue
        const perKm = (PER_KM[l.cls] ?? 2) * l.lanes
        if (perKm <= 0) continue
        // Only the part of the lane inside the disc counts: a long arterial
        // crossing it carries traffic even when its midpoint lies outside.
        let inside = 0
        let dMin = Infinity
        let sLo = Infinity
        let sHi = 0
        for (let i = 1; i < l.pts.length; i++) {
          _m.addVectors(l.pts[i - 1], l.pts[i]).multiplyScalar(0.5)
          const d = _m.distanceTo(center)
          if (d > RADIUS) continue
          inside += l.cum[i] - l.cum[i - 1]
          dMin = Math.min(dMin, d)
          sLo = Math.min(sLo, l.cum[i - 1])
          sHi = Math.max(sHi, l.cum[i])
        }
        if (inside < 10) continue
        const real = perKm * (inside / 1000)
        km += real
        // Denser toward the player, where it's seen; thinner at the edge.
        const w = real * (1.5 - dMin / RADIUS)
        this.ring.push(l)
        this.ringSpan.push(sLo, sHi)
        this.ringTotal += w
        this.ringWeights.push(this.ringTotal)
      }
      this.laneKm = km
    }
    const want = this.targetCount()
    if (this.cars.length >= want || !this.ring.length) return
    // Arriving somewhere (start, teleport, a station exit): fill the streets
    // at once instead of waiting for cars to drive in from the edge.
    const filling = this.cars.length < want * 0.5
    const minD = filling ? 25 : 30
    for (let tries = 0; tries < (filling ? 80 : 8) && this.cars.length < want; tries++) {
      const r = Math.random() * this.ringTotal
      let lo = 0
      let hi = this.ringWeights.length - 1
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (this.ringWeights[m] < r) lo = m + 1
        else hi = m
      }
      const lane = this.ring[lo]
      const s = this.ringSpan[lo * 2] + Math.random() * (this.ringSpan[lo * 2 + 1] - this.ringSpan[lo * 2])
      const p = new Vector3()
      const t = new Vector3()
      this.graph.sample(lane, s, p, t)
      const d = p.distanceTo(center)
      if (d < minD || d > RADIUS) continue
      // Never pop into view nearby: close spawns only behind the camera.
      if (!filling && d < 90 && _m.subVectors(p, this.camPos).normalize().dot(this.camDir) > -0.2) continue
      const sub = Math.floor(Math.random() * lane.lanes)
      if (this.cars.some((c) => c.lane === lane && c.sub === sub && Math.abs(c.s - s) < 14)) continue
      const roll = Math.random()
      const major = ['primary', 'secondary', 'trunk', 'tertiary'].includes(lane.cls)
      const role: AIRole = major && roll < 0.06 ? 'bus' : roll < (major ? 0.2 : 0.08) ? 'taxi' : 'car'
      this.spawn(lane, s, sub, role)
    }
  }

  private spawn(lane: Lane, s: number, sub: number, role: AIRole): void {
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
    // Classes without a scanned model (compact, minivan) use the parametric body.
    const modelId = base.models?.length ? base.models[Math.floor(Math.random() * base.models.length)] : null
    const palette = base.colors.length ? base.colors : DEFAULT_COLORS
    const color = palette[Math.floor(Math.random() * palette.length)]
    const car = new AICar(base, lane, role, modelId, color)
    car.s = s
    car.sub = Math.min(sub, lane.lanes - 1)
    car.v = lane.speed * 0.8
    car.vacant = role === 'taxi' ? Math.random() < 0.6 : false
    this.place(car)
    this.cars.push(car)
  }

  /** Swap cars between the full model (near the camera) and the instanced far LOD. */
  private updateLod(): void {
    // Attached models keep theirs a little further out (no flapping at the
    // edge), but never more than MAX_NEAR at once.
    const near = this.cars
      .filter((c) => c.pos.distanceTo(this.camPos) < (c.model ? NEAR + 15 : NEAR) || c.passengerAboard)
      .sort((a, b) => a.pos.distanceToSquared(this.camPos) - b.pos.distanceToSquared(this.camPos))
    const keep = new Set(near.slice(0, MAX_NEAR))
    let loads = 0
    // Shadows from the 5 nearest cars within 28 m only, and never from wheels
    // (each wheel is its own draw call; the body's shadow covers them).
    const casters = new Set(near.filter((c) => c.pos.distanceTo(this.camPos) < 28).slice(0, 5))
    for (const c of this.cars) {
      if (c.model) {
        const cast = casters.has(c)
        if (c.model.root.userData.cast !== cast) {
          c.model.root.userData.cast = cast
          c.model.root.traverse((o) => {
            const m = o as Mesh
            if (!m.isMesh) return
            let wheel = false
            for (let p: typeof o | null = o; p && !wheel; p = p.parent) wheel = /^wheel_/i.test(p.name)
            m.castShadow = cast && !wheel && o.name !== 'lamps'
          })
        }
      }
      const want = keep.has(c) || c.passengerAboard || c.hailed
      if (want && !c.model && !c.loading && loads < 3) {
        loads++
        void this.attachModel(c)
      } else if (!want && c.model) this.detachModel(c)
    }
  }

  private async attachModel(c: AICar): Promise<void> {
    c.loading = true
    try {
      const key = `${c.modelId ?? c.spec.id}:${c.color}`
      let model = this.pool.get(key)?.pop() ?? null
      if (!model) {
        if (c.modelId) {
          const scene = await modelLibrary.clone(c.modelId)
          model = vehicleFromScene(c.spec, scene, c.spec.colors.length ? c.color : undefined).model
        } else {
          // Parametric body: lights, plates and trim are separate meshes;
          // merge the static ones per material (wheels spin, so stay apart).
          model = buildVehicle(c.spec, c.color)
          const m = model
          mergeInto(m.root, (o) => o.parent === m.root && o !== m.body && !m.brakeLights.includes(o))
        }
        const lamps = new Mesh(lampGeometry(model.spec), this.far.lampMat)
        lamps.name = 'lamps'
        model.root.add(lamps)
        model.root.userData.poolKey = key
      }
      if (!this.cars.includes(c)) {
        this.release(model)
        return
      }
      c.model = model
      c.spec = model.spec
      // Kinematic collider so the player's car and the player collide with traffic.
      const R = this.physics.R
      c.body = this.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased())
      this.physics.world.createCollider(
        R.ColliderDesc.cuboid(c.spec.width / 2 - 0.05, c.spec.height / 2 - 0.1, c.spec.length / 2 - 0.05)
          .setTranslation(0, c.spec.height / 2, 0)
          .setCollisionGroups(groups(VEHICLE_GROUP, WORLD_GROUP | VEHICLE_GROUP | PLAYER_GROUP)),
        c.body,
      )
      this.root.add(model.root)
      this.place(c)
    } catch (e) {
      console.warn('vehicle model failed', c.modelId, e)
    } finally {
      c.loading = false
    }
  }

  private detachModel(c: AICar): void {
    if (c.model) this.release(c.model)
    c.model = null
    if (c.body) this.physics.world.removeRigidBody(c.body)
    c.body = null
  }

  private release(model: VehicleModel): void {
    model.root.removeFromParent()
    const key = model.root.userData.poolKey as string
    const list = this.pool.get(key) ?? []
    if (list.length < 4) list.push(model)
    this.pool.set(key, list)
  }

  remove(c: AICar): void {
    const i = this.cars.indexOf(c)
    if (i >= 0) this.cars.splice(i, 1)
    this.detachModel(c)
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
    const key = (lane: number, sub: number) => lane * 4 + sub
    for (const c of this.cars) {
      const k = key(c.lane.id, c.sub)
      if (!byLane.has(k)) byLane.set(k, [])
      byLane.get(k)!.push(c)
    }
    for (const arr of byLane.values()) arr.sort((a, b) => a.s - b.s)
    for (const c of [...this.cars]) {
      const lane = c.lane
      if (c.nextLane < 0) c.nextLane = this.chooseNext(c)
      // --- gap to the obstacle ahead
      let gap = 1e4
      let dv = 0
      const same = byLane.get(key(lane.id, c.sub))!
      const idx = same.indexOf(c)
      if (idx + 1 < same.length) {
        const lead = same[idx + 1]
        gap = lead.s - c.s - (lead.length + c.length) / 2
        dv = c.v - lead.v
      } else if (c.nextLane >= 0) {
        const nxt = byLane.get(key(c.nextLane, Math.min(c.sub, this.graph.lanes[c.nextLane].lanes - 1)))
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
      const v0 = lane.speed * (c.role === 'bus' ? 0.85 : 1) * (0.9 + (c.color % 7) * 0.03)
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
        // Merging into fewer lanes keeps the outermost that exists; widening, a
        // few drivers move over.
        c.sub = Math.min(c.lane.lanes - 1, c.sub + (c.lane.lanes > lane.lanes && Math.random() < 0.4 ? 1 : 0))
        if (c.route.length && c.route[0] !== c.lane.id) c.route.shift()
        while (c.route.length && c.route[0] !== c.lane.id) c.route.shift()
        c.nextLane = -1
      }
      this.place(c)
      c.wheelSpin += (c.v / c.spec.wheelR) * dt
      if (c.model) for (let i = 0; i < 4; i++) c.model.wheels[i].children[0].rotation.x = -c.wheelSpin
    }
    this.updateLod()
    // Far LOD and the head lamps of the nearest cars.
    this.far.begin(this.night)
    this.headlamps.length = 0
    let lamps = 0
    const byDist = this.night > 0.05 ? [...this.cars].sort((a, b) => a.pos.distanceToSquared(this.camPos) - b.pos.distanceToSquared(this.camPos)) : this.cars
    for (const c of byDist) {
      if (!c.model) this.far.add(c.spec.id, c.pos, c.tan, c.color)
      if (this.night > 0.05 && lamps < 6 && c.pos.distanceTo(this.camPos) < 120) {
        const l = (this.lampPool[lamps] ??= { pos: new Vector3(), dir: new Vector3(), color: HEADLAMP, intensity: 70, range: 34, outer: 0.55, inner: 0.25 })
        l.pos.copy(c.pos).addScaledVector(c.tan, c.spec.length / 2 + 0.2)
        l.pos.y += 0.7
        l.dir.copy(c.tan).setY(c.tan.y - 0.12).normalize()
        this.headlamps.push(l)
        lamps++
      }
    }
    this.far.end()
  }

  private lampPool: DynamicLamp[] = []

  private place(c: AICar): void {
    this.graph.sample(c.lane, c.s, c.pos, c.tan)
    if (c.sub > 0) {
      // Parallel lanes lie further to the left (Japan drives on the left).
      const l = Math.hypot(c.tan.x, c.tan.z) || 1
      c.pos.x += (c.tan.z / l) * c.sub * c.lane.width
      c.pos.z += (-c.tan.x / l) * c.sub * c.lane.width
    }
    if (!c.model) return
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
