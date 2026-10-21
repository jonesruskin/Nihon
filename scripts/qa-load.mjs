// Gate L: how much is downloaded, how many requests, and how long until the
// player can move — on an emulated home connection (20 Mbps, 40 ms), against
// the production build (`npx vite build && npx vite preview --port 4173`).
// Usage: node scripts/qa-load.mjs [query] [--json out.json]
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const query = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--json') ?? 't=2026-10-16T13:00:00%2B09:00&weather=clear'
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const base = process.env.GAME_URL ?? 'http://localhost:4173/'
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined
const t0 = Date.now()
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  proxy,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const cdp = await page.context().newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (20e6 / 8) | 0, uploadThroughput: (5e6 / 8) | 0 })
const marks = []
if (process.env.TRACE) page.on('console', (m) => m.type() !== 'log' && console.error('[console]', m.text().slice(0, 200)))
page.on('console', (m) => m.text().startsWith('[load]') && marks.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m.text().slice(7)}`))
const reqs = new Map()
cdp.on('Network.responseReceived', (e) => reqs.set(e.requestId, { url: e.response.url, bytes: 0 }))
cdp.on('Network.loadingFinished', (e) => {
  const r = reqs.get(e.requestId)
  if (r) r.bytes = e.encodedDataLength
})
await page.goto(base + '?' + query, { waitUntil: 'domcontentloaded' })
let playable = null
while (Date.now() - t0 < 600_000) {
  await page.waitForTimeout(1000)
  const mode = await page.evaluate(() => window.nihon?.mode).catch(() => null)
  if (process.env.TRACE && (Date.now() - t0) % 10000 < 1000) console.error(((Date.now() - t0) / 1000) | 0, JSON.stringify(await page.evaluate(() => window.nihon?.stats?.()).catch(() => null)))
  if (mode === 'onfoot') {
    playable = (Date.now() - t0) / 1000
    break
  }
}
const all = [...reqs.values()]
const own = all.filter((r) => r.url.startsWith(base))
const tiles = all.filter((r) => !r.url.startsWith(base))
const sum = (a) => a.reduce((s, r) => s + r.bytes, 0)
const top = [...own].sort((a, b) => b.bytes - a.bytes).slice(0, 12).map((r) => `${(r.bytes / 1e6).toFixed(2)} MB ${r.url.replace(base, '')}`)
const report = {
  secondsToPlay: playable,
  staticMB: +(sum(own) / 1e6).toFixed(2),
  staticRequests: own.length,
  tileMB: +(sum(tiles) / 1e6).toFixed(2),
  tileRequests: tiles.length,
  marks,
  largest: top,
  byHost: Object.fromEntries(
    Object.entries(
      tiles.reduce((m, r) => {
        const h = new URL(r.url).host + ' ' + (r.url.match(/\.(\w+)(\?|$)/)?.[1] ?? '')
        m[h] = m[h] ?? [0, 0]
        m[h][0] += r.bytes
        m[h][1]++
        return m
      }, {}),
    )
      .sort((a, b) => b[1][0] - a[1][0])
      .map(([h, [b, n]]) => [h, `${(b / 1e6).toFixed(1)} MB / ${n}`]),
  ),
}
console.log(JSON.stringify(report, null, 1))
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1))
await browser.close()
