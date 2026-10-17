import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RailNetwork, runTime } from '../src/transit/RailNetwork'

const net = new RailNetwork(JSON.parse(readFileSync('public/data/rail.json', 'utf8')))
const find = (ja: string, lineJa?: string) =>
  net.stations.find((s) => s.ja === ja && (!lineJa || net.lines[s.line].ja === lineJa))!

describe('rail network', () => {
  it('covers the whole country', () => {
    expect(net.stations.length).toBeGreaterThan(9000)
    expect(net.lines.length).toBeGreaterThan(500)
    expect(find('稚内')).toBeTruthy() // northernmost station
    expect(find('赤嶺')).toBeTruthy() // Okinawa monorail
  })

  it('takes the Shinkansen from Tokyo to Shin-Osaka in about 2.5 h for about ¥14,700', () => {
    const r = net.route(find('東京').id, find('新大阪').id)!
    expect(r).toBeTruthy()
    const main = r.legs.reduce((a, b) => (b.length > a.length ? b : a))
    expect(main.line.kind).toBe('shinkansen')
    expect(r.time / 3600).toBeGreaterThan(2.1)
    expect(r.time / 3600).toBeLessThan(3.2)
    expect(r.fare).toBeGreaterThan(13000)
    expect(r.fare).toBeLessThan(16500)
  })

  it('rides the Ginza line straight from Shibuya to Asakusa', () => {
    const r = net.route(find('渋谷', '銀座線').id, find('浅草', '銀座線').id)!
    expect(r.legs.length).toBe(1)
    expect(r.legs[0].line.ja).toBe('銀座線')
    expect(r.legs[0].stations.length).toBe(19)
    expect(r.time / 60).toBeGreaterThan(25)
    expect(r.time / 60).toBeLessThan(45)
  })

  it('finds stations by romaji, kana and kanji', () => {
    expect(net.search('shinjuku')[0].ja).toBe('新宿')
    expect(net.search('しぶや')[0].ja).toBe('渋谷')
    expect(net.search('京都')[0].ja).toBe('京都')
  })

  it('runs physically plausible times', () => {
    expect(runTime('metro', 1000)).toBeGreaterThan(70)
    expect(runTime('metro', 1000)).toBeLessThan(110)
  })
})
