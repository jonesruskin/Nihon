// Turns the weather (live, historical or climatological) into the world:
// cloud cover and type, dimmed sun, fog, rain and snow, streets that get wet
// and dry again, snow that settles and melts, umbrellas, thinner crowds,
// and the seasonal colour of the trees.
import { Vector3 } from 'three'
import { climateWeather, weatherLabel, type WeatherNow } from './climate'
import { WeatherService } from './WeatherService'
import { Precipitation } from './Precipitation'
import { seasonAt } from './seasons'
import { buildingUniforms } from '../render/materials/building'
import { seasonUniforms } from '../world/props/models'
import type { RenderPipeline } from '../render/Renderer'

export type WeatherPreset = 'live' | 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog' | 'typhoon'

const PRESETS: Record<Exclude<WeatherPreset, 'live'>, Partial<WeatherNow>> = {
  clear: { code: 0, cloud: 0.05, rain: 0, snow: 0, visibility: 40000, wind: 2 },
  cloudy: { code: 3, cloud: 0.95, rain: 0, snow: 0, visibility: 20000, wind: 3 },
  rain: { code: 63, cloud: 1, rain: 4, snow: 0, visibility: 8000, wind: 3 },
  storm: { code: 95, cloud: 1, rain: 18, snow: 0, visibility: 3000, wind: 9 },
  snow: { code: 73, cloud: 1, rain: 0, snow: 1.8, visibility: 4000, wind: 2, temp: -2, snowDepth: 0.3 },
  fog: { code: 45, cloud: 0.9, rain: 0, snow: 0, visibility: 350, wind: 0.5 },
  typhoon: { code: 65, cloud: 1, rain: 30, snow: 0, visibility: 1500, wind: 24 },
}

export class WeatherSystem {
  readonly precip = new Precipitation(16000)
  private service = new WeatherService()
  preset: WeatherPreset = 'live'
  /** Smoothed state actually shown. */
  now: WeatherNow = climateWeather(35.7, 139.7, 0, new Date())
  wetness = 0
  snowCover = 0
  private timer = 0
  private target: WeatherNow = this.now
  readonly wind = new Vector3()
  budget = 8000

  update(dt: number, lat: number, lon: number, elevation: number, date: Date, pipeline: RenderPipeline): void {
    this.timer -= dt
    if (this.timer <= 0) {
      this.timer = this.preset === 'live' ? 5 : 0.5
      const base = this.service.get(lat, lon, elevation, date)
      this.target = this.preset === 'live' ? base : { ...base, ...PRESETS[this.preset], source: 'manual' }
      // Season from the real date and place.
      const j = new Date(date.getTime() + 9 * 3600e3)
      const doy = Math.floor((j.getTime() - Date.UTC(j.getUTCFullYear(), 0, 1)) / 86400e3) + 1
      const s = seasonAt(lat, elevation, doy)
      seasonUniforms.uBloom.value = s.bloom
      seasonUniforms.uAutumn.value = s.autumn
      seasonUniforms.uBare.value = s.bare
    }
    // Live weather eases over ~half a minute; a chosen preset within seconds.
    const manual = this.preset !== 'live'
    const k = Math.min(1, dt / (manual ? 2 : 30))
    const n = this.now
    const t = this.target
    const lerp = (a: number, b: number) => a + (b - a) * k
    this.now = {
      ...t,
      cloud: lerp(n.cloud, t.cloud),
      rain: lerp(n.rain, t.rain),
      snow: lerp(n.snow, t.snow),
      temp: lerp(n.temp, t.temp),
      wind: lerp(n.wind, t.wind),
      visibility: Math.exp(lerp(Math.log(Math.max(50, n.visibility)), Math.log(Math.max(50, t.visibility)))),
      snowDepth: lerp(n.snowDepth, t.snowDepth),
    }
    const w = this.now
    // Streets wet up within minutes of rain and dry over an hour or two.
    const raining = w.rain > 0.1
    this.wetness = raining ? Math.min(1, this.wetness + dt * (0.002 + w.rain * 0.004)) : Math.max(0, this.wetness - dt * (w.temp > 20 ? 0.00025 : 0.00014))
    // Snow settles when it's cold, melts when it's not; live data gives depth directly.
    const settled = Math.min(1, w.snowDepth / 0.08)
    this.snowCover += ((w.snow > 0.05 && w.temp < 1.5 ? Math.max(settled, Math.min(1, this.snowCover + dt * 0.002)) : settled) - this.snowCover) * Math.min(1, dt / (manual ? 3 : 20))
    if (manual && !raining) this.wetness = Math.max(0, this.wetness - dt * 0.05)
    if (manual && raining) this.wetness = Math.min(1, this.wetness + dt * 0.1)
    buildingUniforms.uWet.value = Math.max(this.wetness, w.snow > 0.05 ? 0.3 : 0) * (1 - this.snowCover * 0.6)
    buildingUniforms.uSnow.value = this.snowCover

    // Sky and light.
    const dir = (w.windDir * Math.PI) / 180
    this.wind.set(-Math.sin(dir) * w.wind, 0, Math.cos(dir) * w.wind) // blowing from windDir
    pipeline.overcast = Math.min(1, Math.pow(w.cloud, 1.6) * 0.8 + Math.min(0.25, w.rain * 0.04))
    pipeline.clouds.coverage = 0.12 + 0.78 * w.cloud
    const low = pipeline.clouds.cloudLayers[0]
    if (low) {
      low.densityScale = 0.2 + 0.25 * Math.min(1, w.rain / 4 + w.snow)
      low.altitude = 750 - 250 * Math.min(1, w.rain / 4 + w.snow)
    }
    pipeline.clouds.localWeatherVelocity.set((this.wind.x / 6) * 0.00004, (this.wind.z / 6) * 0.00004)
    pipeline.fogDensity = Math.min(0.02, 3.9 / Math.max(80, w.visibility)) * (w.visibility < 15000 ? 1 : 0.3)
    const light = (1 - pipeline.night) * (1 - pipeline.overcast * 0.5)
    this.precip.update(dt, w.rain, w.snow, this.wind, light, this.budget)
  }

  label(): string {
    const l = weatherLabel(this.now.code)
    const src = this.now.source === 'live' ? '' : this.now.source === 'manual' ? ' ·' : ''
    return `${l.icon} ${l.ja} ${Math.round(this.now.temp)}°C${src}`
  }

  /** Rain factor for crowds (0..1). */
  get rainFactor(): number {
    return Math.min(1, this.now.rain / 4 + this.now.snow / 2)
  }
}
