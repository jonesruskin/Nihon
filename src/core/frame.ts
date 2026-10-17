// The floating world origin. The Three.js scene is a local tangent frame
// anchored near the player; when the player strays far, we re-anchor and
// every streamed object re-derives its matrix from its own geodetic anchor.
import { Matrix4, Object3D, Vector3 } from 'three'
import { LocalFrame, type LatLonH } from './geo'

export type RebaseListener = (delta: Matrix4) => void

export class WorldFrame {
  frame: LocalFrame
  readonly worldToECEF = new Matrix4()
  readonly ecefToWorld = new Matrix4()
  private listeners = new Set<RebaseListener>()
  private anchored = new Map<Object3D, Matrix4>()

  constructor(lat: number, lon: number) {
    this.frame = new LocalFrame(lat, lon, 0)
    this.updateMatrices()
  }

  private updateMatrices(): void {
    this.worldToECEF.fromArray(this.frame.toECEFMatrix())
    this.ecefToWorld.copy(this.worldToECEF).invert()
  }

  onRebase(fn: RebaseListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Re-anchor the world at a new geodetic point. `delta` maps old-world
   * coordinates to new-world coordinates so dynamic objects can follow.
   */
  rebase(lat: number, lon: number): Matrix4 {
    const oldW2E = this.worldToECEF.clone()
    this.frame = new LocalFrame(lat, lon, 0)
    this.updateMatrices()
    const delta = new Matrix4().multiplyMatrices(this.ecefToWorld, oldW2E)
    for (const [obj, anchorToECEF] of this.anchored) this.applyAnchor(obj, anchorToECEF)
    for (const fn of this.listeners) fn(delta)
    return delta
  }

  /**
   * Attach an object whose geometry is expressed in its own local tangent
   * frame (anchorToECEF). Its matrix is kept in sync across rebases.
   */
  anchor(obj: Object3D, anchorToECEF: Matrix4): void {
    obj.matrixAutoUpdate = false
    this.anchored.set(obj, anchorToECEF)
    this.applyAnchor(obj, anchorToECEF)
  }

  /** Same as anchor() for geometry already in ECEF (e.g. 3D Tiles). */
  anchorECEF(obj: Object3D): void {
    this.anchor(obj, new Matrix4())
  }

  unanchor(obj: Object3D): void {
    this.anchored.delete(obj)
  }

  private applyAnchor(obj: Object3D, anchorToECEF: Matrix4): void {
    obj.matrix.multiplyMatrices(this.ecefToWorld, anchorToECEF)
    obj.matrixWorldNeedsUpdate = true
  }

  worldFromGeodetic(lat: number, lon: number, h: number, out = new Vector3()): Vector3 {
    const p = this.frame.fromGeodetic(lat, lon, h)
    return out.set(p[0], p[1], p[2])
  }

  geodeticFromWorld(v: Vector3): LatLonH {
    return this.frame.toGeodetic(v.x, v.y, v.z)
  }

  /** The local "up" direction at a world-space point (accounts for curvature). */
  upAt(v: Vector3, out = new Vector3()): Vector3 {
    const g = this.geodeticFromWorld(v)
    const f = new LocalFrame(g.lat, g.lon)
    const m = new Matrix4().fromArray(f.toECEFMatrix())
    // up axis of that frame, rotated into world
    const up = new Vector3().setFromMatrixColumn(m, 1)
    return out.copy(up).transformDirection(this.ecefToWorld)
  }
}

export function anchorMatrix(lat: number, lon: number, h = 0): Matrix4 {
  return new Matrix4().fromArray(new LocalFrame(lat, lon, h).toECEFMatrix())
}
