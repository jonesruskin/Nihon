// The player on foot: Rapier kinematic character controller with walking,
// running, sprinting, jumping, stairs (auto-step) and slope limits.
import type RAPIER from '@dimforge/rapier3d-compat'
import { Matrix4, Object3D, Vector3 } from 'three'
import type { Physics } from '../physics/Physics'
import type { Input } from './Input'

export const PLAYER_GROUP = 0x0002
export const WORLD_GROUP = 0x0001
export const VEHICLE_BIT = 0x0004
/** Rapier interaction groups: (membership << 16) | filter. */
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff)

export type Gait = 'idle' | 'walk' | 'run' | 'sprint'

export class Player {
  readonly object = new Object3D()
  body!: RAPIER.RigidBody
  collider!: RAPIER.Collider
  private controller!: RAPIER.KinematicCharacterController
  readonly velocity = new Vector3()
  /** Facing of the body (radians, 0 = north/-z). */
  heading = 0
  /** Camera yaw/pitch drive the movement frame. */
  yaw = 0
  pitch = -0.1
  grounded = false
  gait: Gait = 'idle'
  speed = 0
  enabled = true
  /** Can the player stand at this world (x, z)? (The shoreline.) */
  canEnter: ((x: number, z: number) => boolean) | null = null
  readonly radius = 0.28
  readonly halfHeight = 0.58
  private airTime = 0
  // Average Japanese walking pace in cities is fast: ~1.4–1.6 m/s.
  walkSpeed = 1.45
  runSpeed = 3.6
  sprintSpeed = 6.2

  constructor(private physics: Physics) {}

  spawn(at: Vector3): void {
    const R = this.physics.R
    const world = this.physics.world
    if (this.body) world.removeRigidBody(this.body)
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y + this.halfHeight + this.radius, at.z))
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(this.halfHeight, this.radius).setCollisionGroups(groups(PLAYER_GROUP, WORLD_GROUP | VEHICLE_BIT)),
      this.body,
    )
    this.controller = world.createCharacterController(0.03)
    this.controller.enableAutostep(0.4, 0.25, true) // kerbs and stairs
    this.controller.enableSnapToGround(0.45)
    this.controller.setMaxSlopeClimbAngle((48 * Math.PI) / 180)
    this.controller.setMinSlopeSlideAngle((55 * Math.PI) / 180)
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.velocity.set(0, 0, 0)
    this.syncObject()
  }

  /** Feet position in world space. */
  get feet(): Vector3 {
    const t = this.body.translation()
    return new Vector3(t.x, t.y - this.halfHeight - this.radius, t.z)
  }

  teleport(feet: Vector3): void {
    this.body.setTranslation({ x: feet.x, y: feet.y + this.halfHeight + this.radius, z: feet.z }, true)
    this.body.setNextKinematicTranslation({ x: feet.x, y: feet.y + this.halfHeight + this.radius, z: feet.z })
    this.velocity.set(0, 0, 0)
    this.syncObject()
  }

  /** Apply a floating-origin rebase transform. */
  rebase(delta: Matrix4): void {
    const f = this.feet.applyMatrix4(delta)
    this.teleport(f)
  }

  fixedUpdate(h: number, input: Input): void {
    if (!this.enabled || !this.body) return
    const ax = input.axes()
    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight') || input.gamepadButton(10)
    const walkMod = input.isDown('AltLeft') || input.isDown('KeyC')
    const moving = Math.hypot(ax.moveX, ax.moveY) > 0.05
    const target = !moving ? 0 : sprint ? (input.isDown('KeyX') ? this.sprintSpeed : this.runSpeed) : walkMod ? this.walkSpeed * 0.6 : this.walkSpeed
    // movement direction from camera yaw
    const fx = -Math.sin(this.yaw)
    const fz = -Math.cos(this.yaw)
    const rx = Math.cos(this.yaw)
    const rz = -Math.sin(this.yaw)
    let dx = fx * ax.moveY + rx * ax.moveX
    let dz = fz * ax.moveY + rz * ax.moveX
    const dl = Math.hypot(dx, dz)
    if (dl > 1e-4) {
      dx /= dl
      dz /= dl
    }
    const mag = Math.min(1, Math.hypot(ax.moveX, ax.moveY))
    // Accelerate horizontally (humans reach walking speed in ~0.5 s).
    const accel = this.grounded ? 9 : 2
    const tvx = dx * target * mag
    const tvz = dz * target * mag
    this.velocity.x += (tvx - this.velocity.x) * Math.min(1, accel * h)
    this.velocity.z += (tvz - this.velocity.z) * Math.min(1, accel * h)
    // Gravity / jump
    if (this.grounded) {
      this.velocity.y = -1
      this.airTime = 0
      if (input.hit('Space') || input.gamepadButton(0)) this.velocity.y = 4.2
    } else {
      this.airTime += h
      this.velocity.y = Math.max(-50, this.velocity.y - 9.81 * h)
    }
    const desired = { x: this.velocity.x * h, y: this.velocity.y * h, z: this.velocity.z * h }
    this.controller.computeColliderMovement(this.collider, desired, undefined, groups(PLAYER_GROUP, WORLD_GROUP | VEHICLE_BIT))
    const mv = { ...this.controller.computedMovement() }
    const t = this.body.translation()
    // The shoreline: wade into the shallows, but no walking out over the
    // seabed (unless you are already out there and heading back).
    if (this.canEnter && (mv.x || mv.z) && !this.canEnter(t.x + mv.x, t.z + mv.z) && this.canEnter(t.x, t.z)) {
      mv.x = 0
      mv.z = 0
    }
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z })
    this.grounded = this.controller.computedGrounded()
    if (this.grounded && this.velocity.y > 0 && this.airTime < 0.05) this.grounded = false
    // Real horizontal speed (blocked by walls -> slower).
    const sp = Math.hypot(mv.x, mv.z) / h
    this.speed += (sp - this.speed) * Math.min(1, 10 * h)
    this.gait = this.speed < 0.2 ? 'idle' : this.speed < 2.2 ? 'walk' : this.speed < 4.8 ? 'run' : 'sprint'
    if (sp > 0.3) {
      const want = Math.atan2(-mv.x, -mv.z)
      let d = want - this.heading
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      this.heading += d * Math.min(1, 10 * h)
    }
    // Fell through the world (data gap): recover above ground.
    if (t.y < -200) this.velocity.set(0, 0, 0)
  }

  syncObject(): void {
    if (!this.body) return
    const f = this.feet
    this.object.position.copy(f)
    this.object.rotation.set(0, this.heading, 0)
  }
}
