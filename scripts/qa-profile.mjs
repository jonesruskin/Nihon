// Main-thread CPU profile of steady play: which of our functions eat frame
// time (GL calls excluded — on the software GPU used in CI they are not
// representative). Usage: node scripts/qa-profile.mjs [query] [seconds]
import { chromium } from 'playwright'

const query = process.argv[2] ?? 't=2026-10-16T13:00:00%2B09:00&weather=clear&quality=high'
const seconds = Number(process.argv[3] ?? 20)
const base = process.env.GAME_URL ?? 'http://localhost:5173/'
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  proxy,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 480, height: 270 } })
await page.goto(base + '?' + query, { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 400_000) {
  await page.waitForTimeout(2000)
  const s = await page.evaluate(() => window.nihon?.stats?.()).catch(() => null)
  if (s?.settled) break
}
// Walk forward so streaming, colliders and the crowd all do real work.
await page.keyboard.down('KeyW')
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
await cdp.send('Profiler.start')
await page.waitForTimeout(seconds * 1000)
const { profile } = await cdp.send('Profiler.stop')
await page.keyboard.up('KeyW')
const frames = await page.evaluate(() => window.nihon.renderedFrames ?? 0).catch(() => 0)

const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const dts = profile.timeDeltas
let total = 0
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i])
  const dt = (dts[i] ?? 0) / 1000
  total += dt
  const cf = n.callFrame
  const name = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`
  self.set(name, (self.get(name) ?? 0) + dt)
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
console.log(`profiled ${(total / 1000).toFixed(1)} s, ${frames} frames`)
for (const [k, v] of rows) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${(v / 1000).toFixed(2).padStart(6)} s  ${k}`)
await browser.close()
