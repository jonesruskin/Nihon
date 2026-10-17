import { describe, expect, it } from 'vitest'
import { busRule, distanceFare } from '../src/transit/busFare'

describe('bus fares', () => {
  it('uses the flat front-boarding fare in the Tokyo wards', () => {
    const r = busRule({ prefCode: 13, pref: '東京都', city: '渋谷区', area: '道玄坂二丁目' })
    expect(r.payment).toBe('flat-front')
    expect(r.fare).toBe(210)
  })
  it('pays on exit in Kyoto', () => {
    expect(busRule({ prefCode: 26, pref: '京都府', city: '京都市東山区', area: '' }).payment).toBe('flat-exit')
  })
  it('falls back to numbered-ticket distance fares in the countryside and Tokyo\'s Tama area', () => {
    expect(busRule({ prefCode: 36, pref: '徳島県', city: '三好市', area: '' }).payment).toBe('distance')
    expect(busRule({ prefCode: 13, pref: '東京都', city: '八王子市', area: '' }).payment).toBe('distance')
    expect(busRule(null).payment).toBe('distance')
  })
  it('grows with distance in ten-yen steps', () => {
    expect(distanceFare(0.5)).toBe(170)
    expect(distanceFare(5)).toBeGreaterThan(distanceFare(2))
    expect(distanceFare(7.3) % 10).toBe(0)
  })
})
