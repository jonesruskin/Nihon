// The quality loop: a fixed set of scenes rendered from the production build,
// each measured against the gates (night readability N, traffic T, people,
// frame budget F, no black/NaN frames), written to screenshots/qa/report.html
// as a contact sheet for visual review.
//
//   npx vite build && npx vite preview --port 4173 &
//   node scripts/qa.mjs [scene-name ...]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import sharp from 'sharp'

const base = process.env.GAME_URL ?? 'http://localhost:4173/'
const out = 'screenshots/qa'
mkdirSync(out, { recursive: true })
const only = process.argv.slice(2)

const T = (d, h) => `t=2026-${d}T${h}%2B09:00`
const SCENES = [
  { name: 'shibuya-day', q: `${T('10-16', '13:00:00')}&weather=clear&heading=200`, gates: { cars: 20, peds: 100 } },
  { name: 'shibuya-night', q: `${T('10-16', '21:30:00')}&weather=clear&heading=200`, gates: { night: true, cars: 12 } },
  { name: 'shibuya-dusk', q: `${T('10-16', '17:25:00')}&weather=clear&heading=260`, gates: { notBlack: true } },
  { name: 'shibuya-rain', q: `${T('10-16', '15:00:00')}&weather=rain&heading=120`, gates: { notBlack: true } },
  { name: 'shinjuku-day', q: `lat=35.6938&lon=139.7036&${T('10-16', '12:00:00')}&weather=clear&heading=0`, gates: { cars: 10 } },
  { name: 'residential-day', q: `lat=35.7262&lon=139.7672&${T('10-16', '10:00:00')}&weather=clear&heading=90`, gates: {} },
  { name: 'residential-night', q: `lat=35.7262&lon=139.7672&${T('10-16', '21:30:00')}&weather=clear&heading=90`, gates: { night: true } },
  { name: 'gion-night', q: `lat=35.0037&lon=135.7752&${T('10-16', '20:30:00')}&weather=clear&heading=90`, gates: { night: true } },
  { name: 'dotonbori-night', q: `lat=34.6687&lon=135.5013&${T('10-16', '21:00:00')}&weather=clear&heading=90`, gates: { night: true } },
  { name: 'sapporo-snow', q: `lat=43.0553&lon=141.3533&${T('01-20', '14:00:00')}&weather=snow&heading=0`, gates: { notBlack: true } },
  { name: 'shirakawago-day', q: `lat=36.2576&lon=136.9062&${T('10-16', '11:00:00')}&weather=clear&heading=40`, gates: { notBlack: true } },
  { name: 'phone-shibuya', q: `${T('10-16', '13:00:00')}&weather=clear&heading=200&quality=medium`, w: 390, h: 844, gates: { cars: 10 } },
].filter((s) => !only.length || only.includes(s.name))

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined

