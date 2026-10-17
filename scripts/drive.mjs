// Interactive-ish probe: node scripts/drive.mjs "<query>" waitSec "<steps json>"
// steps: [["down","KeyW"],["wait",2000],["eval","expr"],["up","KeyW"],["shot","file.png"]]
import { chromium } from 'playwright'
const [query = '', wait = '60', stepsJson = '[]'] = process.argv.slice(2)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load')) console.log('[console]', m.text().slice(0, 400)) })
await page.goto((process.env.GAME_URL ?? 'http://localhost:5173/') + '?' + query)
const t0 = Date.now()
while (Date.now() - t0 < Number(wait) * 1000) {
  await page.waitForTimeout(3000)
  const mode = await page.evaluate(() => window.nihon && window.nihon.mode).catch(() => null)
  if (mode && mode !== 'loading') break
}
await page.waitForTimeout(3000)
for (const [op, arg] of JSON.parse(stepsJson)) {
  if (op === 'down') await page.keyboard.down(arg)
  else if (op === 'up') await page.keyboard.up(arg)
  else if (op === 'press') await page.keyboard.press(arg)
  else if (op === 'wait') await page.waitForTimeout(arg)
  else if (op === 'eval') console.log('eval:', JSON.stringify(await page.evaluate(arg).catch((e) => String(e))))
  else if (op === 'shot') await page.screenshot({ path: arg })
  else if (op === 'mouse') await page.mouse.move(arg[0], arg[1])
}
await browser.close()
