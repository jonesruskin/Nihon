// Small 2D geometry helpers used by the vector-tile world builder.
export type P2 = [number, number]

export function polygonArea(ring: P2[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
  return a / 2
}

export function centroid(ring: P2[]): P2 {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

export function convexHull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: P2[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: P2[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

export interface OBB {
  cx: number
  cy: number
  ax: number // unit long axis
  ay: number
  halfLong: number
  halfShort: number
  area: number
}

/** Minimum-area oriented bounding box via rotating calipers over the hull. */
export function minAreaRect(pts: P2[]): OBB {
  const hull = convexHull(pts)
  let best: OBB = { cx: 0, cy: 0, ax: 1, ay: 0, halfLong: 0, halfShort: 0, area: Infinity }
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    let ex = b[0] - a[0]
    let ey = b[1] - a[1]
    const len = Math.hypot(ex, ey)
    if (len < 1e-6) continue
    ex /= len
    ey /= len
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const p of hull) {
      const u = p[0] * ex + p[1] * ey
      const v = -p[0] * ey + p[1] * ex
      minU = Math.min(minU, u)
      maxU = Math.max(maxU, u)
      minV = Math.min(minV, v)
      maxV = Math.max(maxV, v)
    }
    const area = (maxU - minU) * (maxV - minV)
    if (area < best.area) {
      const cu = (minU + maxU) / 2
      const cv = (minV + maxV) / 2
      const lu = (maxU - minU) / 2
      const lv = (maxV - minV) / 2
      const longIsU = lu >= lv
      best = {
        cx: cu * ex - cv * ey,
        cy: cu * ey + cv * ex,
        ax: longIsU ? ex : -ey,
        ay: longIsU ? ey : ex,
        halfLong: Math.max(lu, lv),
        halfShort: Math.min(lu, lv),
        area,
      }
    }
  }
  return best
}

export function pointInRing(x: number, y: number, ring: P2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Resample a polyline so no segment exceeds `step` metres. */
export function densify(line: P2[], step: number): P2[] {
  const out: P2[] = [line[0]]
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    const n = Math.max(1, Math.ceil(d / step))
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

export function polylineLength(line: P2[]): number {
  let d = 0
  for (let i = 1; i < line.length; i++) d += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
  return d
}

/** Points every `spacing` metres along a line with their tangent. */
export function sampleAlong(line: P2[], spacing: number, offset = spacing / 2): Array<{ p: P2; t: P2; s: number }> {
  const out: Array<{ p: P2; t: P2; s: number }> = []
  let next = offset
  let acc = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (d < 1e-6) continue
    const t: P2 = [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
    while (next <= acc + d) {
      const f = (next - acc) / d
      out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], t, s: next })
      next += spacing
    }
    acc += d
  }
  return out
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}
