// Night lighting from the real street furniture around the player.
//
// Every street lamp, pole-mounted 防犯灯 (security LED) and vending machine
// that the world builder places is registered here as a light *source*. The
// nearest ones (plus car headlights, which always win a slot) are written
// each frame into the shader-lamp uniforms (see lamps.ts), so the asphalt
// gets genuine light pools with specular glints on cars and wet roads.
// Sources beyond the pool still glow through their emissive heads and bloom.
import { Color, HemisphereLight, Matrix4, Object3D, Vector3, type Camera, type Scene } from 'three'
import { commitLamps, lampData, MAX_LAMPS } from './lamps'

/** Source kinds, stored in the 5th float of each record. */
export const LAMP = { street: 0, pole: 1, vending: 2, shop: 3 } as const

interface Spec {
  intensity: number // candela
  outer: number // cone half-angle (rad)
  inner: number
  range: number
  color: Color
}

// LED street lights throw a wide "batwing" beam along the road, so the pool
// is broad and soft-edged rather than a disc under the lamp.
const SPECS: Spec[] = [
  { intensity: 26, outer: 1.3, inner: 0.55, range: 42, color: new Color(1.0, 0.94, 0.86) }, // LED street lamp
  { intensity: 15, outer: 1.25, inner: 0.5, range: 26, color: new Color(0.95, 0.97, 1.0) }, // pole security LED
  { intensity: 6, outer: 1.35, inner: 0.6, range: 10, color: new Color(0.92, 0.97, 1.0) }, // vending machine glow
  { intensity: 6, outer: 4, inner: 4, range: 12, color: new Color(1.0, 0.9, 0.76) }, // shop front spill
]

/** A light that moves (headlights): set by its owner every frame. */
export interface DynamicLamp {
  pos: Vector3 // world
  dir: Vector3 // world, unit
  color: Color
  intensity: number // candela
  range: number
  outer: number
  inner: number
}

interface Pick {
  key: string
  p: Vector3
  dir: Vector3
  kind: number
  d: number
}

const _p = new Vector3()
const _at = new Vector3()
const _beam = new Vector3()
const _cam = new Vector3()
const DOWN = new Vector3(0, -1, 0)

export class NightLights {
  /** STRIDE floats per source: local x, y, z, yaw, kind (group-local coords). */
  static readonly STRIDE = 5
  private sources = new Map<Object3D, Float32Array>()
  private fill: HemisphereLight
  private lastPick = 0
  private picked: Pick[] = []
  private pool: Pick[] = []
  private levels = new Map<string, number>()
  private m = new Matrix4()
  /** How many static lamps get a shader slot (quality tier). */
  private size = 16
  /** Moving lights for this frame (headlights), nearest first; owners refill it. */
  readonly dynamic: DynamicLamp[] = []
  /** 0 = countryside, 1 = dense city: drives sky glow and ambient fill. */
  urban = 0
  /** 0..1: lamps close around the viewer (drives eye adaptation). */
  glare = 0
  lampLoad = 0
  /** QA/tuning multiplier on the ambient city fill. */
  fillScale = 1

  constructor(scene: Scene) {
    // Scattered city light (light pollution bouncing off haze and walls).
    this.fill = new HemisphereLight(0x8a7a6a, 0x3a3028, 0)
    scene.add(this.fill)
  }

  setPoolSize(n: number): void {
    this.size = Math.min(MAX_LAMPS, n)
  }

  register(owner: Object3D, data: Float32Array): void {
    if (data.length) this.sources.set(owner, data)
  }

  unregister(owner: Object3D): void {
    this.sources.delete(owner)
  }

