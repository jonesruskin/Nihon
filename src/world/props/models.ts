// Procedurally modelled street props and trees, built once and instanced.
// Dimensions follow the real objects (JIS / utility company standards).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Material,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { buildingUniforms } from '../../render/materials/building'

export interface PropModel {
  geometry: BufferGeometry
  materials: Material[]
  castShadow: boolean
}

export function colored(g: BufferGeometry, color: number | Color, group = 0): BufferGeometry {
  const c = new Color(color)
  g = g.index ? g.toNonIndexed() : g
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3)
  g.setAttribute('color', new BufferAttribute(col, 3))
  g.userData.group = group
  return g
}

export function at(g: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): BufferGeometry {
  const m = new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(rx, ry, rz)), new Vector3(1, 1, 1))
  return g.applyMatrix4(m)
}

/** Merge parts, creating one draw group per material slot. */
export function assemble(parts: BufferGeometry[]): BufferGeometry {
  const clean = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p
    g.userData.group = p.userData.group ?? 0
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k)
    if (!g.getAttribute('uv')) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
    if (!g.getAttribute('color')) colored(g, 0xffffff, (g.userData.group as number) ?? 0)
    return g
  })
  const bySlot = new Map<number, BufferGeometry[]>()
  for (const g of clean) {
    const slot = (g.userData.group as number) ?? 0
    if (!bySlot.has(slot)) bySlot.set(slot, [])
    bySlot.get(slot)!.push(g)
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b)
  const merged = mergeGeometries(slots.map((s) => mergeGeometries(bySlot.get(s)!)!), true)!
  // mergeGeometries(…, true) assigns group materialIndex = order; remap to slot ids
  merged.groups.forEach((gr, i) => (gr.materialIndex = slots[i]))
  merged.computeBoundingSphere()
  return merged
}

const vc = (params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}) =>
  new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, ...params })

// ----------------------------------------------------------- canvas textures

export function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  draw(cv.getContext('2d')!)
  const t = new CanvasTexture(cv)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

