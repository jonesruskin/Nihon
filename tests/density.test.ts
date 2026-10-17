import { describe, expect, it } from 'vitest'
import { pedestriansPerHectare } from '../src/people/density'

const shibuya = { residentsPerKm2: 12000, shopsWithin300m: 600, stations: [{ riders: 2.7e6, distance: 150 }], weekend: false, rain: 0, hotspot: 1 }
const village = { residentsPerKm2: 150, shopsWithin300m: 2, stations: [], weekend: false, rain: 0, hotspot: 0 }
const suburb = { residentsPerKm2: 15000, shopsWithin300m: 25, stations: [{ riders: 40000, distance: 600 }], weekend: false, rain: 0, hotspot: 0 }

describe('pedestrian density', () => {
  it('packs Shibuya at rush hour and leaves a village quiet', () => {
    const s = pedestriansPerHectare({ ...shibuya, hour: 18 })
    const v = pedestriansPerHectare({ ...village, hour: 8 })
    expect(s).toBeGreaterThan(150)
    expect(v).toBeLessThan(0.5)
    expect(s / Math.max(v, 1e-3)).toBeGreaterThan(500)
  })
  it('gives residential suburbs a handful of people per hectare', () => {
    const d = pedestriansPerHectare({ ...suburb, hour: 15 })
    expect(d).toBeGreaterThan(2)
    expect(d).toBeLessThan(25)
  })
  it('thins out in the rain and in the small hours', () => {
    const dry = pedestriansPerHectare({ ...shibuya, hour: 14 })
    expect(pedestriansPerHectare({ ...shibuya, hour: 14, rain: 1 })).toBeLessThan(dry * 0.7)
    expect(pedestriansPerHectare({ ...shibuya, hour: 3.5 })).toBeLessThan(dry * 0.25)
  })
})
