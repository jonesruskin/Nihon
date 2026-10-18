// A drivable (or AI/parked) vehicle: Rapier raycast-vehicle physics with
// suspension and tyre friction, an engine limited by real power figures,
// brakes, handbrake and speed-sensitive steering.
import type RAPIER from '@dimforge/rapier3d-compat'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Physics } from '../physics/Physics'
import { buildVehicle, type CarSpec, type VehicleModel } from './carGeometry'
import { groups, PLAYER_GROUP, WORLD_GROUP } from '../player/Player'

export const VEHICLE_GROUP = 0x0004

export interface DriveInput {
  throttle: number // 0..1
  brake: number // 0..1
  steer: number // -1 (left) .. 1 (right)
  handbrake: boolean
  reverse: boolean
}

const _q = new Quaternion()
const _v = new Vector3()

export class Vehicle {
  readonly model: VehicleModel
  body!: RAPIER.RigidBody
  collider!: RAPIER.Collider
  private controller!: RAPIER.DynamicRayCastVehicleController
  private steerAngle = 0
  private wheelSpin = [0, 0, 0, 0]
  speed = 0 // signed forward speed m/s
  occupied = false
  engineRpm = 800
  parked = true
  readonly id: number
  private static seq = 1

  constructor(
    private physics: Physics,
    readonly spec: CarSpec,
    color?: number,
    prebuilt?: VehicleModel,
  ) {
    this.model = prebuilt ?? buildVehicle(spec, color)
    this.id = Vehicle.seq++
  }

  get object() {
    return this.model.root
  }

