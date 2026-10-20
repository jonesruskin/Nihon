// Holds the frame rate at the display's refresh (up to 90 FPS) by trading
// render resolution first and the quality tier only when resolution alone
// can't. Frame times come from rAF deltas, so on a 60 Hz screen the target is
// 60, on 90 Hz+ it is 90 (11.1 ms).
import type { QualityTier } from './Renderer'

export const TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra']
const KEY = 'nihon.tier'
const MIN_SCALE = 0.55

export class FrameGovernor {
  /** Multiplier on the tier's pixel ratio. */
  scale = 1
  private dts: number[] = []
  private window: number[] = []
  private windowTime = 0
  private slowAtMin = 0
  private goodAtMax = 0
  private raises = 0
  /** Estimated display refresh interval (s). */
  refresh = 1 / 60

  constructor(readonly ceiling: QualityTier) {}

  get target(): number {
    return Math.max(this.refresh, 1 / 90)
  }

  /**
   * Feed one frame. Returns a new scale and/or a tier step when one is due.
   * `tier` is the tier currently applied.
   */
  sample(dt: number, tier: QualityTier): { scale?: number; tier?: QualityTier } | null {
    if (!(dt > 0) || dt > 0.5) return null // tab switches, loading hitches
    this.dts.push(dt)
    if (this.dts.length > 240) this.dts.shift()
    // The display interval is the fastest the loop ever runs: a low percentile.
    if (this.dts.length >= 60 && this.dts.length % 30 === 0) {
      const s = [...this.dts].sort((a, b) => a - b)
      this.refresh = Math.min(1 / 30, Math.max(1 / 240, s[Math.floor(s.length * 0.1)]))
    }
    this.window.push(dt)
    this.windowTime += dt
    if (this.windowTime < 0.5) return null
    const w = this.window.sort((a, b) => a - b)
    // Mostly the median, with the slow tail weighed in so hitches count.
    const typical = w[Math.floor(w.length * 0.5)] * 0.6 + w[Math.floor(w.length * 0.9)] * 0.4
    const span = this.windowTime
    this.window = []
    this.windowTime = 0
    const t = this.target
    let scale = this.scale
    if (typical > t * 1.12) scale = Math.max(MIN_SCALE, scale * (typical > t * 1.5 ? 0.82 : 0.92))
    else if (typical < t * 1.04) scale = Math.min(1, scale * 1.04)
    scale = Math.round(scale * 40) / 40
    const out: { scale?: number; tier?: QualityTier } = {}
    if (scale !== this.scale) out.scale = this.scale = scale

    const i = TIERS.indexOf(tier)
    this.slowAtMin = this.scale <= MIN_SCALE && typical > t * 1.12 ? this.slowAtMin + span : 0
    this.goodAtMax = this.scale >= 1 && typical < t * 1.04 ? this.goodAtMax + span : 0
    if (this.slowAtMin > 3 && i > 0) {
      out.tier = TIERS[i - 1]
      this.slowAtMin = 0
      out.scale = this.scale = 0.85
    } else if (this.goodAtMax > 25 && i < TIERS.indexOf(this.ceiling) && this.raises < 2) {
      out.tier = TIERS[i + 1]
      this.raises++
      this.goodAtMax = 0
    }
    if (out.tier) remember(out.tier)
    return out.scale !== undefined || out.tier ? out : null
  }
}

function remember(t: QualityTier): void {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* private mode */
  }
}

/**
 * The tier to start with on this device: what the governor settled on last
 * time, else a guess from the GPU and form factor.
 */
export function deviceTier(gl: WebGL2RenderingContext | WebGLRenderingContext): { tier: QualityTier; ceiling: QualityTier; gpu: string } {
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
  const ua = navigator.userAgent
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))
  let ceiling: QualityTier
  if (/SwiftShader|llvmpipe|softpipe|Software/i.test(gpu)) ceiling = 'low'
  else if (mobile) ceiling = /Adreno \(TM\) [3-5]\d\d|Mali-[GT][1-6]\d\b|PowerVR/i.test(gpu) ? 'low' : 'medium'
  else if (/Intel|Radeon\(TM\) Graphics|Radeon Graphics|Vega \d|Mali|Adreno/i.test(gpu)) ceiling = 'medium'
  else ceiling = 'high'
  let tier: QualityTier = ceiling
  try {
    const saved = localStorage.getItem(KEY) as QualityTier | null
    if (saved && TIERS.includes(saved) && TIERS.indexOf(saved) <= TIERS.indexOf(ceiling)) tier = saved
  } catch {
    /* private mode */
  }
  return { tier, ceiling, gpu }
}
