import { describe, expect, it } from 'vitest'
import { clip, ferryFare, ferrySpeed, routeKm } from '../src/transit/ferry'

describe('ferry routes', () => {
  it('clips a line to the tile so neighbouring pieces meet on the edge', () => {
    // From outside the left edge, across the tile, out through the right edge.
    const parts = clip([{ x: -100, y: 2048 }, { x: 2048, y: 2048 }, { x: 4200, y: 1000 }], 4096)
    expect(parts).toHaveLength(1)
    const p = parts[0]
    expect(p[0][0]).toBeCloseTo(0)
    expect(p[p.length - 1][0]).toBeCloseTo(4096)
  })
  it('splits a line that leaves and re-enters the tile', () => {
    const parts = clip([{ x: 100, y: 100 }, { x: 100, y: -500 }, { x: 300, y: -500 }, { x: 300, y: 100 }], 4096)
    expect(parts).toHaveLength(2)
  })
  it('prices and times crossings like real ones', () => {
    expect(ferryFare(1.7)).toBeLessThan(300) // Miyajima: ¥200
    expect(ferryFare(742)).toBeGreaterThan(9000) // Oarai-Tomakomai 2nd class
    expect(ferrySpeed(1.7)).toBeLessThan(ferrySpeed(742))
    expect(routeKm([[34.0, 132.0], [34.0, 133.0]])).toBeCloseTo(92.3, 0)
  })
})
