// End-to-end scenarios in headless Chromium (SwiftShader). Each scenario boots
// the game, runs actions, asserts on state and saves a screenshot to
// screenshots/e2e-*.png. Usage: npm run dev & node scripts/e2e.mjs [name...]
import { chromium } from 'playwright'

const base = process.env.GAME_URL ?? 'http://localhost:5173/'
const only = process.argv.slice(2)

const scenarios = [
  {
    name: 'shibuya-boot',
    query: 't=2026-10-16T13:00:00%2B09:00&quality=low',
    run: async (page) => {
      const s = await stats(page)
      assert(s.mode === 'onfoot', `expected onfoot, got ${s.mode}`)
      assert(s.vectorTiles > 0, 'no vector tiles')
      assert(s.peds > 0, 'no pedestrians in Shibuya at 13:00')
    },
  },
  {
    name: 'ride-yamanote',
    query: 't=2026-10-16T13:00:00%2B09:00&quality=low',
    run: async (page) => {
      const r = await page.evaluate(() => window.nihon.debugRide('渋谷', '原宿', 'cab'))
      assert(r.includes('山手線'), `unexpected route ${r}`)
      await page.evaluate(() => {
        const run = window.nihon.rail.run
        run.state = 'run'
        run.at = 1
        run.s = 700
        run.v = 15
      })
      await page.waitForTimeout(8000)
      const s = await stats(page)
      assert(s.mode === 'train', `expected train, got ${s.mode}`)
    },
  },
  {
    name: 'sapporo-snow',
    query: 'lat=43.0605&lon=141.35&heading=90&t=2026-01-20T11:00:00%2B09:00&quality=low&weather=snow',
    run: async (page) => {
      await page.waitForTimeout(6000)
      const w = await page.evaluate(() => window.nihon.weather.now)
      assert(w.snow > 0, 'no snowfall')
    },
  },
  {
    name: 'kyoto-night',
    query: 'lat=34.9671&lon=135.7727&heading=90&t=2026-11-25T19:30:00%2B09:00&quality=low',
    run: async () => {},
  },
]

async function stats(page) {
  return page.evaluate(() => window.nihon.stats())
}

function assert(c, msg) {
  if (!c) throw new Error(msg)
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? undefined,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
let failed = 0
for (const sc of scenarios) {
  if (only.length && !only.includes(sc.name)) continue
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const t0 = Date.now()
  try {
    await page.goto(`${base}?${sc.query}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => {
        try {
          const s = window.nihon.stats()
          return s.mode !== 'loading' && s.vectorTiles > 0
        } catch {
          return false
        }
      },
      null,
      { timeout: 240_000, polling: 2000 },
    )
    await page.waitForTimeout(4000)
    await sc.run(page)
    assert(!errors.length, `page errors: ${errors.slice(0, 3).join(' | ')}`)
    await page.screenshot({ path: `screenshots/e2e-${sc.name}.png` })
    console.log(`✓ ${sc.name} (${Math.round((Date.now() - t0) / 1000)} s)`)
  } catch (e) {
    failed++
    await page.screenshot({ path: `screenshots/e2e-${sc.name}-FAIL.png` }).catch(() => {})
    console.log(`✗ ${sc.name}: ${e.message}`)
  }
  await page.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