function leafTexture(kind: 'broad' | 'needle' | 'bamboo'): CanvasTexture {
  return canvasTex(256, 256, (c) => {
    c.clearRect(0, 0, 256, 256)
    let s = 1
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const count = kind === 'needle' ? 900 : kind === 'bamboo' ? 260 : 420
    for (let i = 0; i < count; i++) {
      const x = r() * 256
      const y = r() * 256
      // keep a ragged circular silhouette
      const d = Math.hypot(x - 128, y - 128) / 128
      if (d > 0.95 - r() * 0.25) continue
      const g = 0.75 + r() * 0.5
      c.fillStyle = `rgb(${Math.round(70 * g)},${Math.round(110 * g)},${Math.round(50 * g)})`
      c.save()
      c.translate(x, y)
      c.rotate(r() * Math.PI * 2)
      c.beginPath()
      if (kind === 'needle') c.ellipse(0, 0, 9, 1.4, 0, 0, Math.PI * 2)
      else if (kind === 'bamboo') c.ellipse(0, 0, 16, 2.6, 0, 0, Math.PI * 2)
      else c.ellipse(0, 0, 7, 4, 0, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
  })
}

// ---------------------------------------------------------------- trees

export const TREE_TYPES = ['broadleaf', 'cedar', 'sakura', 'ginkgo', 'pine', 'bamboo'] as const

export const seasonUniforms = {
  uBloom: { value: 0 }, // sakura blossom 0..1
  uAutumn: { value: 0 }, // koyo progress 0..1
  uBare: { value: 0 }, // deciduous leaf loss 0..1
}

function crownCards(radius: number, height: number, cards: number, cy: number, seed: number): BufferGeometry[] {
  const out: BufferGeometry[] = []
  let s = seed
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < cards; i++) {
    const size = radius * (0.9 + r() * 0.7)
    const p = new PlaneGeometry(size * 1.6, size * 1.6)
    const dir = new Vector3(r() - 0.5, (r() - 0.5) * 0.8, r() - 0.5).normalize()
    const pos = dir.clone().multiply(new Vector3(radius * 0.55, height * 0.4, radius * 0.55))
    p.lookAt(dir)
    p.translate(pos.x, cy + pos.y, pos.z)
    // Normals point away from the crown centre: soft, volumetric shading.
    const n = p.getAttribute('normal') as BufferAttribute
    const pa = p.getAttribute('position') as BufferAttribute
    for (let k = 0; k < n.count; k++) {
      const v = new Vector3(pa.getX(k), pa.getY(k) - cy, pa.getZ(k)).normalize()
      n.setXYZ(k, v.x, v.y, v.z)
    }
    p.userData.group = 1
    out.push(p)
  }
  return out
}

function trunk(h: number, r0: number, r1: number, color = 0x4a3b2c): BufferGeometry {
  return colored(at(new CylinderGeometry(r1, r0, h, 7, 1, true), 0, h / 2, 0), color)
}

function leafMaterial(kind: 'broad' | 'needle' | 'bamboo', tint: number, seasonal: 'none' | 'sakura' | 'ginkgo' | 'maple'): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    map: leafTexture(kind),
    color: tint,
    alphaTest: 0.45,
    side: DoubleSide,
    roughness: 0.75,
    metalness: 0,
  })
  m.name = `leaf-${seasonal}`
  m.customProgramCacheKey = () => `leaf-${seasonal}-v3`
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, seasonUniforms, { uSnowLeaf: buildingUniforms.uSnow })
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBloom; uniform float uAutumn; uniform float uBare; uniform float uSnowLeaf;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        // Alpha-tested foliage thins out in the smaller mips until distant
        // trees are bare sticks; boost coverage with the mip level instead.
        {
          vec2 tdx = dFdx(vMapUv * 256.0), tdy = dFdy(vMapUv * 256.0);
          float mip = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));
          diffuseColor.a *= 1.0 + mip * 0.3;
        }
        ${
          seasonal === 'sakura'
            ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.78, 0.82) * (0.8 + 0.4 * diffuseColor.g), uBloom);'
            : seasonal === 'ginkgo'
              ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.78, 0.15) * (0.6 + 0.6 * diffuseColor.g), uAutumn);'
              : seasonal === 'maple'
                ? 'diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.75, 0.18, 0.08), vec3(0.85, 0.5, 0.1), diffuseColor.g * 2.0), uAutumn * 0.85);'
                : ''
        }
        ${
          seasonal !== 'none'
            ? `// Winter: the crown thins to a stable mesh of grey-brown twigs
        // (hashed in texture space so it doesn't shimmer as you move).
        if (uBare > 0.0) {
          vec2 cell = floor(vMapUv * 96.0);
          float hsh = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
          if (hsh < uBare * 0.72) discard;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.13, 0.11) * (0.7 + 0.6 * hsh), uBare);
        }`
            : ''
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9), uSnowLeaf * 0.5 * step(0.0, vNormal.y));`,
      )
  }
  return m
}

export function createTreeModels(): PropModel[] {
  const barkMat = vc({ roughness: 0.95 })
  const models: PropModel[] = []
  // broadleaf (keyaki/kusunoki): wide, rounded
  models.push({
    geometry: assemble([trunk(4.5, 0.28, 0.16), ...crownCards(3.6, 5, 14, 6.2, 11)]),
    materials: [barkMat, leafMaterial('broad', 0xffffff, 'maple')],
    castShadow: true,
  })
  // cedar (sugi): tall straight conifer, narrow cone
  {
    const parts: BufferGeometry[] = [trunk(18, 0.32, 0.08, 0x5a3e2a)]
    for (let i = 0; i < 6; i++) {
      const y = 7 + i * 2.1
      const rr = 2.4 * (1 - i / 7)
      parts.push(...crownCards(rr, 2.2, 4, y, 101 + i * 7))
    }
    models.push({ geometry: assemble(parts), materials: [barkMat, leafMaterial('needle', 0x9db08a, 'none')], castShadow: true })
  }
  // sakura (somei-yoshino): spreading, low crown
  models.push({
    geometry: assemble([trunk(3, 0.3, 0.18, 0x3b2e2a), ...crownCards(4.2, 3.2, 16, 4.6, 33)]),
    materials: [barkMat, leafMaterial('broad', 0xd8e6c8, 'sakura')],
    castShadow: true,
  })
  // ginkgo (icho): columnar street tree
  models.push({
    geometry: assemble([trunk(7, 0.22, 0.1), ...crownCards(2.2, 7, 12, 6.5, 57)]),
    materials: [barkMat, leafMaterial('broad', 0xc8dca0, 'ginkgo')],
    castShadow: true,
  })
  // black pine (kuromatsu): irregular flat pads
  {
    const parts: BufferGeometry[] = [trunk(6, 0.25, 0.12, 0x3d332b)]
    for (let i = 0; i < 4; i++) parts.push(...crownCards(1.8, 0.9, 4, 3.5 + i * 1.3, 77 + i * 13).map((g) => g.translate(Math.sin(i * 2.3) * 1.2, 0, Math.cos(i * 2.3) * 1.2)))
    models.push({ geometry: assemble(parts), materials: [barkMat, leafMaterial('needle', 0x7f9a6e, 'none')], castShadow: true })
  }
  // bamboo grove clump
  {
    const parts: BufferGeometry[] = []
    for (let i = 0; i < 9; i++) {
      const a = i * 2.39996
      const rr = 0.4 + (i % 3) * 0.5
      parts.push(at(trunk(11 + (i % 4), 0.05, 0.035, 0x7c8a4a), Math.cos(a) * rr, 0, Math.sin(a) * rr, 0.04 * Math.sin(a), 0, 0.04 * Math.cos(a)))
    }
    parts.push(...crownCards(2.4, 5, 10, 9, 909))
    models.push({ geometry: assemble(parts), materials: [vc({ roughness: 0.6 }), leafMaterial('bamboo', 0xc6d6a0, 'none')], castShadow: true })
  }
  return models
}

// ------------------------------------------------------------ street props

export function createPoleModel(): PropModel {
  // 12 m concrete pole (コンクリート柱), crossarms, insulators, pole transformer.
  const parts: BufferGeometry[] = [
    colored(at(new CylinderGeometry(0.15, 0.2, 12, 10), 0, 6, 0), 0x9a9890),
    colored(at(new BoxGeometry(1.5, 0.1, 0.1), 0, 10.6, 0), 0x6f6f6a),
    colored(at(new BoxGeometry(0.9, 0.08, 0.08), 0, 9.9, 0), 0x6f6f6a),
    colored(at(new CylinderGeometry(0.28, 0.28, 0.9, 10), 0.42, 8.6, 0), 0x8d9396), // transformer
    colored(at(new BoxGeometry(0.05, 1.8, 0.05), 0.2, 8.2, 0), 0x333333),
    colored(at(new BoxGeometry(0.4, 0.12, 0.3), 0, 2.5, 0.18), 0xd8c64a), // yellow guard sleeve
    colored(at(new BoxGeometry(0.32, 0.5, 0.02), 0, 2.2, 0.19), 0xe8e8e8), // address plate
  ]
  for (const x of [-0.65, 0.65, 0]) parts.push(colored(at(new CylinderGeometry(0.05, 0.05, 0.18, 6), x, x === 0 ? 10.05 : 10.75, 0), 0xdedad0))
  return { geometry: assemble(parts), materials: [vc({ roughness: 0.85 })], castShadow: true }
}

/** Catenary mast (電柱/架線柱): galvanised steel pole, cantilever toward +z, insulators. */
export function createMastModel(): PropModel {
  const steel = 0x8f9396
  const parts: BufferGeometry[] = [
    colored(at(new BoxGeometry(0.26, 7, 0.22), 0, 3.5, 0), steel),
    colored(at(new BoxGeometry(0.08, 0.08, 3.1), 0, 6.45, 1.45), steel), // upper tie
    colored(at(new BoxGeometry(0.07, 0.07, 3.0), 0, 5.6, 1.4, -0.3, 0, 0), steel), // diagonal brace
    colored(at(new CylinderGeometry(0.06, 0.06, 0.35, 6), 0, 6.2, 2.7), 0x6b4a3a), // insulator
    colored(at(new BoxGeometry(0.05, 0.9, 0.05), 0, 5.75, 2.7), steel), // dropper to contact wire
    colored(at(new BoxGeometry(0.4, 0.3, 0.3), 0, 0.15, 0), 0x777a7c), // footing
  ]
  return { geometry: assemble(parts), materials: [vc({ roughness: 0.55, metalness: 0.5 })], castShadow: true }
}

export function createStreetLightModel(): PropModel {
  const parts: BufferGeometry[] = [
    colored(at(new CylinderGeometry(0.07, 0.11, 8, 8), 0, 4, 0), 0x8a8d90),
    colored(at(new CylinderGeometry(0.05, 0.05, 2.2, 6), 0, 8.0, 1.0, Math.PI / 2 - 0.15, 0, 0), 0x8a8d90),
    colored(at(new BoxGeometry(0.35, 0.12, 0.7), 0, 8.15, 2.05), 0x6a6d70),
  ]
  const lamp = colored(at(new BoxGeometry(0.3, 0.03, 0.6), 0, 8.08, 2.05), 0xffffff, 1)
  parts.push(lamp)
  const lampMat = new MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xffe2b0, emissiveIntensity: 0, roughness: 0.4 })
  lampMat.name = 'lamp'
  lampMat.onBeforeCompile = (s) => {
    s.uniforms.uNight = buildingUniforms.uNight
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vec3(1.0, 0.93, 0.84) * 6.0 * uNight;')
  }
  return { geometry: assemble(parts), materials: [vc({ roughness: 0.5, metalness: 0.6 }), lampMat], castShadow: true }
}

function vendingFront(): CanvasTexture {
  return canvasTex(128, 256, (c) => {
    c.fillStyle = '#f4f4f2'
    c.fillRect(0, 0, 128, 256)
    // display window with 3 rows of drinks
    c.fillStyle = '#dfe7ea'
    c.fillRect(8, 14, 112, 120)
    const cols = ['#c8242b', '#1f5fa8', '#f2c230', '#2f8f4e', '#f7f7f7', '#7a4a2a', '#e86b1c', '#3a3a3a']
    let s = 7
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let row = 0; row < 3; row++)
      for (let i = 0; i < 7; i++) {
        c.fillStyle = cols[Math.floor(r() * cols.length)]
        const x = 12 + i * 15
        const y = 22 + row * 38
        c.fillRect(x, y + 6, 10, 24)
        c.fillRect(x + 3, y, 4, 7)
        c.fillStyle = row === 2 ? '#d33' : '#36c'
        c.fillRect(x, y + 32, 10, 3) // price/hot-cold lamps
      }
    c.fillStyle = '#2a2a2a'
    c.fillRect(20, 150, 88, 26)
    c.fillStyle = '#555'
    c.fillRect(24, 196, 80, 30) // takeout slot
    c.fillStyle = '#9fd36a'
    c.fillRect(96, 152, 8, 8)
  })
}

export function createVendingModel(): PropModel {
  const body = colored(at(new BoxGeometry(1.0, 1.83, 0.75), 0, 0.915, 0), 0xffffff)
  const front = at(new PlaneGeometry(0.94, 1.76), 0, 0.915, 0.376)
  front.userData.group = 1
  const frontMat = new MeshStandardMaterial({ map: vendingFront(), emissiveMap: null, roughness: 0.3, metalness: 0 })
  frontMat.name = 'vending-front'
  frontMat.onBeforeCompile = (s) => {
    s.uniforms.uNight = buildingUniforms.uNight
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (0.12 + 0.4 * uNight);')
  }
  return { geometry: assemble([body, front]), materials: [vc({ roughness: 0.4, metalness: 0.1 }), frontMat], castShadow: true }
}

export function createPillarModel(): PropModel {
  // Unit height (scaled per instance to clearance), 2.2 m square RC pier with capital.
  const g = new BoxGeometry(2.2, 1, 2.2)
  g.translate(0, 0.5, 0)
  return { geometry: assemble([colored(g, 0x8f8e8a)]), materials: [vc({ roughness: 0.95 })], castShadow: true }
}

export function createSignalModel(): PropModel {
  // Japanese horizontal 3-aspect signal: blue(green)-yellow-red, on an arm.
  const parts: BufferGeometry[] = [
    colored(at(new CylinderGeometry(0.1, 0.13, 6, 8), 0, 3, 0), 0x8e9194),
    colored(at(new CylinderGeometry(0.06, 0.06, 4, 6), 2, 5.4, 0, 0, 0, Math.PI / 2), 0x8e9194),
    colored(at(new BoxGeometry(1.3, 0.42, 0.25), 3.6, 5.2, 0), 0x707478),
    colored(at(new BoxGeometry(0.4, 0.9, 0.25), 0, 2.6, 0.2), 0x707478), // pedestrian head
  ]
  const lights = [
    colored(at(new CylinderGeometry(0.14, 0.14, 0.05, 12), 3.18, 5.2, 0.14, Math.PI / 2, 0, 0), 0x2ec4a0, 1),
    colored(at(new CylinderGeometry(0.14, 0.14, 0.05, 12), 3.6, 5.2, 0.14, Math.PI / 2, 0, 0), 0x3a3010, 1),
    colored(at(new CylinderGeometry(0.14, 0.14, 0.05, 12), 4.02, 5.2, 0.14, Math.PI / 2, 0, 0), 0x3a1010, 1),
  ]
  parts.push(...lights)
  const lightMat = vc({ roughness: 0.3, emissive: 0xffffff, emissiveIntensity: 0.0 })
  lightMat.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * 6.0;')
  }
  return { geometry: assemble(parts), materials: [vc({ roughness: 0.6, metalness: 0.4 }), lightMat], castShadow: true }
}

export function createSphereLamp(): BufferGeometry {
  return new SphereGeometry(0.2, 8, 6)
}

export function makeConeTree(): BufferGeometry {
  return new ConeGeometry(1, 2, 6)
}
