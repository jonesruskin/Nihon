// Builds the shipped models in public/models/ from the masters in
// assets-src/models/: textures resized and transcoded to KTX2 (ETC1S for
// colour and packed ORM maps, UASTC+zstd for normal maps, which ETC1S
// visibly blocks up), geometry re-encoded with Draco. Typically 5–8× smaller
// downloads and ~6× less video memory than the PNG masters.
//
// Needs KTX-Software's `toktx` on PATH (https://github.com/KhronosGroup/KTX-Software/releases).
// Usage: node scripts/optimize-assets.mjs [name-filter]
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const filter = process.argv[2] ?? ''
const SRC = 'assets-src/models'
const OUT = 'public/models'

// Only models the game actually loads ship. Size = max texture edge in px.
const JOBS = [
  // Landmarks and props, instanced in the world.
  ...['torii'].map((n) => ['objs', n, 1024]),
  ...['lantern_stone', 'postbox_red', 'bicycle', 'bicycle_yellow', 'vending_red', 'vending_soft'].map((n) => ['objs', n, 512]),
  // Vehicles: the player drives these, so they are seen up close.
  ...['sedan_86', 'sedan_2010', 'kei_car_generic', 'kei_delivery', 'kei_truck_minicab', 'kei_truck_vintage', 'pickup_jp', 'box_truck', 'light_truck_07', 'light_truck_90', 'bus_erga_mio', 'bus_town'].map((n) => ['objs', n, 1024]),
  // People: the player's own model fills the screen in third person.
  ...['player_m', 'player_f', 'player_m_w', 'player_f_w'].map((n) => ['people', n, 1024]),
  ...['casual_m', 'elder_f', 'elder_f_w', 'elder_m', 'office_f', 'salaryman_a', 'salaryman_b', 'salaryman_c', 'student_f', 'student_f_w', 'tourist_f', 'tourist_m', 'tourist_m_w', 'young_f', 'young_f_w', 'young_m', 'young_m2_w', 'young_m_w'].map((n) => ['people', n, 512]),
].filter(([d, n]) => `${d}/${n}`.includes(filter))

const gt = (args) => run('npx', ['gltf-transform', ...args], { maxBuffer: 1 << 26 })

async function optimize([dir, name, size]) {
  const src = join(SRC, dir, `${name}.glb`)
  const dst = join(OUT, dir, `${name}.glb`)
  if (!existsSync(src)) throw new Error(`missing master ${src}`)
  const tmp = mkdtempSync(join(tmpdir(), 'nihon-opt-'))
  try {
    const a = join(tmp, 'a.glb')
    const b = join(tmp, 'b.glb')
    await gt(['resize', src, a, '--width', String(size), '--height', String(size)])
    await gt(['etc1s', a, b, '--slots', '{baseColorTexture,emissiveTexture,occlusionTexture,metallicRoughnessTexture,specularColorTexture}', '--quality', '192'])
    await gt(['uastc', b, a, '--slots', '{normalTexture,clearcoatNormalTexture}', '--level', '2', '--rdo', '1.5', '--zstd', '18'])
    // Texture commands decode Draco; put it back (same quantisation as the Blender export).
    await gt(['draco', a, b, '--method', 'edgebreaker', '--quantize-position', '14', '--quantize-normal', '10', '--quantize-texcoord', '12'])
    mkdirSync(join(OUT, dir), { recursive: true })
    copyFileSync(b, dst)
    const kb = (f) => Math.round(statSync(f).size / 1024)
    console.log(`${dir}/${name}: ${kb(src)} KB → ${kb(dst)} KB`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// toktx is multithreaded already; two files at a time keeps every core busy.
const queue = [...JOBS]
await Promise.all(
  [0, 1].map(async () => {
    while (queue.length) await optimize(queue.shift())
  }),
)
