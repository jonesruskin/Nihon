import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTile } from '../src/world/vector/build'

const pbf = readFileSync(new URL('./fixtures/shibuya-14-14549-6452.pbf', import.meta.url))
const id = { z: 14, x: 14549, y: 6452 }
const dem = { id, heights: new Float32Array(256 * 256).fill(30) }

describe('vector tile builder (Shibuya)', () => {
  const t0 = performance.now()
  const out = buildTile({ id, pbf: pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength), dem, coverage: [], detail: 1 })
  const ms = performance.now() - t0

  it('builds streets, buildings and furniture', () => {
    expect(out.roads!.index.length).toBeGreaterThan(1000)
    expect(out.buildings.reduce((n, m) => n + m.index.length, 0)).toBeGreaterThan(1000)
    expect(out.instances.pole.length / 6).toBeGreaterThan(20)
    expect(out.pois.length).toBeGreaterThan(100)
    expect(out.paths.length).toBeGreaterThan(100)
    expect(ms).toBeLessThan(4000)
  })

  it('keeps geometry inside the tile footprint and on the ground', () => {
    const p = out.roads!.position
    for (let i = 0; i < p.length; i += 3) {
      expect(Math.abs(p[i])).toBeLessThan(1400)
      expect(p[i + 1]).toBeGreaterThan(29)
      expect(p[i + 1]).toBeLessThan(60)
    }
  })

  it('road triangles face upward', () => {
    const p = out.roads!.position
    const idx = out.roads!.index
    let down = 0
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
      const e1x = p[b] - p[a]
      const e1z = p[b + 2] - p[a + 2]
      const e2x = p[c] - p[a]
      const e2z = p[c + 2] - p[a + 2]
      if (e1z * e2x - e1x * e2z < -1e-6) down++
    }
    expect(down).toBe(0)
  })

  it('skips OSM buildings covered by PLATEAU', () => {
    const covered = buildTile({ id, pbf: pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength), dem, coverage: [[139, 35, 140, 36]], detail: 1 })
    expect(covered.buildings).toHaveLength(0)
    expect(covered.stats.skippedForPlateau).toBeGreaterThan(0)
  })
})
