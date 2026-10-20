// Distant traffic: one instanced draw per body class for every car beyond
// the full-model radius. At 100 m+ a car is a few dozen pixels, so the
// parametric body (right proportions, glasshouse, paint colour) with head-
// and tail-light quads reads the same as the textured model, for a fraction
// of the cost: hundreds of cars cost a handful of draw calls.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Group,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { bodyGeometry, specById, type CarSpec } from './carGeometry'

/** Which parametric body stands in for each AI vehicle class. */
const FAR_CLASS: Record<string, string> = {
  kei_car: 'kei_wagon',
  kei_van: 'kei_wagon',
  kei_truck_m: 'kei_truck',
  sedan_m: 'sedan',
  pickup_m: 'sedan',
  taxi_m: 'taxi',
  light_truck_m: 'light_truck',
  bus_m: 'bus',
  compact: 'compact',
  minivan: 'minivan',
}

interface Bucket {
  body: InstancedMesh
  lights: InstancedMesh
  n: number
}

const _m = new Matrix4()
const _q = new Quaternion()
const _s = new Vector3(1, 1, 1)
const _c = new Color()

/** Lamp quads: white pair at the front (-Z), red pair at the back. */
export function lampGeometry(spec: CarSpec): BufferGeometry {
  const parts: BufferGeometry[] = []
  const y = Math.max(0.55, spec.belt * 0.78)
  const x = spec.width / 2 - 0.22
  for (const front of [true, false]) {
    for (const side of [-1, 1]) {
      const g = new BoxGeometry(0.3, 0.12, 0.06)
      g.translate(side * x, y, (front ? -1 : 1) * (spec.length / 2 + 0.01))
      const col = front ? [1, 0.96, 0.88] : [1, 0.05, 0.03]
      const c = new Float32Array(g.attributes.position.count * 3)
      for (let i = 0; i < c.length; i += 3) c.set(col, i)
      g.setAttribute('color', new BufferAttribute(c, 3))
      parts.push(g.toNonIndexed())
    }
  }
  const out = mergeGeometries(parts.map((p) => (p.deleteAttribute('uv'), p)))!
  return out
}

/** Head/tail lamps of every vehicle: brightness follows night (values above 1 bloom). */
export const lampMaterial = new MeshBasicMaterial({ vertexColors: true })

export class FarTraffic {
  private buckets = new Map<string, Bucket>()
  private paint = new MeshStandardMaterial({ roughness: 0.35, metalness: 0.4 })
  private glass = new MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.1, metalness: 0.6 })
  readonly lampMat = lampMaterial

  constructor(
    private root: Group,
    private capacity = 260,
  ) {}

  /** Start a frame: every bucket empty. */
  begin(night: number): void {
    for (const b of this.buckets.values()) b.n = 0
    // Off by day (just dull lenses), bright enough to bloom after dark.
    this.lampMat.color.setScalar(0.25 + night * 5.5)
  }

  add(specId: string, pos: Vector3, tan: Vector3, color: number): void {
    const b = this.bucket(FAR_CLASS[specId] ?? 'sedan')
    if (b.n >= this.capacity) return
    _q.setFromAxisAngle(UP, Math.atan2(-tan.x, -tan.z))
    _m.compose(pos, _q, _s)
    b.body.setMatrixAt(b.n, _m)
    b.body.setColorAt(b.n, _c.setHex(color))
    b.lights.setMatrixAt(b.n, _m)
    b.n++
  }

  end(): void {
    for (const b of this.buckets.values()) {
      b.body.count = b.lights.count = b.n
      if (!b.n) continue
      b.body.instanceMatrix.needsUpdate = b.lights.instanceMatrix.needsUpdate = true
      if (b.body.instanceColor) b.body.instanceColor.needsUpdate = true
      b.body.computeBoundingSphere()
      b.lights.boundingSphere = b.body.boundingSphere
    }
  }

  private bucket(cls: string): Bucket {
    let b = this.buckets.get(cls)
    if (b) return b
    const spec = specById(cls)
    const body = new InstancedMesh(bodyGeometry(spec), [this.paint, this.glass], this.capacity)
    body.castShadow = false
    body.receiveShadow = true
    body.name = `far-traffic:${cls}`
    const lights = new InstancedMesh(lampGeometry(spec), this.lampMat, this.capacity)
    lights.name = `far-traffic-lamps:${cls}`
    body.count = lights.count = 0
    this.root.add(body, lights)
    b = { body, lights, n: 0 }
    this.buckets.set(cls, b)
    return b
  }
}

const UP = new Vector3(0, 1, 0)
