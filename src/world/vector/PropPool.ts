// One instanced draw per prop model for the whole streamed area: each pool
// gathers the instances within its draw range from every loaded tile and is
// refilled as the camera moves. Per-tile buckets cost a draw call per tile,
// per cell and per material (trees alone were ~60 draws in central Tokyo).
import { InstancedMesh, Matrix4, Quaternion, Sphere, Vector3, type Group, type Object3D } from 'three'
import type { PropModel } from '../props/models'

interface Source {
  group: Group
  /** Instance records (x, y, z, rotation, scale, extra) in tile-local space. */
  data: Float32Array
  /** Start offsets of the records this pool draws. */
  idx: Uint32Array
  scale: (s: number, e: number) => Vector3
  /** Tile-local bounds of those records. */
  centre: Vector3
  radius: number
}

const _inv = new Matrix4()
const _m = new Matrix4()
const _local = new Vector3()
const _pos = new Vector3()
const _q = new Quaternion()
const _up = new Vector3(0, 1, 0)

export class PropPool {
  private sources: Source[] = []
  private mesh: InstancedMesh | null = null
  private capacity = 0
  dirty = false

  constructor(
    readonly name: string,
    private model: PropModel,
    readonly range: number,
    private root: Object3D,
  ) {}

  add(group: Group, data: Float32Array, filter: (extra: number) => boolean, scale: (s: number, e: number) => Vector3): void {
    const idx: number[] = []
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y = 0
    for (let i = 0; i < data.length; i += 6) {
      if (!filter(data[i + 5])) continue
      idx.push(i)
      x0 = Math.min(x0, data[i])
      x1 = Math.max(x1, data[i])
      z0 = Math.min(z0, data[i + 2])
      z1 = Math.max(z1, data[i + 2])
      y += data[i + 1]
    }
    if (!idx.length) return
    const centre = new Vector3((x0 + x1) / 2, y / idx.length, (z0 + z1) / 2)
    this.sources.push({ group, data, idx: Uint32Array.from(idx), scale, centre, radius: Math.hypot(x1 - x0, z1 - z0) / 2 + 200 })
    this.dirty = true
  }

  remove(group: Group): void {
    const n = this.sources.length
    this.sources = this.sources.filter((s) => s.group !== group)
    if (this.sources.length !== n) this.dirty = true
  }

  /** Refill with the instances within range of `camera` (world space). */
  refresh(camera: Vector3): void {
    this.dirty = false
    const r2 = this.range * this.range
    // Count first so the buffer is sized once.
    let n = 0
    const live: Array<[Source, Vector3]> = []
    for (const s of this.sources) {
      s.group.updateWorldMatrix(true, false)
      _inv.copy(s.group.matrixWorld).invert()
      const local = _local.copy(camera).applyMatrix4(_inv)
      if (local.distanceTo(s.centre) > s.radius + this.range) continue
      const lc = local.clone()
      live.push([s, lc])
      const d = s.data
      for (const i of s.idx) {
        const dx = d[i] - lc.x, dy = d[i + 1] - lc.y, dz = d[i + 2] - lc.z
        if (dx * dx + dy * dy + dz * dz < r2) n++
      }
    }
    if (n > this.capacity) {
      if (this.mesh) {
        this.root.remove(this.mesh)
        this.mesh.dispose()
      }
      this.capacity = Math.ceil(n * 1.4) + 32
      const mesh = new InstancedMesh(this.model.geometry, this.model.materials, this.capacity)
      mesh.name = `props:${this.name}`
      mesh.castShadow = this.model.castShadow
      mesh.receiveShadow = true
      mesh.boundingSphere = new Sphere(new Vector3(), 0)
      this.root.add(mesh)
      this.mesh = mesh
    }
    const mesh = this.mesh
    if (!mesh) return
    let k = 0
    for (const [s, lc] of live) {
      const d = s.data
      for (const i of s.idx) {
        const dx = d[i] - lc.x, dy = d[i + 1] - lc.y, dz = d[i + 2] - lc.z
        if (dx * dx + dy * dy + dz * dz >= r2) continue
        _pos.set(d[i], d[i + 1], d[i + 2])
        _q.setFromAxisAngle(_up, d[i + 3])
        _m.compose(_pos, _q, s.scale(d[i + 4], d[i + 5])).premultiply(s.group.matrixWorld)
        mesh.setMatrixAt(k++, _m)
      }
    }
    mesh.count = k
    mesh.visible = k > 0
    mesh.instanceMatrix.clearUpdateRanges()
    mesh.instanceMatrix.addUpdateRange(0, k * 16)
    mesh.instanceMatrix.needsUpdate = true
    // Bounds: the disc around the camera (the vector root sits at the origin).
    const g = this.model.geometry
    if (!g.boundingSphere) g.computeBoundingSphere()
    mesh.boundingSphere!.set(_pos.copy(camera), this.range + (g.boundingSphere?.radius ?? 10) * 2)
  }
}
