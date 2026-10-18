// Debug: hide each top-level scene group in turn and screenshot, to find
// which one draws an artefact. Usage: node scripts/bisect.mjs "<query>" outDir [vector]
import { chromium } from 'playwright'
const [query, outDir] = process.argv.slice(2)
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, proxy, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 480, height: 270 } })
await page.goto('http://localhost:5173/?' + query)
for (let i = 0; i < 150; i++) {
  await page.waitForTimeout(2000)
  const s = await page.evaluate(() => window.nihon?.stats?.()).catch(() => null)
  if (s && s.settled) break
}
await page.waitForTimeout(4000)
await page.screenshot({ path: `${outDir}/all.png`, timeout: 120000 })
if (process.argv[4] === 'vector') {
  // Second level: hide every mesh with a given name inside the vector tiles.
  const names = await page.evaluate(() => { const s = new Set(); window.nihon.vector.root.traverse((o) => { if (o.isMesh || o.isLine || o.isLineSegments) s.add(o.name || o.type) }); return [...s] })
  console.log(names.join('\n'))
  for (const n of names) {
    await page.evaluate((n) => window.nihon.vector.root.traverse((o) => { if ((o.name || o.type) === n) { o.userData.hid = true; o.visible = false } }), n)
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${outDir}/hide-${n.replace(/[^a-z0-9]/gi, '_')}.png`, timeout: 120000 })
    await page.evaluate(() => window.nihon.vector.root.traverse((o) => { if (o.userData.hid) { o.userData.hid = false; o.visible = true } }))
  }
} else {
  const names = await page.evaluate(() => window.nihon.pipeline.scene.children.map((c, i) => `${i}:${c.type}:${c.name}`))
  console.log(names.join('\n'))
  for (let i = 0; i < names.length; i++) {
    if (!/Group|Mesh|Object3D|Points|InstancedMesh/.test(names[i])) continue
    await page.evaluate((i) => { const c = window.nihon.pipeline.scene.children[i]; c.userData.v = c.visible; c.visible = false }, i)
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${outDir}/hide-${i}.png`, timeout: 120000 })
    await page.evaluate((i) => { const c = window.nihon.pipeline.scene.children[i]; c.visible = c.userData.v }, i)
  }
}
await browser.close()
