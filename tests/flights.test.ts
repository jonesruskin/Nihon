import { describe, expect, it } from 'vitest'
import { airport, destinations, flightFare, flightKm, flightMinutes } from '../src/transit/flights'

describe('domestic flights', () => {
  const hnd = airport('HND')!
  const cts = airport('CTS')!
  it('times and prices Tokyo-Sapporo like the real thing', () => {
    const km = flightKm(hnd, cts)
    expect(km).toBeGreaterThan(780)
    expect(km).toBeLessThan(860)
    expect(flightMinutes(km)).toBeGreaterThan(85)
    expect(flightMinutes(km)).toBeLessThan(115)
    expect(flightFare(km)).toBeGreaterThan(10000)
  })
  it('flies hubs everywhere but not Shinkansen-distance hops', () => {
    const codes = destinations(hnd).map((a) => a.code)
    expect(codes).toContain('OKA')
    expect(codes).toContain('CTS')
    expect(codes).not.toContain('NGO')
    expect(codes).not.toContain('NRT')
  })
  it('reaches the outer islands via Naha and Kagoshima', () => {
    expect(destinations(airport('ISG')!).map((a) => a.code)).toContain('OKA')
    expect(destinations(airport('KUM')!).map((a) => a.code)).toEqual(expect.arrayContaining(['KOJ']))
    expect(destinations(airport('KUM')!).map((a) => a.code)).not.toContain('HKD')
  })
})
