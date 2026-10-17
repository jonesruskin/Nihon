// Keeps Rapier colliders for the world around the player: a registry of
// candidate meshes (terrain z17 tiles, OSM buildings/roads/viaducts, PLATEAU
// buildings, street furniture) activated within a radius and released
// beyond it.
import { Vector3, type Mesh, type Object3D } from 'three'
import type { Physics } from './Physics'

interface Candidate {
  object: Object3D
  kind: 'mesh' | 'cylinders'
  positions?: Float32Array
  indices?: Uint32Array
  cylinders?: Array<[number, number, number, number, number]>
  radius: number // bounding radius for distance tests
}

const _c = new Vector3()

export class WorldColliders {
  private candidates = new Map<string, Candidate>()
  private timer = 0
  activateRadius = 420
  releaseRadius = 650

  constructor(private physics: Physics) {}

  get candidateCount(): number {
    return this.candidates.size
  }

  addMesh(key: string, mesh: Mesh): void {
    const g = mesh.geometry
    const pos = g.getAttribute('position')
    if (!pos) return
    let idx: Uint32Array
    if (g.index) idx = g.index.array instanceof Uint32Array ? g.index.array : Uint32Array.from(g.index.array)
    else idx = Uint32Array.from({ length: pos.count }, (_, i) => i)
    if (!g.boundingSphere) g.computeBoundingSphere()
    this.candidates.set(key, {
      object: mesh,
      kind: 'mesh',
      positions: pos.array as Float32Array,
      indices: idx,
      radius: g.boundingSphere?.radius ?? 1000,
    })
  }

  addRaw(key: string, object: Object3D, positions: Float32Array, indices: Uint32Array, radius: number): void {
    this.candidates.set(key, { object, kind: 'mesh', positions, indices, radius })
  }

  addCylinders(key: string, object: Object3D, cylinders: Array<[number, number, number, number, number]>, radius: number): void {
    if (!cylinders.length) return
    this.candidates.set(key, { object, kind: 'cylinders', cylinders, radius })
  }

  remove(key: string): void {
    this.candidates.delete(key)
    this.physics.remove(key)
  }

  removePrefix(prefix: string): void {
    for (const k of [...this.candidates.keys()]) if (k.startsWith(prefix)) this.remove(k)
  }

  /** Force-activate everything near a point now (spawning, teleports). */
  activateNow(center: Vector3): void {
    this.timer = 1e9
    this.update(0, center, Infinity)
  }

  update(dt: number, center: Vector3, budget = 30): void {
    this.timer += dt
    if (this.timer < 0.4 || !this.physics.ready) return
    this.timer = 0
    // Nearest first, so the ground under the player is never starved.
    const todo: Array<{ key: string; c: Candidate; d: number }> = []
    for (const [key, c] of this.candidates) {
      if (!c.object.parent) continue
      c.object.updateWorldMatrix(true, false)
      _c.setFromMatrixPosition(c.object.matrixWorld)
      const d = _c.distanceTo(center) - c.radius
      const active = this.physics.has(key)
      if (!active && d < this.activateRadius) todo.push({ key, c, d })
      else if (active && d > this.releaseRadius) this.physics.remove(key)
    }
    todo.sort((a, b) => a.d - b.d)
    for (const { key, c } of todo.slice(0, budget)) {
      if (c.kind === 'mesh') this.physics.addTrimesh(key, c.object, c.positions!, c.indices!)
      else this.physics.addCylinders(key, c.object, c.cylinders!)
    }
  }
}
