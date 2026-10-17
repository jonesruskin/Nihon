// How many people are out on the street here, now? A first-principles model
// fed by real data:
//   residents      Kontur Population (1 km grid)       x share outdoors by hour
//   shoppers       OSM shops/restaurants within 300 m  x commercial activity curve
//   commuters      MLIT station ridership (S12)        x rush-hour curve, distance decay
//   weekends shift people from stations to shopping streets; rain keeps them in.
// Output: pedestrians per hectare of land.

export class PopulationGrid {
  private rows = new Uint16Array(0)
  private cols = new Uint16Array(0)
  private pop = new Uint16Array(0)

  static async load(url = `${import.meta.env.BASE_URL}data/population.bin`): Promise<PopulationGrid> {
    const g = new PopulationGrid()
    const buf = await (await fetch(url)).arrayBuffer()
    const dv = new DataView(buf)
    const n = dv.getUint32(0, true)
    g.rows = new Uint16Array(n)
    g.cols = new Uint16Array(n)
    g.pop = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      g.rows[i] = dv.getUint16(4 + i * 6, true)
      g.cols[i] = dv.getUint16(6 + i * 6, true)
      g.pop[i] = dv.getUint16(8 + i * 6, true)
    }
    return g
  }

  private cell(r: number, c: number): number {
    let lo = 0
    let hi = this.rows.length - 1
    const key = r * 65536 + c
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      const k = this.rows[m] * 65536 + this.cols[m]
      if (k === key) return this.pop[m]
      if (k < key) lo = m + 1
      else hi = m - 1
    }
    return 0
  }

  /** Residents per km² around a point (3x3 smoothed ~1 km cells). */
  densityAt(lat: number, lon: number): number {
    const r = Math.floor((lat - 20) * 100)
    const c = Math.floor((lon - 122) * 100)
    let s = 0
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s += this.cell(r + dr, c + dc) * (dr === 0 && dc === 0 ? 2 : 1)
    return s / 10 / 1.01
  }
}

/** Share of residents outdoors in public space, by hour. */
function outdoorShare(h: number): number {
  if (h < 5) return 0.002
  if (h < 7) return 0.008
  if (h < 9) return 0.03
  if (h < 17) return 0.022
  if (h < 20) return 0.03
  if (h < 23) return 0.012
  return 0.005
}

/** Shops, restaurants and bars: activity by hour (1 = evening peak). */
function commercialCurve(h: number, weekend: boolean): number {
  const k = [0.25, 0.15, 0.08, 0.05, 0.04, 0.05, 0.1, 0.2, 0.35, 0.45, 0.6, 0.7, 0.85, 0.8, 0.75, 0.78, 0.85, 0.95, 1, 0.95, 0.85, 0.7, 0.55, 0.4]
  const i = Math.floor(h) % 24
  const v = k[i] + (k[(i + 1) % 24] - k[i]) * (h - Math.floor(h))
  return v * (weekend ? 1.25 : 1)
}

/** Station flows: morning and evening rush. */
function rushCurve(h: number, weekend: boolean): number {
  const g = (mu: number, s: number) => Math.exp(-((h - mu) ** 2) / (2 * s * s))
  const v = h < 5 ? 0.02 : 0.25 + 0.95 * g(8.1, 0.8) + 0.85 * g(18.2, 1.2) + 0.15 * g(12.5, 1.5)
  return weekend ? 0.35 + 0.4 * g(14, 3) : v
}

export interface DensityInputs {
  residentsPerKm2: number
  shopsWithin300m: number
  stations: { riders: number; distance: number }[]
  hour: number
  weekend: boolean
  rain: number // 0..1
  hotspot: number // 0..1 curated tourist sites
}

export function pedestriansPerHectare(i: DensityInputs): number {
  const res = (i.residentsPerKm2 / 100) * outdoorShare(i.hour)
  const shops = (i.shopsWithin300m / 28) * 5.5 * commercialCurve(i.hour, i.weekend)
  let station = 0
  for (const s of i.stations) station += (s.riders / 1e6) * 45 * Math.exp(-s.distance / 260)
  station *= rushCurve(i.hour, i.weekend)
  const tourism = i.hotspot * 60 * (i.hour > 8 && i.hour < 19 ? 1 : 0.25)
  const weather = 1 - 0.45 * i.rain
  return (res + shops + station + tourism) * weather
}
