// Usage: node scripts/probe.mjs "<query>" waitSeconds "<js expression>"
import { chromium } from 'playwright'
const [query = '', wait = '60', expr = 'window.nihon.stats()'] = process.argv.slice(2)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text().slice(0, 1500)) })
await page.goto((process.env.GAME_URL ?? 'http://localhost:5173/') + '?' + query)
await page.waitForTimeout(Number(wait) * 1000)
console.log(JSON.stringify(await page.evaluate(expr), null, 1))
await browser.close()
