// Night lighting from the real street furniture around the player.
//
// Every street lamp, pole-mounted 防犯灯 (security LED) and vending machine
// that the world builder places is registered here as a light *source*. Each
// frame a fixed pool of real SpotLights is assigned to the sources nearest
// the camera, so the asphalt gets genuine light pools with specular glints
// on cars and wet roads, without paying for thousands of lights. Sources
// beyond the pool still glow through their emissive heads and bloom.
import { Color, HemisphereLight, Matrix4, Object3D, SpotLight, Vector3, type Scene } from 'three'

/** Source kinds, stored in the 5th float of each record. */
export const LAMP = { street: 0, pole: 1, vending: 2 } as const

interface Spec {
  intensity: number // candela
  angle: number
  penumbra: number
  distance: number
  color: Color
}

const SPECS: Spec[] = [
  { intensity: 32, angle: 1.0, penumbra: 0.75, distance: 38, color: new Color(1.0, 0.93, 0.84) }, // LED street lamp
  { intensity: 10, angle: 0.9, penumbra: 0.8, distance: 22, color: new Color(0.95, 0.97, 1.0) }, // pole security LED
  { intensity: 4, angle: 1.3, penumbra: 0.9, distance: 9, color: new Color(0.92, 0.97, 1.0) }, // vending machine glow
]

interface Slot {
  light: SpotLight
  key: string
  level: number // fade 0..1
}

export class NightLights {
  /** STRIDE floats per source: local x, y, z, yaw, kind (group-local coords). */
  static readonly STRIDE = 5
  private sources = new Map<Object3D, Float32Array>()
  private slots: Slot[] = []
  private fill: HemisphereLight
  private lastPick = 0
  private picked: { key: string; p: Vector3; dir: Vector3; kind: number; d: number }[] = []
  /** 0 = countryside, 1 = dense city: drives sky glow and ambient fill. */
  urban = 0

  constructor(private scene: Scene) {
    // Scattered city light (light pollution bouncing off haze and walls).
    this.fill = new HemisphereLight(0x8a7a6a, 0x3a3028, 0)
    scene.add(this.fill)
  }

  setPoolSize(n: number): void {
    while (this.slots.length > n) {
      const s = this.slots.pop()!
      this.scene.remove(s.light, s.light.target)
      s.light.dispose()
    }
    while (this.slots.length < n) {
      const light = new SpotLight(0xffffff, 0, 30, 1, 0.7, 2)
      light.castShadow = false
      this.scene.add(light, light.target)
      this.slots.push({ light, key: '', level: 0 })
    }
  }

  register(owner: Object3D, data: Float32Array): void {
    if (data.length) this.sources.set(owner, data)
  }

  unregister(owner: Object3D): void {
    this.sources.delete(owner)
  }

  private m = new Matrix4()

  update(dt: number, camera: Vector3, night: number, now = performance.now()): void {
    const S = NightLights.STRIDE
    if (now - this.lastPick > 250) {
      this.lastPick = now
      const out: typeof this.picked = []
      let near = 0
      for (const [owner, data] of this.sources) {
        if (!owner.parent) continue
        this.m.copy(owner.matrixWorld)
        for (let i = 0; i < data.length; i += S) {
          const p = new Vector3(data[i], data[i + 1], data[i + 2]).applyMatrix4(this.m)
          const d = p.distanceTo(camera)
          if (d < 300 && data[i + 4] !== LAMP.vending) near++
          if (d > 140) continue
          const yaw = data[i + 3]
          const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).transformDirection(this.m)
          out.push({ key: `${owner.id}:${i}`, p, dir, kind: data[i + 4], d })
        }
      }
      out.sort((a, b) => a.d - b.d)
      this.picked = out.slice(0, this.slots.length)
      // ~120 lamps within 300 m is a lit urban street grid.
      this.urban = Math.min(1, near / 120)
    }

    const want = new Map(this.picked.map((p, rank) => [p.key, { ...p, rank }]))
    const free: Slot[] = []
    for (const s of this.slots) {
      if (!want.has(s.key)) free.push(s)
      else want.delete(s.key)
    }
    // Unclaimed sources go into free slots (replacing far ones).
    for (const p of want.values()) {
      const s = free.pop()
      if (!s) break
      s.key = p.key
      s.level = 0
      const spec = SPECS[p.kind] ?? SPECS[0]
      s.light.color.copy(spec.color)
      s.light.angle = spec.angle
      s.light.penumbra = spec.penumbra
      s.light.distance = spec.distance
      s.light.position.copy(p.p)
      if (p.kind === LAMP.vending) {
        s.light.position.addScaledVector(p.dir, 0.4).y += 1.2
        s.light.target.position.copy(s.light.position).addScaledVector(p.dir, 3).y -= 1.6
      } else {
        s.light.target.position.copy(p.p).y -= 10
      }
      s.light.target.updateMatrixWorld()
      s.light.userData.kind = p.kind
    }
    for (const s of free) s.key = ''

    const rankOf = new Map(this.picked.map((p, i) => [p.key, i]))
    const n = this.slots.length
    for (const s of this.slots) {
      const rank = rankOf.get(s.key)
      const target = rank === undefined ? 0 : night * (rank > n * 0.7 ? 1 - (rank - n * 0.7) / (n * 0.3 + 1) : 1)
      s.level += (target - s.level) * Math.min(1, dt * 3)
      const spec = SPECS[s.light.userData.kind as number] ?? SPECS[0]
      // Never toggle visibility: a changing light count recompiles every shader.
      s.light.intensity = spec.intensity * s.level
    }

    this.fill.intensity = night * (0.008 + 0.03 * this.urban)
  }

  /** Re-apply world positions after a floating-origin rebase. */
  invalidate(): void {
    this.lastPick = 0
    for (const s of this.slots) s.key = ''
  }
}
