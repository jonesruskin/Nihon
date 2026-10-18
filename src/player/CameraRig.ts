// First- and third-person camera. Third person uses a collision-aware spring
// arm (never clips into buildings); first person adds subtle, physically
// motivated head bob tied to gait.
import type RAPIER from '@dimforge/rapier3d-compat'
import { MathUtils, Vector3, type PerspectiveCamera } from 'three'
import type { Physics } from '../physics/Physics'

export type CameraMode = 'first' | 'third'

export interface RigTarget {
  /** Eye/pivot position in world space. */
  pivot: Vector3
  /** Collider to ignore for arm collision. */
  exclude?: RAPIER.Collider
  /** Speed (m/s) for bob and FOV kick. */
  speed: number
  /** Step frequency (Hz) for head bob; 0 = none. */
  stepHz: number
  /** Preferred third-person distance. */
  distance: number
  /** Side offset for over-the-shoulder. */
  shoulder: number
}

export class CameraRig {
  mode: CameraMode = 'third'
  yaw = 0
  pitch = -0.12
  distance = 3.4
  private armLen = 3.4
  private bobPhase = 0
  private smoothPivot = new Vector3()
  private initialized = false
  baseFov = 62
  minPitch = -1.45
  maxPitch = 1.35

  constructor(
    private camera: PerspectiveCamera,
    private physics: Physics,
  ) {
    camera.rotation.order = 'YXZ'
  }

  toggle(): void {
    this.mode = this.mode === 'first' ? 'third' : 'first'
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx
    this.pitch = MathUtils.clamp(this.pitch - dy, this.minPitch, this.maxPitch)
  }

  zoom(steps: number): void {
    this.distance = MathUtils.clamp(this.distance + steps * 0.5, 1.2, 14)
  }

  snap(): void {
    this.initialized = false
  }

  update(dt: number, t: RigTarget): void {
    const cam = this.camera
    if (!this.initialized) {
      this.smoothPivot.copy(t.pivot)
      this.armLen = this.distance
      this.initialized = true
    }
    // Pivot smoothing removes kinematic stair-step jitter but stays tight.
    this.smoothPivot.lerp(t.pivot, 1 - Math.exp(-dt * 25))
    cam.rotation.set(this.pitch, this.yaw, 0)
    if (this.mode === 'first') {
      this.bobPhase += dt * t.stepHz * Math.PI * 2
      const amp = Math.min(1, t.speed / 3) * 0.035
      cam.position.copy(this.smoothPivot)
      cam.position.y += Math.abs(Math.sin(this.bobPhase)) * amp - amp * 0.5
      const side = Math.cos(this.bobPhase) * amp * 0.5
      cam.position.x += Math.cos(this.yaw) * side
      cam.position.z -= Math.sin(this.yaw) * side
      cam.rotation.z = Math.cos(this.bobPhase) * amp * 0.15
    } else {
      const want = Math.max(t.distance * (this.distance / 3.4), 1.0)
      const back = new Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch))
      const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
      const origin = this.smoothPivot.clone().addScaledVector(right, t.shoulder)
      const hit = this.physics.ready ? this.physics.ray(origin, back, want + 0.3, t.exclude) : null
      const allowed = hit !== null ? Math.max(0.3, hit - 0.25) : want
      // Pull in fast (avoid clipping), ease out slowly.
      this.armLen = allowed < this.armLen ? allowed : this.armLen + (allowed - this.armLen) * Math.min(1, dt * 3)
      cam.position.copy(origin).addScaledVector(back, this.armLen)
    }
    const fov = this.baseFov + Math.min(10, Math.max(0, t.speed - 6) * 0.25)
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4)
      cam.updateProjectionMatrix()
    }
  }
}
