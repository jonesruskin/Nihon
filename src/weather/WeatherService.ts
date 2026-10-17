// Real weather from Open-Meteo (free, no key): the current conditions at
// the player's spot when playing "now", the recorded weather for a past
// date, or a climate-based draw when offline or far in the future.
import { climateWeather, type WeatherNow } from './climate'

const VARS = 'temperature_2m,relative_humidity_2m,precipitation,rain,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,snow_depth,visibility'

interface Cache {
  key: string
  at: number
  hours: Map<string, WeatherNow> // 'YYYY-MM-DDTHH' (JST) -> weather
}

export class WeatherService {
  private cache: Cache | null = null
  private inflight: Promise<void> | null = null
  private failedUntil = 0

  /** Weather for a place and time; falls back to climate while fetching. */
  get(lat: number, lon: number, elevation: number, date: Date): WeatherNow {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)},${jstDay(date)}`
    const hour = jstHour(date)
    if (this.cache && this.cache.key === key) {
      const w = this.cache.hours.get(hour)
      if (w) return w
    } else if (!this.inflight && performance.now() > this.failedUntil) {
      this.inflight = this.fetch(key, lat, lon, date).finally(() => (this.inflight = null))
    }
    return climateWeather(lat, lon, elevation, date)
  }

  private async fetch(key: string, lat: number, lon: number, date: Date): Promise<void> {
    const day = jstDay(date)
    const ageDays = (Date.now() - date.getTime()) / 86400e3
    // The forecast API covers the last ~90 days and the next two weeks; the
    // archive covers everything since 1940.
    const base = ageDays < 85 && ageDays > -15 ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive'
    const url = `${base}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=${VARS}&start_date=${day}&end_date=${day}&timezone=Asia%2FTokyo&wind_speed_unit=ms`
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 12000)
      const res = await fetch(url, { signal: ctl.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`open-meteo ${res.status}`)
      const j = await res.json()
      const h = j.hourly
      const hours = new Map<string, WeatherNow>()
      const live = Math.abs(ageDays) < 1
      for (let i = 0; i < h.time.length; i++) {
        hours.set(String(h.time[i]).slice(0, 13), {
          code: h.weather_code[i] ?? 0,
          cloud: (h.cloud_cover[i] ?? 0) / 100,
          rain: h.rain?.[i] ?? h.precipitation?.[i] ?? 0,
          snow: h.snowfall?.[i] ?? 0,
          temp: h.temperature_2m[i] ?? 15,
          humidity: h.relative_humidity_2m[i] ?? 60,
          wind: h.wind_speed_10m[i] ?? 2,
          windDir: h.wind_direction_10m[i] ?? 0,
          snowDepth: h.snow_depth?.[i] ?? 0,
          visibility: h.visibility?.[i] ?? 25000,
          source: live ? 'live' : 'archive',
        })
      }
      this.cache = { key, at: Date.now(), hours }
    } catch (e) {
      console.warn('weather fetch failed, using climate', e)
      this.failedUntil = performance.now() + 120_000
    }
  }
}

function jstParts(d: Date): Date {
  return new Date(d.getTime() + 9 * 3600e3)
}

function jstDay(d: Date): string {
  return jstParts(d).toISOString().slice(0, 10)
}

function jstHour(d: Date): string {
  return jstParts(d).toISOString().slice(0, 13)
}
