// Domestic flights (国内線): the way most visitors cover the long distances -
// Tokyo to Sapporo, Fukuoka or Okinawa, and on to the outer islands. The big
// hubs fly everywhere; regional airports fly to the hubs; the Yaeyama and
// Amami islands hang off Naha and Kagoshima. Coordinates are the passenger
// terminals (where you check in and where you walk out on arrival).

export interface Airport {
  code: string
  ja: string
  en: string
  lat: number
  lon: number
  hub?: boolean
  /** Extra non-hub links (island hops). */
  links?: string[]
}

export const AIRPORTS: Airport[] = [
  { code: 'HND', ja: '羽田空港', en: 'Tokyo Haneda', lat: 35.549, lon: 139.7841, hub: true },
  { code: 'NRT', ja: '成田空港', en: 'Tokyo Narita', lat: 35.7647, lon: 140.3863 },
  { code: 'ITM', ja: '伊丹空港', en: 'Osaka Itami', lat: 34.7866, lon: 135.4387, hub: true },
  { code: 'KIX', ja: '関西国際空港', en: 'Kansai', lat: 34.4351, lon: 135.244 },
  { code: 'NGO', ja: '中部国際空港', en: 'Chubu Centrair', lat: 34.8584, lon: 136.8124, hub: true },
  { code: 'CTS', ja: '新千歳空港', en: 'New Chitose (Sapporo)', lat: 42.7869, lon: 141.6807, hub: true },
  { code: 'FUK', ja: '福岡空港', en: 'Fukuoka', lat: 33.5862, lon: 130.4507, hub: true },
  { code: 'OKA', ja: '那覇空港', en: 'Naha (Okinawa)', lat: 26.2063, lon: 127.6505, hub: true, links: ['ISG', 'MMY', 'KOJ'] },
  { code: 'SDJ', ja: '仙台空港', en: 'Sendai', lat: 38.136, lon: 140.9234 },
  { code: 'HIJ', ja: '広島空港', en: 'Hiroshima', lat: 34.4373, lon: 132.921 },
  { code: 'KOJ', ja: '鹿児島空港', en: 'Kagoshima', lat: 31.8005, lon: 130.7189, links: ['ASJ', 'KUM', 'OKA'] },
  { code: 'KMJ', ja: '熊本空港', en: 'Kumamoto', lat: 32.8373, lon: 130.858 },
  { code: 'NGS', ja: '長崎空港', en: 'Nagasaki', lat: 32.916, lon: 129.9147 },
  { code: 'KMI', ja: '宮崎空港', en: 'Miyazaki', lat: 31.877, lon: 131.4441 },
  { code: 'OIT', ja: '大分空港', en: 'Oita', lat: 33.4795, lon: 131.7366 },
  { code: 'MYJ', ja: '松山空港', en: 'Matsuyama', lat: 33.827, lon: 132.7045 },
  { code: 'TAK', ja: '高松空港', en: 'Takamatsu', lat: 34.216, lon: 134.017 },
  { code: 'KCZ', ja: '高知龍馬空港', en: 'Kochi', lat: 33.548, lon: 133.674 },
  { code: 'OKJ', ja: '岡山空港', en: 'Okayama', lat: 34.7569, lon: 133.8553 },
  { code: 'IZO', ja: '出雲縁結び空港', en: 'Izumo', lat: 35.4136, lon: 132.89 },
  { code: 'KMQ', ja: '小松空港', en: 'Komatsu (Kanazawa)', lat: 36.3948, lon: 136.4078 },
  { code: 'KIJ', ja: '新潟空港', en: 'Niigata', lat: 37.953, lon: 139.115 },
  { code: 'AOJ', ja: '青森空港', en: 'Aomori', lat: 40.7347, lon: 140.6908 },
  { code: 'HKD', ja: '函館空港', en: 'Hakodate', lat: 41.7722, lon: 140.823 },
  { code: 'AKJ', ja: '旭川空港', en: 'Asahikawa', lat: 43.6708, lon: 142.4475 },
  { code: 'KUH', ja: 'たんちょう釧路空港', en: 'Kushiro', lat: 43.0411, lon: 144.1928 },
  { code: 'MMB', ja: '女満別空港', en: 'Memanbetsu', lat: 43.8806, lon: 144.1642 },
  { code: 'ISG', ja: '南ぬ島 石垣空港', en: 'Ishigaki', lat: 24.3964, lon: 124.245, links: ['OKA', 'MMY'] },
  { code: 'MMY', ja: '宮古空港', en: 'Miyako', lat: 24.7828, lon: 125.295, links: ['OKA', 'ISG'] },
  { code: 'ASJ', ja: '奄美空港', en: 'Amami', lat: 28.4306, lon: 129.7125, links: ['KOJ'] },
  { code: 'KUM', ja: '屋久島空港', en: 'Yakushima', lat: 30.3856, lon: 130.6589, links: ['KOJ'] },
]

export function airport(code: string): Airport | undefined {
  return AIRPORTS.find((a) => a.code === code)
}

export function flightKm(a: Airport, b: Airport): number {
  const R = 6371
  const p1 = (a.lat * Math.PI) / 180
  const p2 = (b.lat * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((b.lon - a.lon) * Math.PI) / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Block time in minutes (taxi, climb, cruise at ~650 km/h over the ground, descent). */
export function flightMinutes(km: number): number {
  return Math.round(25 + (km / 650) * 60)
}

/** An advance-purchase economy fare (早割), yen. */
export function flightFare(km: number): number {
  return Math.round((7000 + km * 9) / 100) * 100
}

/** Where you can fly from here: hubs fly everywhere, others to the hubs (plus island hops). */
export function destinations(from: Airport): Airport[] {
  return AIRPORTS.filter((b) => {
    if (b === from) return false
    // Short hops on the main islands go by Shinkansen, not plane.
    if (flightKm(from, b) < 310 && !from.links?.includes(b.code) && !b.links?.includes(from.code)) return false
    return from.hub || b.hub || from.links?.includes(b.code) || b.links?.includes(from.code)
  }).sort((a, b) => flightKm(from, a) - flightKm(from, b))
}

/** The airport you are at, if any (within ~3 km of its terminal). */
export function airportNear(lat: number, lon: number): Airport | undefined {
  let best: Airport | undefined
  let bd = 3
  for (const a of AIRPORTS) {
    const d = flightKm(a, { code: '', ja: '', en: '', lat, lon })
    if (d < bd) {
      bd = d
      best = a
    }
  }
  return best
}
