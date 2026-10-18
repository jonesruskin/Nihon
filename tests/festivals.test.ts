import { describe, expect, it } from 'vitest'
import { festivalsNear } from '../src/data/festivals'

const wd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()
const at = (lat: number, lon: number, y: number, m: number, d: number, h: number) => festivalsNear(lat, lon, y, m, d, wd(y, m, d), h).map((f) => f.ja)

describe('fireworks calendar', () => {
  it('fires Sumidagawa on the last Saturday of July only', () => {
    expect(at(35.71, 139.8, 2026, 7, 25, 19.5)).toContain('隅田川花火大会') // last Sat, 2026
    expect(at(35.71, 139.8, 2026, 7, 18, 19.5)).not.toContain('隅田川花火大会')
    expect(at(35.71, 139.8, 2026, 7, 25, 15)).toHaveLength(0) // not before dusk
  })
  it('knows Nagaoka on 2 and 3 August, and Lake Toya every summer night', () => {
    expect(at(37.44, 138.85, 2026, 8, 3, 20)).toContain('長岡まつり大花火大会')
    expect(at(42.56, 140.82, 2026, 6, 10, 20.9)).toContain('洞爺湖ロングラン花火大会')
    expect(at(42.56, 140.82, 2026, 12, 10, 20.9)).toHaveLength(0)
  })
  it('is only visible from nearby', () => {
    expect(at(34.69, 135.5, 2026, 7, 25, 19.5)).toEqual(['天神祭奉納花火'])
  })
})
