// The seasonal fronts that sweep Japan every year, from JMA phenology:
//   sakura (桜前線): Okinawa's kanhi-zakura in January, Kyushu late March,
//     Tokyo ~24 March, Sendai ~8 April, Aomori ~24 April, Sapporo ~3 May;
//     about 2.5 days later per 100 m of altitude, ~10 days of blossom.
//   koyo (紅葉前線): runs the other way, Hokkaido mid-October to Kyushu
//     early December; earlier with altitude.

/** Day of year of full sakura bloom at a place. */
export function sakuraPeak(lat: number, elevation: number): number {
  const pts: [number, number][] = [[26, 30], [31.6, 86], [33.6, 83], [34.7, 84], [35.7, 84], [38.3, 99], [40.8, 115], [43.1, 124], [45, 130]]
  let d = pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (lat <= pts[i][0]) {
      const t = (lat - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])
      d = pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])
      break
    }
    d = pts[i][1]
  }
  return d + (Math.max(0, elevation) / 100) * 2.5
}

/** Day of year of peak autumn colour. */
export function koyoPeak(lat: number, elevation: number): number {
  const pts: [number, number][] = [[26, 355], [31.6, 340], [33.6, 334], [34.7, 330], [35.7, 333], [38.3, 316], [40.8, 305], [43.1, 296], [45, 290]]
  let d = pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (lat <= pts[i][0]) {
      const t = (lat - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])
      d = pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])
      break
    }
    d = pts[i][1]
  }
  return d - (Math.max(0, elevation) / 100) * 3
}

export interface SeasonState {
  bloom: number // 0..1 sakura blossom
  autumn: number // 0..1 autumn colour
  bare: number // 0..1 deciduous leaf loss
}

export function seasonAt(lat: number, elevation: number, dayOfYear: number): SeasonState {
  const sp = sakuraPeak(lat, elevation)
  const kp = koyoPeak(lat, elevation)
  const dist = (a: number, b: number) => {
    let d = a - b
    if (d > 182) d -= 365
    if (d < -182) d += 365
    return d
  }
  const ds = dist(dayOfYear, sp)
  // Buds open ~5 days before peak, petals fall ~7 days after.
  const bloom = ds < -6 ? 0 : ds < 0 ? (ds + 6) / 6 : ds < 6 ? 1 : ds < 12 ? 1 - (ds - 6) / 6 : 0
  const dk = dist(dayOfYear, kp)
  const autumn = dk < -25 ? 0 : dk < 0 ? (dk + 25) / 25 : dk < 15 ? 1 : dk < 30 ? 1 - (dk - 15) / 15 : 0
  // Bare from ~2 weeks after koyo peak until leaf-out ~10 days after sakura.
  const fall = dist(dayOfYear, kp + 18)
  const leafOut = dist(dayOfYear, sp + 8)
  let bare = 0
  if (fall > 0 && leafOut < 0) bare = Math.min(1, fall / 12, -leafOut / 10)
  // Okinawa stays green all year.
  if (lat < 27.5) return { bloom, autumn: 0, bare: 0 }
  return { bloom, autumn, bare: Math.min(0.85, bare) }
}
