// All-direction "scramble" crossings (スクランブル交差点): every vehicle signal
// turns red at once and pedestrians flood across in every direction,
// diagonals included. Shibuya's is the world's busiest, with up to ~3,000
// people per green phase.

export interface ScrambleSite {
  name: string
  lat: number
  lon: number
  /** Full signal cycle (s) and the all-pedestrian phase at its start (s). */
  cycle: number
  ped: number
  radius: number
}

export const SCRAMBLES: ScrambleSite[] = [
  { name: '渋谷スクランブル交差点', lat: 35.659482, lon: 139.70056, cycle: 104, ped: 42, radius: 26 },
  { name: '原宿 神宮前交差点', lat: 35.668861, lon: 139.705472, cycle: 96, ped: 36, radius: 18 },
  { name: '銀座 数寄屋橋交差点', lat: 35.672877, lon: 139.762897, cycle: 110, ped: 40, radius: 24 },
]

/** Seconds into the pedestrian phase, or -1 while vehicles have green. */
export function scrambleWalkTime(site: ScrambleSite, clockSeconds: number): number {
  const t = ((clockSeconds % site.cycle) + site.cycle) % site.cycle
  return t < site.ped ? t : -1
}
