// Japan's climate, for dates where live/historical data is unavailable.
// JMA 1991-2020 normals for representative stations: mean temperature (°C)
// and days with >= 1 mm precipitation, per month. The nearest station (with
// a 6.5 °C/km lapse rate) drives a deterministic day-by-day weather draw:
// snowy Sea-of-Japan winters, dry sunny Pacific winters, tsuyu in June-July
// (not in Hokkaido), typhoons in late summer.

interface Normals {
  name: string
  lat: number
  lon: number
  temp: number[]
  wetDays: number[]
  /** Sea-of-Japan side: winter monsoon brings snow showers. */
  snowSide?: boolean
}

const STATIONS: Normals[] = [
  { name: 'Sapporo', lat: 43.06, lon: 141.33, temp: [-3.2, -2.7, 1.1, 7.3, 13, 17, 21.1, 22.3, 18.6, 12.1, 5.2, -0.9], wetDays: [17, 14, 12, 9, 9, 8, 9, 10, 11, 12, 15, 17], snowSide: true },
  { name: 'Kushiro', lat: 42.98, lon: 144.38, temp: [-5.4, -4.7, -0.9, 3.7, 8.1, 11.7, 15.6, 18, 16.6, 11.3, 4.8, -1.9], wetDays: [4, 4, 6, 8, 10, 10, 11, 11, 11, 9, 7, 5] },
  { name: 'Aomori', lat: 40.82, lon: 140.77, temp: [-0.9, -0.4, 2.8, 8.5, 13.7, 17.6, 21.8, 23.5, 19.9, 13.5, 7.2, 1.8], wetDays: [22, 18, 14, 10, 10, 9, 11, 10, 11, 12, 16, 21], snowSide: true },
  { name: 'Sendai', lat: 38.26, lon: 140.9, temp: [2, 2.4, 5.5, 10.7, 15.6, 19.2, 22.9, 24.4, 21.2, 15.7, 9.8, 4.5], wetDays: [4, 5, 8, 9, 10, 12, 14, 11, 12, 9, 7, 5] },
  { name: 'Niigata', lat: 37.9, lon: 139.02, temp: [3, 3.3, 6.4, 11.6, 16.9, 21, 25, 26.6, 22.8, 16.9, 10.9, 5.6], wetDays: [22, 18, 15, 11, 10, 10, 12, 9, 11, 13, 17, 22], snowSide: true },
  { name: 'Kanazawa', lat: 36.59, lon: 136.63, temp: [4, 4.3, 7.4, 12.6, 17.6, 21.6, 25.8, 27.4, 23.4, 17.8, 12.1, 6.8], wetDays: [23, 19, 16, 12, 10, 11, 12, 9, 12, 13, 17, 22], snowSide: true },
  { name: 'Nagano', lat: 36.66, lon: 138.19, temp: [-0.4, 0.4, 4.1, 10.6, 16.3, 20.4, 24.3, 25.4, 21, 14.3, 7.9, 2.3], wetDays: [7, 7, 8, 8, 9, 11, 12, 9, 10, 8, 6, 6] },
  { name: 'Tokyo', lat: 35.69, lon: 139.75, temp: [5.4, 6.1, 9.4, 14.3, 18.8, 21.9, 25.7, 26.9, 23.3, 18, 12.5, 7.7], wetDays: [5, 6, 10, 10, 10, 12, 11, 8, 11, 10, 8, 5] },
  { name: 'Nagoya', lat: 35.17, lon: 136.97, temp: [4.8, 5.5, 9.2, 14.6, 19.4, 23, 26.9, 28.2, 24.5, 18.6, 12.6, 7.2], wetDays: [5, 6, 10, 10, 10, 12, 12, 9, 11, 9, 7, 5] },
  { name: 'Osaka', lat: 34.68, lon: 135.52, temp: [6.2, 6.9, 10.3, 15.6, 20.3, 23.7, 27.7, 29, 25.2, 19.6, 13.9, 8.7], wetDays: [6, 7, 10, 10, 10, 12, 10, 7, 10, 8, 7, 6] },
  { name: 'Hiroshima', lat: 34.4, lon: 132.46, temp: [5.7, 6.6, 9.9, 15.1, 19.8, 23.5, 27.4, 28.7, 25, 19.4, 13.4, 7.9], wetDays: [6, 7, 10, 10, 10, 13, 11, 8, 10, 7, 7, 6] },
  { name: 'Kochi', lat: 33.57, lon: 133.55, temp: [6.7, 7.9, 11.3, 15.8, 19.9, 23.2, 27, 27.9, 25.2, 20.1, 14.4, 8.8], wetDays: [5, 7, 10, 10, 11, 14, 12, 11, 12, 8, 7, 5] },
  { name: 'Fukuoka', lat: 33.58, lon: 130.38, temp: [6.9, 7.8, 10.8, 15.4, 19.9, 23.3, 27.4, 28.4, 24.7, 19.6, 14.2, 9.1], wetDays: [9, 9, 11, 10, 9, 12, 11, 9, 10, 7, 8, 9] },
  { name: 'Kagoshima', lat: 31.55, lon: 130.55, temp: [8.7, 9.9, 12.8, 16.9, 20.8, 24, 28.1, 28.8, 26.3, 21.5, 16.1, 10.6], wetDays: [7, 8, 11, 10, 10, 15, 12, 10, 10, 6, 7, 6] },
  { name: 'Naha', lat: 26.21, lon: 127.69, temp: [17.3, 17.5, 19.1, 21.5, 24.2, 27.2, 29.1, 29, 27.9, 25.5, 22.5, 19], wetDays: [10, 10, 11, 10, 11, 12, 9, 12, 11, 8, 8, 9] },
]

