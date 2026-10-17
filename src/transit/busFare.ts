// How you pay for a bus depends on where you are, and getting it right is
// half the adventure for a visitor:
//  - Big-city flat fare (均一運賃): one price anywhere on the network. In
//    Tokyo's 23 wards, Yokohama, Kawasaki and Nagoya you board at the front
//    and pay (tap) as you get on (前乗り先払い).
//  - Kyoto and Osaka are flat too, but you board in the middle or rear and
//    pay at the front when you get off (後払い).
//  - Everywhere else the fare grows with distance (対キロ区間制): take a
//    numbered ticket (整理券) or tap your IC card when you board through the
//    rear door; the board above the driver shows the fare for each ticket
//    number, and you pay at the front as you leave.
// Fares are IC-card adult fares, rounded the way operators publish them.
import type { Address } from '../core/address'

export type BusPayment = 'flat-front' | 'flat-exit' | 'distance'

export interface BusRule {
  payment: BusPayment
  /** Flat fare, or the initial fare for distance-based buses (yen). */
  fare: number
  /** Operator area shown to the player. */
  area: string
}

const FLAT: Array<{ test: (a: Address) => boolean; rule: BusRule }> = [
  { test: (a) => a.prefCode === 13 && /区$/.test(a.city), rule: { payment: 'flat-front', fare: 210, area: '東京23区' } },
  { test: (a) => a.city.startsWith('横浜市'), rule: { payment: 'flat-front', fare: 220, area: '横浜市' } },
  { test: (a) => a.city.startsWith('川崎市'), rule: { payment: 'flat-front', fare: 220, area: '川崎市' } },
  { test: (a) => a.city.startsWith('名古屋市'), rule: { payment: 'flat-front', fare: 210, area: '名古屋市' } },
  { test: (a) => a.city.startsWith('京都市'), rule: { payment: 'flat-exit', fare: 230, area: '京都市' } },
  { test: (a) => a.city.startsWith('大阪市'), rule: { payment: 'flat-exit', fare: 210, area: '大阪市' } },
]

export function busRule(addr: Address | null): BusRule {
  if (addr) for (const f of FLAT) if (f.test(addr)) return f.rule
  return { payment: 'distance', fare: 170, area: addr?.city ?? '' }
}

/** Distance-based fare: ¥170 for the first 1.5 km, then about ¥38 a km. */
export function distanceFare(km: number): number {
  const raw = 170 + Math.max(0, km - 1.5) * 38
  return Math.min(3500, Math.ceil(raw / 10) * 10)
}