async function luminance(path, w, h) {
  const img = sharp(path)
  const street = await img
    .clone()
    .extract({ left: 0, top: Math.round(h * 0.42), width: w, height: Math.round(h * 0.46) })
    .resize(240, 90, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const whole = await img
    .clone()
    .extract({ left: 0, top: Math.round(h * 0.06), width: w, height: Math.round(h * 0.82) })
    .resize(240, 160, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const lum = (buf) => {
    const v = []
    for (let i = 0; i < buf.length; i += 3) v.push((0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / 255)
    return v.sort((a, b) => a - b)
  }
  const s = lum(street)
  const a = lum(whole)
  return { median: s[s.length >> 1], black: a.filter((x) => x < 0.02).length / a.length, white: a.filter((x) => x > 0.93).length / a.length, mean: a.reduce((x, y) => x + y, 0) / a.length }
}

const results = existsSync(`${out}/results.json`) ? JSON.parse(readFileSync(`${out}/results.json`, 'utf8')) : {}
for (const sc of SCENES) {
  const w = sc.w ?? Number(process.env.QA_W ?? 1280)
  const h = sc.h ?? Number(process.env.QA_H ?? 720)
  const q = sc.q.includes('quality=') ? sc.q : `${sc.q}&quality=high`
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM,
    proxy,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()))
  const t0 = Date.now()
  await page.goto(`${base}?${q}`, { waitUntil: 'domcontentloaded' })
  let stats = null
  let playable = null
  while (Date.now() - t0 < 900_000) {
    await page.waitForTimeout(3000)
    stats = await page.evaluate(() => window.nihon?.stats?.()).catch(() => null)
    if (stats?.mode && stats.mode !== 'loading' && playable === null) playable = (Date.now() - t0) / 1000
    if (playable !== null && stats?.settled) break
  }
  // Let the crowd and traffic fill in. Wait on game time: on a software GPU
  // it runs ~50-100x slower than the clock.
  const g0 = stats?.gameTime ?? 0
  for (let i = 0; i < 160; i++) {
    await page.waitForTimeout(3000)
    stats = await page.evaluate(() => window.nihon.stats()).catch(() => stats)
    if (stats && stats.gameTime - g0 > 12 && stats.cars >= stats.carTarget * 0.9 && stats.peds >= stats.pedTarget * 0.6) break
  }
  const budget = await page.evaluate(() => window.nihon.budget()).catch(() => null)
  const file = `${out}/${sc.name}.png`
  await page.screenshot({ path: file, timeout: 120000 })
  await browser.close()
  const lum = await luminance(file, w, h)
  const g = sc.gates
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })
  check('loads', playable !== null, playable !== null ? `${playable.toFixed(0)} s (software GPU)` : 'never playable')
  check('no errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean')
  check('not black/NaN', lum.mean > 0.03, `mean ${lum.mean.toFixed(3)}`)
  if (g.night) check('N: night readable', lum.median >= 0.06 && lum.black < 0.25, `street median ${lum.median.toFixed(3)}, near-black ${(lum.black * 100).toFixed(0)}%`)
  // ...and still night: not washed out to grey or blown to white.
  if (g.night) check('N: still night', lum.median <= 0.42 && lum.white < 0.12, `street median ${lum.median.toFixed(3)}, near-white ${(lum.white * 100).toFixed(0)}%`)
  check('not blown out', lum.white < 0.25, `near-white ${(lum.white * 100).toFixed(0)}%`)
  if (g.cars) check('T: traffic', (stats?.carsNear ?? 0) >= g.cars, `${stats?.carsNear} cars within 150 m (${stats?.cars} simulated)`)
  if (g.peds) check('people', (stats?.peds ?? 0) >= g.peds, `${stats?.peds} pedestrians`)
  // Draw-call budget per tier (CPU cost of a frame); real lights stay <= 4.
  const maxCalls = { low: 300, medium: 450, high: 650, ultra: 850 }[budget?.quality] ?? 650
  if (budget) check('F: budget', budget.calls <= maxCalls && budget.lights <= 4, `${budget.calls}/${maxCalls} draws (${budget.quality}), ${(budget.triangles / 1e6).toFixed(2)}M tris, ${budget.lights} lights, ${budget.lamps} shader lamps`)
  results[sc.name] = { file: `${sc.name}.png`, w, h, checks, stats, budget, lum, at: new Date().toISOString() }
  console.log(`${checks.every((c) => c.ok) ? 'PASS' : 'FAIL'} ${sc.name}: ${checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} (${c.detail})`).join('; ')}`)
  writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1))
}

// Contact sheet.
const rows = Object.entries(results)
  .map(([name, r]) => {
    const ok = r.checks.every((c) => c.ok)
    return `<figure class="${ok ? 'ok' : 'bad'}"><img src="${r.file}" loading="lazy"><figcaption><b>${name}</b> ${ok ? 'PASS' : 'FAIL'}<ul>${r.checks
      .map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}</li>`)
      .join('')}</ul></figcaption></figure>`
  })
  .join('\n')
writeFileSync(
  `${out}/report.html`,
  `<!doctype html><meta charset="utf-8"><title>NIHON QA</title><style>
body{font:13px system-ui;background:#111;color:#ddd;margin:16px}figure{display:inline-block;width:48%;margin:0 1% 16px 0;vertical-align:top}
img{width:100%;border:3px solid #333}figure.ok img{border-color:#2d6a3e}figure.bad img{border-color:#8a2b2b}ul{margin:4px 0;padding-left:16px}
li.ok{color:#8fd19e}li.bad{color:#f08a8a}</style><h1>NIHON quality report</h1>${rows}`,
)
console.log(`report: ${out}/report.html`)
