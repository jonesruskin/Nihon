// Parked cars along real streets around the player, entering/exiting, and
// the driving loop. Japan drives on the left, so cars park on the left kerb
// and the driver's door is on the right.
import { Group, Vector3 } from 'three'
import type { Physics } from '../physics/Physics'
import type { VectorManager } from '../world/vector/VectorManager'
import { Vehicle, type DriveInput } from './Vehicle'
import { specById, vehicleFromScene, type CarSpec } from './carGeometry'
import { modelLibrary } from '../world/props/ModelLibrary'
import type { Input } from '../player/Input'

// Japan's fleet: ~40% of cars are kei class; vans and minivans are everywhere.
const PARKED_MIX: Array<[string, number]> = [
  ['kei_car', 0.26],
  ['kei_truck_m', 0.1],
  ['kei_van', 0.06],
  ['sedan_m', 0.16],
  ['compact', 0.1],
  ['minivan', 0.1],
  ['light_truck_m', 0.08],
  ['taxi_m', 0.08],
  ['pickup_m', 0.06],
]

function pickSpec(r: number): string {
  let acc = 0
  for (const [id, p] of PARKED_MIX) {
    acc += p
    if (r < acc) return id
  }
  return 'compact'
}

export class VehicleManager {
  readonly root = new Group()
  readonly vehicles: Vehicle[] = []
  current: Vehicle | null = null
  private spawnTimer = 0
  private usedSpots = new Set<string>()
  maxParked = 16

  constructor(
    private physics: Physics,
    private vector: VectorManager,
  ) {
    this.root.name = 'vehicles'
  }

  /** Keep a handful of parked cars on nearby streets. */
  update(dt: number, center: Vector3): void {
    this.spawnTimer += dt
    if (this.spawnTimer < 1.5 || !this.physics.ready) return
    this.spawnTimer = 0
    // Despawn far, unoccupied vehicles.
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i]
      if (v === this.current) continue
      if (v.position.distanceTo(center) > 380) {
        v.dispose()
        this.vehicles.splice(i, 1)
      }
    }
    if (this.vehicles.length + this.pending >= this.maxParked) return
    const candidates: Array<{ p: Vector3; yaw: number; key: string; width: number }> = []
    for (const t of this.vector.readyTiles) {
      t.group.updateWorldMatrix(true, false)
      const m = t.group.matrixWorld
      for (const path of t.build.paths) {
        if (path.kind !== 'road' || path.bridge || !['minor', 'service', 'tertiary'].includes(path.cls)) continue
        const pts = path.pts
        for (let i = 3; i + 3 < pts.length; i += 3) {
          // one candidate every ~7 points (~40 m)
          if ((i / 3) % 7 !== 3) continue
          const a = new Vector3(pts[i - 3], pts[i - 2], pts[i - 1]).applyMatrix4(m)
          const b = new Vector3(pts[i + 3], pts[i + 4], pts[i + 5]).applyMatrix4(m)
          const mid = new Vector3(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(m)
          const d = mid.distanceTo(center)
          if (d < 25 || d > 160) continue
          const dir = b.clone().sub(a).setY(0).normalize()
          const key = `${t.key}:${path.name}:${i}:${Math.round(mid.x)}:${Math.round(mid.z)}`
          if (this.usedSpots.has(key)) continue
          candidates.push({ p: mid, yaw: Math.atan2(-dir.x, -dir.z), key, width: path.width })
        }
      }
    }
    candidates.sort(() => Math.random() - 0.5)
    for (const c of candidates.slice(0, Math.min(4, this.maxParked - this.vehicles.length))) {
      const spec = specById(pickSpec(Math.random()))
      if (c.width < spec.width * 2.2 && spec.mass > 3000) continue
      // Left kerb relative to the direction of travel.
      const left = new Vector3(-Math.cos(c.yaw), 0, Math.sin(c.yaw))
      const offset = Math.max(0, c.width / 2 - spec.width / 2 - 0.25)
      const at = c.p.clone().addScaledVector(left, offset)
      const ground = this.physics.groundBelow(at.x, at.y + 4, at.z, 10)
      if (ground === null) continue
      at.y = ground
      // Avoid overlapping other cars.
      if (this.vehicles.some((v) => v.position.distanceTo(at) < 7)) continue
      this.usedSpots.add(c.key)
      void this.create(spec, at, c.yaw)
    }
  }

  nearestEnterable(pos: Vector3, maxDist = 2.6): Vehicle | null {
    let best: Vehicle | null = null
    let bd = maxDist
    for (const v of this.vehicles) {
      const d = v.doorPosition().distanceTo(pos)
      if (d < bd && Math.abs(v.speed) < 1) {
        bd = d
        best = v
      }
    }
    return best
  }

  enter(v: Vehicle): void {
    this.current = v
    v.occupied = true
    v.parked = false
  }

  exit(): Vector3 | null {
    const v = this.current
    if (!v) return null
    v.occupied = false
    v.parked = true
    this.current = null
    return v.doorPosition()
  }

  driveInput(input: Input): DriveInput {
    const ax = input.axes()
    const v = this.current!
    let throttle = Math.max(0, ax.moveY)
    let brake = Math.max(0, -ax.moveY)
    let reverse = false
    // Holding brake when (almost) stopped engages reverse, like most games.
    if (brake > 0 && v.speed < 0.6) {
      reverse = true
      throttle = brake
      brake = 0
    }
    if (reverse && ax.moveY >= 0) reverse = false
    return { throttle, brake, steer: ax.moveX, handbrake: input.isDown('Space'), reverse }
  }

  fixedUpdate(h: number, input: Input): void {
    for (const v of this.vehicles) v.fixedUpdate(h, v === this.current ? this.driveInput(input) : null)
  }

  sync(): void {
    for (const v of this.vehicles) v.sync()
  }

  rebase(delta: import('three').Matrix4): void {
    for (const v of this.vehicles) v.rebase(delta)
  }

  /** Spawn a specific vehicle right next to a point (rental counter, debug). */
  spawnAt(id: string, at: Vector3, yaw: number): Promise<Vehicle> {
    return this.create(specById(id), at, yaw)
  }

  private pending = 0

  /** Build from a real model when the spec has one, else procedurally. */
  private async create(base: CarSpec, at: Vector3, yaw: number): Promise<Vehicle> {
    this.pending++
    try {
      let v: Vehicle
      if (base.models?.length) {
        const id = base.models[Math.floor(Math.random() * base.models.length)]
        const scene = await modelLibrary.clone(id)
        const color = base.colors.length ? base.colors[Math.floor(Math.random() * base.colors.length)] : undefined
        const { model, spec } = vehicleFromScene(base, scene, color)
        v = new Vehicle(this.physics, spec, color, model)
      } else v = new Vehicle(this.physics, base)
      v.spawn(at, yaw)
      this.root.add(v.object)
      this.vehicles.push(v)
      return v
    } finally {
      this.pending--
    }
  }
}
