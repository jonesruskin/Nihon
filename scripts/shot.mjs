// Usage: node scripts/shot.mjs "<query>" out.png [waitSeconds] [width] [height]
// Renders the game in headless Chromium (SwiftShader) and saves a screenshot.
import { chromium } from 'playwright'

const [query = '', out = 'screenshots/shot.png', wait = '40', w = '1280', h = '720', actions = ''] = process.argv.slice(2)
const base = process.env.GAME_URL ?? 'http://localhost:5173/'
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? undefined,
  proxy,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-web-security=false'],
})
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { if (!m.text().startsWith('Failed to load resource')) logs.push(`[${m.type()}] ${m.text()}`) } })
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(base + (query ? '?' + query : ''), { waitUntil: 'domcontentloaded' })
const deadline = Date.now() + Number(wait) * 1000
let stats = null
while (Date.now() < deadline) {
  await page.waitForTimeout(2000)
  stats = await page.evaluate(() => (window.nihon && window.nihon.stats ? window.nihon.stats() : null)).catch(() => null)
  if (stats && stats.settled) break
}
if (actions) {
  for (const a of actions.split(' ;; ')) {
    const i = a.indexOf('='); const k = a.slice(0, i); const v = a.slice(i + 1)
    if (k === 'eval') console.log('eval:', JSON.stringify(await page.evaluate(v).catch((e) => String(e))))
    else if (k === 'wait') await page.waitForTimeout(Number(v))
    else if (k === 'key') await page.keyboard.press(v)
    else if (k === 'shot') await page.screenshot({ path: v, timeout: 120000 })
    else if (k === 'hold') { const [key, ms] = v.split(':'); await page.keyboard.down(key); await page.waitForTimeout(Number(ms)); await page.keyboard.up(key) }
  }
}
console.log(JSON.stringify(stats))
await page.screenshot({ path: out, timeout: 120000 })
console.log(JSON.stringify(stats))
console.log(logs.slice(0, 30).join('\n'))
await browser.close()
