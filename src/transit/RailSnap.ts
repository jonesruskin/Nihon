// Spatial index of the OSM railway centrelines that the world builder has
// actually rendered (ballast + rails, including viaduct decks). Trains run on
// the national N02 geometry and are snapped onto these tracks wherever the
// world is loaded, so wheels sit on the visible rails, viaducts included.
import { Vector3, type Group, type Matrix4 } from 'three'
import type { NavPath } from '../world/vector/build'

const CELL = 32

interface Seg {
  a: Vector3
  b: Vector3
  tile: string
}

export interface SnapHit {
  point: Vector3
  tangent: Vector3
  dist: number
}

export class RailSnap {
  private cells = new Map<string, Seg[]>()
  private loaded = new Set<string>()
  private sig = ''
  private timer = 99
  segments = 0

  /** Rebuild from the vector tiles if their set changed (cheap polling). */
  update(dt: number, tiles: Array<{ key: string; build: { paths: NavPath[] }; group: Group }>, force = false): void {
    this.timer += dt
    if (!force && this.timer < 2) return
    this.timer = 0
    const sig = tiles.map((t) => t.key).join('|')
    if (!force && sig === this.sig) return
    this.sig = sig
    this.cells.clear()
    this.loaded.clear()
    this.segments = 0
    for (const t of tiles) {
      this.loaded.add(t.key)
      t.group.updateWorldMatrix(true, false)
      const m: Matrix4 = t.group.matrixWorld
      for (const p of t.build.paths) {
        if (p.kind !== 'rail') continue
        let prev: Vector3 | null = null
        for (let i = 0; i < p.pts.length; i += 3) {
          const v = new Vector3(p.pts[i], p.pts[i + 1], p.pts[i + 2]).applyMatrix4(m)
          if (prev) this.add({ a: prev, b: v, tile: t.key })
          prev = v
        }
      }
    }
  }

  invalidate(): void {
    this.sig = ''
    this.timer = 99
  }

  private add(s: Seg): void {
    this.segments++
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / CELL)
    const x1 = Math.floor(Math.max(s.a.x, s.b.x) / CELL)
    const z0 = Math.floor(Math.min(s.a.z, s.b.z) / CELL)
    const z1 = Math.floor(Math.max(s.a.z, s.b.z) / CELL)
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`
        let c = this.cells.get(k)
        if (!c) this.cells.set(k, (c = []))
        c.push(s)
      }
  }

  /** Is there rendered vector data at all around this point (vs. not streamed yet)? */
  hasDataNear(p: Vector3): boolean {
    return this.cells.size > 0 && this.anyCellWithin(p, 600)
  }

  private anyCellWithin(p: Vector3, r: number): boolean {
    // Cheap test: the loaded tile set is roughly around the player; a sample of cells suffices.
    const n = Math.ceil(r / CELL)
    const cx = Math.floor(p.x / CELL)
    const cz = Math.floor(p.z / CELL)
    for (let dx = -n; dx <= n; dx += 4) for (let dz = -n; dz <= n; dz += 4) if (this.cells.has(`${cx + dx},${cz + dz}`)) return true
    return false
  }

  /**
   * Nearest rendered track to `p` running parallel to `dir`, choosing the
   * one closest to `p + prefer` (keeps a train on its own track of a
   * multi-track line).
   */
  query(p: Vector3, dir: Vector3, prefer: Vector3 | null, maxDist = 24): SnapHit | null {
    const target = prefer ? p.clone().add(prefer) : p
    const n = Math.ceil(maxDist / CELL)
    const cx = Math.floor(target.x / CELL)
    const cz = Math.floor(target.z / CELL)
    let best: SnapHit | null = null
    let bestScore = Infinity
    const seen = new Set<Seg>()
    const q = new Vector3()
    for (let dx = -n; dx <= n; dx++)
      for (let dz = -n; dz <= n; dz++) {
        const c = this.cells.get(`${cx + dx},${cz + dz}`)
        if (!c) continue
        for (const s of c) {
          if (seen.has(s)) continue
          seen.add(s)
          const ex = s.b.x - s.a.x
          const ez = s.b.z - s.a.z
          const len2 = ex * ex + ez * ez
          if (len2 < 1e-6) continue
          const len = Math.sqrt(len2)
          const par = Math.abs((ex * dir.x + ez * dir.z) / (len * Math.hypot(dir.x, dir.z) || 1))
          if (par < 0.85) continue
          const t = Math.max(0, Math.min(1, ((target.x - s.a.x) * ex + (target.z - s.a.z) * ez) / len2))
          q.set(s.a.x + ex * t, s.a.y + (s.b.y - s.a.y) * t, s.a.z + ez * t)
          const dTarget = Math.hypot(q.x - target.x, q.z - target.z)
          const dP = Math.hypot(q.x - p.x, q.z - p.z)
          if (dP > maxDist) continue
          if (dTarget < bestScore) {
            bestScore = dTarget
            const tan = new Vector3(ex, s.b.y - s.a.y, ez).normalize()
            if (tan.x * dir.x + tan.z * dir.z < 0) tan.negate()
            best = { point: q.clone(), tangent: tan, dist: dP }
          }
        }
      }
    return best
  }
}