  spawn(position: Vector3, yaw: number): void {
    const R = this.physics.R
    const w = this.physics.world
    const s = this.spec
    const halfH = (s.height - s.clearance) / 2
    this.body = w.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y + s.clearance + halfH + 0.05, position.z)
        .setRotation(_q.setFromAxisAngle(new Vector3(0, 1, 0), yaw))
        .setLinearDamping(0.05)
        .setAngularDamping(0.6)
        .setCanSleep(true),
    )
    // Box slightly narrower than the body; lowered centre of mass for stability.
    const desc = R.ColliderDesc.cuboid(s.width / 2 - 0.04, halfH * 0.9, s.length / 2 - 0.05)
      .setMass(s.mass)
      .setFriction(0.4)
      .setCollisionGroups(groups(VEHICLE_GROUP, WORLD_GROUP | VEHICLE_GROUP | PLAYER_GROUP))
    this.collider = w.createCollider(desc, this.body)
    this.body.setAdditionalMassProperties(0, { x: 0, y: -halfH * 0.6, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, true)
    this.controller = w.createVehicleController(this.body)
    this.controller.indexUpAxis = 1
    this.controller.setIndexForwardAxis = 2
    const axleZ = s.length / 2 - (s.length - s.wheelbase) / 2
    const track = s.width / 2 - s.wheelR * 0.25 - 0.08
    const connY = -halfH + s.wheelR * 0.9 - s.clearance * 0.2
    const rest = 0.22
    const centreY = s.clearance + halfH
    const wheels: Array<[number, number, number]> = s.wheelPos
      ? s.wheelPos.map(([x, y, z]) => [x * 0.96, y - centreY + rest * 0.6, z])
      : [
          [-track, connY + rest * 0.5, -axleZ],
          [track, connY + rest * 0.5, -axleZ],
          [-track, connY + rest * 0.5, axleZ],
          [track, connY + rest * 0.5, axleZ],
        ]
    for (const [x, y, z] of wheels) {
      this.controller.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, rest, s.wheelR)
    }
    const heavy = s.mass > 3000
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelSuspensionStiffness(i, heavy ? 60 : 32)
      this.controller.setWheelSuspensionCompression(i, heavy ? 6 : 4.2)
      this.controller.setWheelSuspensionRelaxation(i, heavy ? 4 : 3)
      this.controller.setWheelMaxSuspensionTravel(i, 0.2)
      this.controller.setWheelMaxSuspensionForce(i, s.mass * 40)
      this.controller.setWheelFrictionSlip(i, 2.3)
      this.controller.setWheelSideFrictionStiffness(i, 1.1)
    }
    this.sync()
  }

  get position(): Vector3 {
    const t = this.body.translation()
    return new Vector3(t.x, t.y, t.z)
  }

  get quaternion(): Quaternion {
    const r = this.body.rotation()
    return new Quaternion(r.x, r.y, r.z, r.w)
  }

  get yaw(): number {
    const f = new Vector3(0, 0, -1).applyQuaternion(this.quaternion)
    return Math.atan2(-f.x, -f.z)
  }

  /** Driver door position (right-hand drive: driver sits on the right). */
  doorPosition(): Vector3 {
    const s = this.spec
    return new Vector3(s.width / 2 + 0.6, 0, s.bus ? -s.length / 2 + 1 : -0.15).applyQuaternion(this.quaternion).add(this.position).setY(this.position.y)
  }

  driverEye(): Vector3 {
    const [x, y, z] = this.spec.driverEye
    const halfH = (this.spec.height - this.spec.clearance) / 2
    return new Vector3(x, y - this.spec.clearance - halfH, z).applyQuaternion(this.quaternion).add(this.position)
  }

  fixedUpdate(h: number, input: DriveInput | null): void {
    if (!this.controller) return
    const s = this.spec
    const vel = this.body.linvel()
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.quaternion)
    this.speed = vel.x * fwd.x + vel.y * fwd.y + vel.z * fwd.z
    const abs = Math.abs(this.speed)
    const inp = input ?? { throttle: 0, brake: this.parked ? 1 : 0.2, steer: 0, handbrake: this.parked, reverse: false }
    // Steering: lock reduces with speed (~35° at walking pace to ~6° at 100 km/h).
    const maxSteer = (0.62 / (1 + abs * 0.045)) * (s.bus ? 0.85 : 1)
    const target = -inp.steer * maxSteer
    this.steerAngle += (target - this.steerAngle) * Math.min(1, h * 6)
    this.controller.setWheelSteering(0, this.steerAngle)
    this.controller.setWheelSteering(1, this.steerAngle)
    // Engine: constant-power curve capped by traction. Force sign: -z forward.
    const power = s.power * 1000
    const maxForce = s.mass * 4.2
    let engine = 0
    if (inp.throttle > 0) {
      const f = Math.min(maxForce, power / Math.max(2, abs))
      engine = (inp.reverse ? -1 : 1) * f * inp.throttle
      if (!inp.reverse && this.speed > s.maxSpeed) engine = 0
      if (inp.reverse && this.speed < -6) engine = 0
    }
    // Front-wheel drive for cars, rear for trucks/bus.
    const driven = s.mass > 3000 || s.id === 'kei_truck' ? [2, 3] : [0, 1]
    for (let i = 0; i < 4; i++) this.controller.setWheelEngineForce(i, driven.includes(i) ? -engine / 2 : 0)
    const brakeForce = inp.brake * s.mass * 0.012
    for (let i = 0; i < 4; i++) this.controller.setWheelBrake(i, brakeForce + (inp.handbrake && i >= 2 ? s.mass * 0.03 : 0))
    if (input) {
      this.parked = false
      this.body.wakeUp()
    }
    this.controller.updateVehicle(h, undefined, groups(VEHICLE_GROUP, WORLD_GROUP))
    this.engineRpm = 800 + Math.min(5500, abs * 140 * (1 + inp.throttle)) // cosmetic
    // brake lights
    const on = inp.brake > 0.05 || (inp.reverse && inp.throttle > 0)
    for (const b of this.model.brakeLights) {
      const m = b.material as unknown as { emissiveIntensity: number }
      m.emissiveIntensity = on ? 3 : 0
    }
  }

  sync(): void {
    const t = this.body.translation()
    const r = this.body.rotation()
    const s = this.spec
    const halfH = (s.height - s.clearance) / 2
    this.model.root.position.set(t.x, t.y, t.z)
    this.model.root.quaternion.set(r.x, r.y, r.z, r.w)
    // Model origin is at ground level; the body centre sits above it.
    this.model.root.translateY(-(s.clearance + halfH))
    if (!this.controller) return
    for (let i = 0; i < 4; i++) {
      const pivot = this.model.wheels[i]
      const susp = this.controller.wheelSuspensionLength(i) ?? 0.11
      const conn = this.controller.wheelChassisConnectionPointCs(i)
      if (conn) pivot.position.y = conn.y - susp + s.clearance + halfH
      pivot.rotation.y = i < 2 ? this.steerAngle : 0
      this.wheelSpin[i] += (this.speed / s.wheelR) * (1 / 60)
      pivot.children[0].rotation.x = -this.wheelSpin[i]
    }
  }

  rebase(delta: Matrix4): void {
    const p = this.position.applyMatrix4(delta)
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
    const q = new Quaternion().setFromRotationMatrix(delta).multiply(this.quaternion)
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
  }

  dispose(): void {
    if (this.controller) this.physics.world.removeVehicleController(this.controller)
    if (this.body) this.physics.world.removeRigidBody(this.body)
    this.model.root.removeFromParent()
  }
}
