// Game clock. Defaults to the real current moment, so the sun, the season
// and the crowds match Japan right now. Time can be scaled or set.

export const JST_OFFSET_MS = 9 * 3600 * 1000

export interface JstParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  weekday: number // 0 = Sunday
  dayOfYear: number // 1-366
  hourFloat: number
}

export function jstParts(date: Date): JstParts {
  const j = new Date(date.getTime() + JST_OFFSET_MS)
  const start = Date.UTC(j.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((j.getTime() - start) / 86_400_000) + 1
  const hour = j.getUTCHours()
  const minute = j.getUTCMinutes()
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    hour,
    minute,
    weekday: j.getUTCDay(),
    dayOfYear,
    hourFloat: hour + minute / 60 + j.getUTCSeconds() / 3600,
  }
}

/** Build a Date from JST wall-clock components. */
export function fromJst(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS)
}

export class GameClock {
  private simMs: number
  /** Simulated seconds per real second. 1 = real time. */
  scale = 1
  paused = false

  constructor(start: Date = new Date()) {
    this.simMs = start.getTime()
  }

  tick(realDt: number): number {
    if (this.paused) return 0
    const d = realDt * this.scale
    this.simMs += d * 1000
    return d
  }

  get date(): Date {
    return new Date(this.simMs)
  }

  set(date: Date): void {
    this.simMs = date.getTime()
  }

  advance(seconds: number): void {
    this.simMs += seconds * 1000
  }

  get jst(): JstParts {
    return jstParts(this.date)
  }

  format(): string {
    const p = this.jst
    const pad = (n: number) => String(n).padStart(2, '0')
    const wd = ['日', '月', '火', '水', '木', '金', '土'][p.weekday]
    return `${p.year}年${p.month}月${p.day}日(${wd}) ${pad(p.hour)}:${pad(p.minute)}`
  }
}
