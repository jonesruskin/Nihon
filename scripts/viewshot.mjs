import { chromium } from 'playwright'
const [query, out] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5173/dev/viewer.html?' + query)
await page.waitForFunction(() => window.ready, null, { timeout: 120000 })
await page.screenshot({ path: out })
await browser.close()
