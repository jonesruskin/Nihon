// Builds public/data/plateau.json: one entry per PLATEAU city with the best
// building tileset (LOD2 textured preferred), its bounding box and the local
// geoid height (PLATEAU heights are ellipsoidal; GSI terrain is orthometric).
// Run: NODE_USE_ENV_PROXY=1 node scripts/bake-plateau.mjs
import { writeFileSync } from 'node:fs'

const CATALOG = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets'
const GEOID = (lat, lon) =>
  `https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?outputType=json&latitude=${lat}&longitude=${lon}`

// Light LOD1 boxes stream fast city-wide; LOD2 (roof shapes, ~10x heavier)
// is kept as an "ultra" option.
const rank = (d) => {
  const lod = Number(d.lod)
  const tex = d.texture ? 1 : 0
  // LOD2 textured > LOD1 textured > LOD2 plain > LOD3/4 (huge) > LOD1 plain
  const score = { '2,1': 50, '1,1': 40, '2,0': 30, '3,1': 25, '4,1': 24, '3,0': 20, '4,0': 19, '1,0': 10 }[`${lod},${tex}`] ?? 0
  return score * 10000 + Number(d.year)
}

const catalog = await (await fetch(CATALOG)).json()
const byCity = new Map()
const lod2 = new Map()
const lod1Rank = (d) => (Number(d.lod) === 1 ? 100 : 0) + (d.texture ? 10 : 0) + Number(d.year) / 10000
for (const d of catalog.datasets) {
  if (d.type_en !== 'bldg' || d.format !== '3D Tiles') continue
  const key = d.ward_code ?? d.city_code
  const cur = byCity.get(key)
  if (!cur || lod1Rank(d) > lod1Rank(cur)) byCity.set(key, d)
  if (Number(d.lod) === 2) {
    const c2 = lod2.get(key)
    if (!c2 || rank(d) > rank(c2)) lod2.set(key, d)
  }
}
console.log('cities', byCity.size)

const out = []
const list = [...byCity.values()]
let i = 0
async function worker() {
  while (i < list.length) {
    const d = list[i++]
    try {
      const ts = await (await fetch(d.url)).json()
      const r = ts.root.boundingVolume.region
      if (!r) throw new Error('no region')
      const deg = (x) => (x * 180) / Math.PI
      const bbox = [deg(r[0]), deg(r[1]), deg(r[2]), deg(r[3])].map((v) => Math.round(v * 1e5) / 1e5)
      const clat = (bbox[1] + bbox[3]) / 2
      const clon = (bbox[0] + bbox[2]) / 2
      let n = 37
      try {
        const g = await (await fetch(GEOID(clat.toFixed(5), clon.toFixed(5)))).json()
        n = Number(g.OutputData.geoidHeight)
      } catch {}
      out.push({
        code: d.ward_code ?? d.city_code,
        name: d.ward ? `${d.city}${d.ward}` : d.city,
        pref: d.pref,
        url: d.url,
        url2: lod2.get(d.ward_code ?? d.city_code)?.url ?? null,
        lod: Number(d.lod),
        tex: !!d.texture,
        year: Number(d.year),
        bbox,
        geoid: Math.round(n * 100) / 100,
      })
    } catch (e) {
      console.warn('skip', d.id, String(e))
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker))
out.sort((a, b) => a.code.localeCompare(b.code))
writeFileSync(new URL('../public/data/plateau.json', import.meta.url), JSON.stringify(out))
console.log('wrote', out.length)
