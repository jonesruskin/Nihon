// Fireworks festivals (花火大会) on their real dates and launch sites. Most
// run one summer evening; Lake Toya fires a short show every night from
// spring to autumn. Dates follow each festival's usual rule (e.g. Sumidagawa:
// the last Saturday of July).

export interface Festival {
  ja: string
  en: string
  lat: number
  lon: number
  /** Is the festival on this (JST) date? month 1-12, weekday 0 = Sunday. */
  on: (y: number, m: number, d: number, weekday: number) => boolean
  /** Show window, JST hours. */
  from: number
  to: number
  /** Shells per minute at the peak, and the biggest shell size (m burst radius). */
  rate: number
  size: number
  blurb: string
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** Last given weekday of a month. */
const lastWeekday = (m: number, wd: number) => (y: number, mm: number, d: number, w: number) => mm === m && w === wd && d + 7 > daysIn(y, m)
const firstWeekday = (m: number, wd: number) => (_y: number, mm: number, d: number, w: number) => mm === m && w === wd && d <= 7
const dates = (m: number, ...days: number[]) => (_y: number, mm: number, d: number) => mm === m && days.includes(d)

export const FESTIVALS: Festival[] = [
  { ja: '隅田川花火大会', en: 'Sumidagawa Fireworks', lat: 35.7135, lon: 139.8048, on: lastWeekday(7, 6), from: 19, to: 20.5, rate: 22, size: 120, blurb: 'Edo’s fireworks, held on the Sumida since 1733 — some 20,000 shells and nearly a million people on the riverbanks and rooftops.' },
  { ja: '長岡まつり大花火大会', en: 'Nagaoka Fireworks', lat: 37.4467, lon: 138.8433, on: dates(8, 2, 3), from: 19.33, to: 21.25, rate: 18, size: 260, blurb: 'Held in memory of the 1945 air raid; its giant 正三尺玉 shells burst 650 m wide over the Shinano River, and the Phoenix (フェニックス) spans two kilometres.' },
  { ja: '大曲の花火', en: 'Omagari Fireworks Competition', lat: 39.4697, lon: 140.4706, on: lastWeekday(8, 6), from: 18.83, to: 21.5, rate: 16, size: 180, blurb: 'The national competition of fireworks makers: pyrotechnicians compete for the Prime Minister’s Prize with shells they designed themselves.' },
  { ja: '天神祭奉納花火', en: 'Tenjin Matsuri Fireworks', lat: 34.6965, lon: 135.5165, on: dates(7, 25), from: 19.5, to: 21, rate: 12, size: 100, blurb: 'The climax of Osaka’s Tenjin Matsuri: a hundred boats on the Okawa river under fireworks offered to the god of learning.' },
  { ja: 'びわ湖大花火大会', en: 'Lake Biwa Fireworks', lat: 35.0105, lon: 135.8665, on: dates(8, 8), from: 19.5, to: 20.5, rate: 20, size: 140, blurb: 'Star mines reflected in Japan’s largest lake, seen from the Otsu waterfront.' },
  { ja: '諏訪湖祭湖上花火大会', en: 'Lake Suwa Fireworks', lat: 36.0467, lon: 138.0904, on: dates(8, 15), from: 19, to: 21, rate: 18, size: 160, blurb: 'Fired over the lake ringed by mountains, so every boom echoes back — and the water-borne 水上スターマイン fan out across the surface.' },
  { ja: '熊野大花火大会', en: 'Kumano Fireworks', lat: 33.889, lon: 136.101, on: dates(8, 17), from: 19.17, to: 21.5, rate: 14, size: 150, blurb: 'Fireworks lit against the sea cliffs of Onigajo — a rite for the dead of Obon that goes back three centuries.' },
  { ja: '土浦全国花火競技大会', en: 'Tsuchiura Fireworks Competition', lat: 36.073, lon: 140.2075, on: firstWeekday(11, 6), from: 17.5, to: 20.5, rate: 15, size: 150, blurb: 'One of Japan’s three great competitions, held in autumn when the air is clear.' },
  {
    ja: '洞爺湖ロングラン花火大会',
    en: 'Lake Toya Long-Run Fireworks',
    lat: 42.5645,
    lon: 140.8195,
    on: (_y, m, d) => (m === 4 && d >= 28) || (m > 4 && m < 10) || (m === 10 && d <= 31),
    from: 20.75,
    to: 21.08,
    rate: 14,
    size: 90,
    blurb: 'Every night from late April to October, a boat cruises the lake firing twenty minutes of fireworks over the onsen town.',
  },
]

/** Festivals running now (or within `lead` hours) near a point. */
export function festivalsNear(lat: number, lon: number, y: number, m: number, d: number, weekday: number, hour: number, radiusKm = 30, lead = 0): Festival[] {
  return FESTIVALS.filter((f) => {
    if (!f.on(y, m, d, weekday)) return false
    if (hour < f.from - lead || hour > f.to) return false
    const k = Math.cos((lat * Math.PI) / 180)
    return Math.hypot((f.lat - lat) * 111.13, (f.lon - lon) * 111.41 * k) < radiusKm
  })
}
