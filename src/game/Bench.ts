// ?bench: a repeatable performance run for real hardware. Visits a dense
// city, a historic district and a mountain valley, turns a full circle at
// each, and reports frame-time percentiles with draw calls and triangles,
// so quality tiers can be tuned from numbers rather than guesses.

export interface BenchStop {
  name: string
  lat: number
  lon: number
}

export const BENCH_STOPS: BenchStop[] = [
  { name: 'Shibuya (dense city)', lat: 35.6595, lon: 139.7005 },
  { name: 'Gion, Kyoto (historic)', lat: 35.0037, lon: 135.7785 },
  { name: 'Iya valley (forest, mountains)', lat: 33.8759, lon: 133.8351 },
]

export interface BenchResult {
  stop: string
  frames: number
  p50: number
  p95: number
  p99: number
  fps: number
  calls: number
  triangles: number
}

export class Bench {
  private times: number[] = []
  private calls: number[] = []
  private tris: number[] = []
  recording = false
  results: BenchResult[] = []

  sample(realDt: number, calls: number, triangles: number): void {
    if (!this.recording) return
    this.times.push(realDt * 1000)
    this.calls.push(calls)
    this.tris.push(triangles)
  }

  begin(): void {
    this.times = []
    this.calls = []
    this.tris = []
    this.recording = true
  }

  end(stop: string): BenchResult {
    this.recording = false
    const t = [...this.times].sort((a, b) => a - b)
    const q = (p: number) => (t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))] : 0)
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
    const r: BenchResult = {
      stop,
      frames: t.length,
      p50: round(q(0.5)),
      p95: round(q(0.95)),
      p99: round(q(0.99)),
      fps: round(t.length ? 1000 / mean(this.times) : 0),
      calls: Math.round(mean(this.calls)),
      triangles: Math.round(mean(this.tris)),
    }
    this.results.push(r)
    return r
  }

  /** The report as HTML for the on-screen panel. */
  html(quality: string, gpu: string): string {
    const rows = this.results
      .map((r) => `<tr><td>${r.stop}</td><td>${r.fps}</td><td>${r.p50}</td><td>${r.p95}</td><td>${r.p99}</td><td>${r.calls}</td><td>${(r.triangles / 1e6).toFixed(2)} M</td></tr>`)
      .join('')
    return `<h3>Benchmark · ${quality}</h3><p>${gpu}</p>
      <table><tr><th>Place</th><th>fps</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>draws</th><th>triangles</th></tr>${rows}</table>
      <p>Copy with <code>JSON.stringify(nihonBench)</code> in the console.</p>`
  }
}

function round(x: number): number {
  return Math.round(x * 10) / 10
}