function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return s - Math.floor(s)
}

export interface WeatherNow {
  code: number // WMO weather code
  cloud: number // 0..1
  rain: number // mm/h
  snow: number // cm/h (fresh)
  temp: number // °C
  humidity: number // %
  wind: number // m/s
  windDir: number // degrees from
  snowDepth: number // m on the ground
  visibility: number // m
  source: 'live' | 'archive' | 'climate' | 'manual'
}

/** Deterministic plausible weather for a place, date and hour. */
export function climateWeather(lat: number, lon: number, elevation: number, date: Date): WeatherNow {
  // Nearest station, weighting longitude by latitude.
  let st = STATIONS[0]
  let bd = Infinity
  for (const s of STATIONS) {
    const d = Math.hypot(s.lat - lat, (s.lon - lon) * Math.cos((lat * Math.PI) / 180))
    if (d < bd) {
      bd = d
      st = s
    }
  }
  const jst = new Date(date.getTime() + 9 * 3600e3)
  const m = jst.getUTCMonth()
  const day = Math.floor(jst.getTime() / 86400e3)
  const hour = jst.getUTCHours() + jst.getUTCMinutes() / 60
  // Interpolate monthly normals by day of month.
  const frac = (jst.getUTCDate() - 15) / 30
  const m2 = (m + (frac >= 0 ? 1 : 11)) % 12
  const w = Math.abs(frac)
  const tMean = st.temp[m] * (1 - w) + st.temp[m2] * w - 6.5 * (elevation / 1000)
  const wet = (st.wetDays[m] * (1 - w) + st.wetDays[m2] * w) / 30
  const seed = day * 31 + Math.round(st.lat * 10)
  const r = hash(seed)
  // Wet spells persist: today's draw leans on yesterday's.
  const wetToday = (r * 0.65 + hash(seed - 31) * 0.35) < wet
  // Typhoons: Aug-Oct, south and west of Tokyo-ish, a few days a season.
  const typhoon = m >= 7 && m <= 9 && lat < 36.5 && hash(seed * 7 + 3) < 0.025
  const diurnal = -Math.cos(((hour - 4.5) / 24) * Math.PI * 2) * (wetToday ? 2 : 4.5)
  const temp = tMean + diurnal + (hash(seed + 5) - 0.5) * 4
  const precipHour = wetToday && hash(seed * 13 + Math.floor(hour / 3)) < 0.7
  const intensity = typhoon ? 12 + hash(seed + 9) * 25 : precipHour ? 0.5 + Math.pow(hash(seed * 17 + Math.floor(hour)), 2) * 6 : 0
  const snowy = temp < 1.2 && intensity > 0
  // Pacific-side winters are famously clear; tsuyu (Jun-Jul) is grey.
  const tsuyu = (m === 5 || m === 6) && lat < 41 && !(m === 6 && jst.getUTCDate() > 20)
  const baseCloud = wetToday ? 0.85 + hash(seed + 2) * 0.15 : tsuyu ? 0.55 + hash(seed + 2) * 0.4 : (st.snowSide && (m <= 1 || m === 11) ? 0.6 : 0.1) + hash(seed + 2) * 0.6
  const cloud = Math.min(1, typhoon ? 1 : baseCloud)
  const code = typhoon ? 65 : intensity > 0 ? (snowy ? (intensity > 3 ? 75 : 73) : intensity > 4 ? 63 : 61) : cloud > 0.85 ? 3 : cloud > 0.5 ? 2 : cloud > 0.2 ? 1 : 0
  return {
    code,
    cloud,
    rain: snowy ? 0 : intensity,
    snow: snowy ? intensity * 0.8 : 0,
    temp,
    humidity: wetToday ? 90 : m >= 5 && m <= 8 ? 75 : 55,
    wind: typhoon ? 22 : 1.5 + hash(seed + 11) * 5,
    windDir: hash(seed + 12) * 360,
    snowDepth: st.snowSide && (m <= 1 || m === 11) && tMean < 3 ? Math.max(0, (3 - tMean) * 0.12) : tMean < -1 ? 0.2 : 0,
    visibility: typhoon ? 2000 : intensity > 3 ? 6000 : wetToday ? 12000 : 30000,
    source: 'climate',
  }
}

/** Short bilingual label for a WMO code. */
export function weatherLabel(code: number): { ja: string; en: string; icon: string } {
  if (code === 0) return { ja: '快晴', en: 'Clear', icon: '☀' }
  if (code <= 2) return { ja: '晴れ', en: 'Fair', icon: '🌤' }
  if (code === 3) return { ja: '曇り', en: 'Cloudy', icon: '☁' }
  if (code === 45 || code === 48) return { ja: '霧', en: 'Fog', icon: '🌫' }
  if (code >= 51 && code <= 57) return { ja: '霧雨', en: 'Drizzle', icon: '🌦' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return code >= 65 || code === 82 ? { ja: '大雨', en: 'Heavy rain', icon: '☔' } : { ja: '雨', en: 'Rain', icon: '☂' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { ja: '雪', en: 'Snow', icon: '❄' }
  if (code >= 95) return { ja: '雷雨', en: 'Thunderstorm', icon: '⛈' }
  return { ja: '晴れ', en: 'Fair', icon: '🌤' }
}
