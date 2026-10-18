// Growable typed-array mesh builder (worker-side, transferable output).

export interface MeshData {
  position: Float32Array
  normal: Float32Array
  uv?: Float32Array
  index: Uint32Array
  attrs: Record<string, { array: Float32Array; size: number }>
}

class Grow {
  a: Float32Array
  n = 0
  constructor(cap = 1024) {
    this.a = new Float32Array(cap)
  }
  push(...v: number[]): void {
    if (this.n + v.length > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length))
      b.set(this.a)
      this.a = b
    }
    for (let i = 0; i < v.length; i++) this.a[this.n++] = v[i]
  }
  out(): Float32Array {
    return this.a.slice(0, this.n)
  }
}

class GrowU32 {
  a = new Uint32Array(1024)
  n = 0
  push(...v: number[]): void {
    if (this.n + v.length > this.a.length) {
      const b = new Uint32Array(Math.max(this.a.length * 2, this.n + v.length))
      b.set(this.a)
      this.a = b
    }
    for (let i = 0; i < v.length; i++) this.a[this.n++] = v[i]
  }
  out(): Uint32Array {
    return this.a.slice(0, this.n)
  }
}

export class MeshBuilder {
  private pos = new Grow()
  private nrm = new Grow()
  private uv = new Grow()
  private idx = new GrowU32()
  private extra = new Map<string, { g: Grow; size: number }>()
  vertexCount = 0

  constructor(
    readonly withUV = true,
    extraAttrs: Record<string, number> = {},
  ) {
    for (const [k, size] of Object.entries(extraAttrs)) this.extra.set(k, { g: new Grow(), size })
  }

  /** Adds a vertex and returns its index. `ex` values follow extraAttrs order. */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0, ...ex: number[]): number {
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    if (this.withUV) this.uv.push(u, v)
    let k = 0
    for (const { g, size } of this.extra.values()) {
      for (let i = 0; i < size; i++) g.push(ex[k++] ?? 0)
    }
    return this.vertexCount++
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c)
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d)
  }

  /** Triangle wound so its geometric normal points up (+y). */
  triUp(a: number, b: number, c: number): void {
    const p = this.pos.a
    const e1x = p[b * 3] - p[a * 3]
    const e1z = p[b * 3 + 2] - p[a * 3 + 2]
    const e2x = p[c * 3] - p[a * 3]
    const e2z = p[c * 3 + 2] - p[a * 3 + 2]
    // y component of (e1 x e2)
    const ny = e1z * e2x - e1x * e2z
    if (ny >= 0) this.idx.push(a, b, c)
    else this.idx.push(a, c, b)
  }

  quadUp(a: number, b: number, c: number, d: number): void {
    this.triUp(a, b, c)
    this.triUp(a, c, d)
  }

  get empty(): boolean {
    return this.idx.n === 0
  }

  build(): MeshData {
    const attrs: MeshData['attrs'] = {}
    for (const [k, { g, size }] of this.extra) attrs[k] = { array: g.out(), size }
    return {
      position: this.pos.out(),
      normal: this.nrm.out(),
      uv: this.withUV ? this.uv.out() : undefined,
      index: this.idx.out(),
      attrs,
    }
  }
}

export function transferables(m: MeshData | null | undefined): ArrayBuffer[] {
  if (!m) return []
  const t: ArrayBuffer[] = [m.position.buffer as ArrayBuffer, m.normal.buffer as ArrayBuffer, m.index.buffer as ArrayBuffer]
  if (m.uv) t.push(m.uv.buffer as ArrayBuffer)
  for (const a of Object.values(m.attrs)) t.push(a.array.buffer as ArrayBuffer)
  return t
}