  private pick(camera: Vector3): void {
    const S = NightLights.STRIDE
    let n = 0
    let near = 0
    for (const [owner, data] of this.sources) {
      if (!owner.parent) continue
      this.m.copy(owner.matrixWorld)
      for (let i = 0; i < data.length; i += S) {
        _p.set(data[i], data[i + 1], data[i + 2]).applyMatrix4(this.m)
        const d = _p.distanceTo(camera)
        if (d < 300 && data[i + 4] !== LAMP.vending) near++
        if (d > 160) continue
        const rec = (this.pool[n] ??= { key: '', p: new Vector3(), dir: new Vector3(), kind: 0, d: 0 })
        rec.key = `${owner.id}:${i}`
        rec.p.copy(_p)
        const yaw = data[i + 3]
        rec.dir.set(Math.sin(yaw), 0, Math.cos(yaw)).transformDirection(this.m)
        rec.kind = data[i + 4]
        rec.d = d
        n++
      }
    }
    const all = this.pool.slice(0, n).sort((a, b) => a.d - b.d)
    this.picked = all.slice(0, MAX_LAMPS)
    // ~120 lamps within 300 m is a lit urban street grid.
    this.urban = Math.min(1, near / 120)
    // How much lamp light is right around the viewer (a crossing ringed by
    // street lights and shop fronts): the eye stops down there.
    let load = 0
    // Weighted by how bright each kind is: street lamps count fully, pole
    // LEDs half, shop spill and vending machines a quarter.
    for (const r of this.picked) load += (15 / Math.max(r.d, 15)) ** 2 * (r.kind === LAMP.street ? 1 : r.kind === LAMP.pole ? 0.5 : 0.25)
    this.lampLoad = load
    this.glare = Math.min(1, Math.max(0, (load - 4) / 8))
  }

  update(dt: number, camera: Camera, night: number, now = performance.now()): void {
    if (now - this.lastPick > 250) {
      this.lastPick = now
      this.pick(_cam.setFromMatrixPosition(camera.matrixWorld))
    }
    const view = camera.matrixWorldInverse
    let count = 0
    const put = (pos: Vector3, dir: Vector3, color: Color, intensity: number, range: number, outer: number, inner: number) => {
      const o = count++ * 12
      const d = lampData
      _p.copy(pos).applyMatrix4(view)
      d[o] = _p.x
      d[o + 1] = _p.y
      d[o + 2] = _p.z
      d[o + 3] = range
      d[o + 4] = color.r * intensity
      d[o + 5] = color.g * intensity
      d[o + 6] = color.b * intensity
      d[o + 7] = outer > 3 ? -2 : Math.cos(outer)
      _p.copy(dir).transformDirection(view)
      d[o + 8] = _p.x
      d[o + 9] = _p.y
      d[o + 10] = _p.z
      d[o + 11] = Math.cos(inner)
    }

    if (night > 0.01) {
      for (const l of this.dynamic) {
        if (count >= Math.min(8, MAX_LAMPS)) break
        put(l.pos, l.dir, l.color, l.intensity * night, l.range, l.outer, l.inner)
      }
      // Lamps fade in by rank so a newcomer to the pool never pops.
      const slots = Math.max(0, this.size - count)
      const seen = new Set<string>()
      for (let r = 0; r < this.picked.length && r < slots; r++) {
        const p = this.picked[r]
        seen.add(p.key)
        const fadeOut = r > slots * 0.7 ? 1 - (r - slots * 0.7) / (slots * 0.3 + 1) : 1
        const prev = this.levels.get(p.key) ?? 0
        const level = prev + (fadeOut - prev) * Math.min(1, dt * 3)
        this.levels.set(p.key, level)
        const spec = SPECS[p.kind] ?? SPECS[0]
        if (p.kind === LAMP.vending) {
          // The lit front panel, shining out and down onto the pavement.
          _at.copy(p.p).addScaledVector(p.dir, 0.4)
          _at.y += 1.2
          _beam.copy(p.dir).multiplyScalar(3)
          _beam.y -= 1.6
          put(_at, _beam.normalize(), spec.color, spec.intensity * level * night, spec.range, spec.outer, spec.inner)
        } else if (p.kind === LAMP.shop) {
          _at.copy(p.p)
          put(_at, DOWN, spec.color, spec.intensity * level * night, spec.range, spec.outer, spec.inner)
        } else put(p.p, DOWN, spec.color, spec.intensity * level * night, spec.range, spec.outer, spec.inner)
      }
      for (const k of this.levels.keys()) if (!seen.has(k)) this.levels.delete(k)
    } else this.levels.clear()
    commitLamps(count)

    // Light pollution bouncing off haze, walls and wet asphalt. Kept low: a
    // uniform fill flattens night into overcast day; the lamps, shop fronts
    // and signs must do the lighting.
    this.fill.intensity = night * (0.012 + 0.04 * this.urban) * this.fillScale
  }

  /** Re-apply world positions after a floating-origin rebase. */
  invalidate(): void {
    this.lastPick = 0
    this.levels.clear()
  }
}
