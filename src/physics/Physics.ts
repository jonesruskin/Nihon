// Rapier physics world. Static colliders are built from the same geometry we
// render (terrain z17 grid, OSM/PLATEAU buildings, road decks), so what you
// see is exactly what you collide with. Bodies follow their render object's
// world matrix across floating-origin rebases.
import RAPIER from '@dimforge/rapier3d-compat'
import { Matrix4, Quaternion, Vector3, type Object3D } from 'three'

export type Rapier = typeof RAPIER

interface StaticEntry {
  object: Object3D
  body: RAPIER.RigidBody
}

const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()

export class Physics {
  R!: Rapier
  world!: RAPIER.World
  private statics = new Map<string, StaticEntry>()
  private acc = 0
  readonly step = 1 / 60
  ready = false

  async init(): Promise<void> {
    await RAPIER.init()
    this.R = RAPIER
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.timestep = this.step
    this.ready = true
  }

  has(key: string): boolean {
    return this.statics.has(key)
  }

  get staticCount(): number {
    return this.statics.size
  }

  /**
   * Add a static triangle mesh whose vertices are in `object`'s local space.
   * Positions are copied (Rapier needs its own buffers).
   */
  addTrimesh(key: string, object: Object3D, positions: Float32Array, indices: Uint32Array, friction = 0.9): void {
    if (!this.ready || this.statics.has(key) || indices.length < 3) return
    object.updateWorldMatrix(true, false)
    object.matrixWorld.decompose(_p, _q, _s)
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(_p.x, _p.y, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
    )
    let verts = positions
    if (Math.abs(_s.x - 1) > 1e-6 || Math.abs(_s.y - 1) > 1e-6 || Math.abs(_s.z - 1) > 1e-6) {
      verts = positions.slice()
      for (let i = 0; i < verts.length; i += 3) {
        verts[i] *= _s.x
        verts[i + 1] *= _s.y
        verts[i + 2] *= _s.z
      }
    } else verts = positions.slice()
    const desc = this.R.ColliderDesc.trimesh(verts, indices.slice()).setFriction(friction)
    this.world.createCollider(desc, body)
    this.statics.set(key, { object, body })
  }

  /** Static cylinder (poles, signals) in object-local coordinates. */
  addCylinders(key: string, object: Object3D, items: Array<[number, number, number, number, number]>): void {
    if (!this.ready || this.statics.has(key) || !items.length) return
    object.updateWorldMatrix(true, false)
    object.matrixWorld.decompose(_p, _q, _s)
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(_p.x, _p.y, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
    )
    for (const [x, y, z, halfH, r] of items) {
      this.world.createCollider(this.R.ColliderDesc.cylinder(halfH, r).setTranslation(x, y + halfH, z), body)
    }
    this.statics.set(key, { object, body })
  }

  remove(key: string): void {
    const e = this.statics.get(key)
    if (!e) return
    this.world.removeRigidBody(e.body)
    this.statics.delete(key)
  }

  removePrefix(prefix: string): void {
    for (const k of [...this.statics.keys()]) if (k.startsWith(prefix)) this.remove(k)
  }

  /** After a floating-origin rebase, move static bodies to their objects' new poses. */
  syncStatics(): void {
    for (const e of this.statics.values()) {
      e.object.updateWorldMatrix(true, false)
      e.object.matrixWorld.decompose(_p, _q, _s)
      e.body.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, false)
      e.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, false)
    }
  }

  /** Remove statics whose object is far from a point. */
  prune(center: Vector3, radius: number): void {
    for (const [k, e] of this.statics) {
      e.object.getWorldPosition(_p)
      if (_p.distanceTo(center) > radius) this.remove(k)
    }
  }

  update(dt: number, beforeStep?: (h: number) => void): number {
    if (!this.ready) return 0
    this.acc = Math.min(this.acc + dt, 0.25)
    let steps = 0
    while (this.acc >= this.step) {
      beforeStep?.(this.step)
      this.world.step()
      this.acc -= this.step
      steps++
    }
    return steps
  }

  /** Raycast; returns distance or null. */
  ray(origin: Vector3, dir: Vector3, maxToi: number, exclude?: RAPIER.Collider, filterGroups?: number): number | null {
    const r = new this.R.Ray(origin, dir)
    const hit = this.world.castRay(r, maxToi, true, undefined, filterGroups, exclude)
    return hit ? hit.timeOfImpact : null
  }

  /** Ground height under a point (world y), or null. */
  groundBelow(x: number, y: number, z: number, maxDrop = 200): number | null {
    const d = this.ray(new Vector3(x, y, z), new Vector3(0, -1, 0), maxDrop)
    return d === null ? null : y - d
  }
}

export function matrixOf(o: Object3D): Matrix4 {
  o.updateWorldMatrix(true, false)
  return o.matrixWorld
}
