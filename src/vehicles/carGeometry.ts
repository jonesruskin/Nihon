// Parametric vehicle bodies: a body lofted from superellipse cross-sections
// along a side silhouette, with raised wheel arches, a glasshouse above the
// beltline, lights, plates and wheels. Dimensions follow real Japanese
// vehicle classes (kei cars are capped at 3.40 x 1.48 x 2.00 m by law).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
  type Material,
} from 'three'
import { buildingUniforms } from '../render/materials/building'
import { Box3, Vector3, type Object3D } from 'three'

export interface CarSpec {
  id: string
  label: string
  labelJa: string
  length: number
  width: number
  height: number
  wheelbase: number
  wheelR: number
  clearance: number
  /** Silhouette keypoints along the length (0 = rear, 1 = front): [t, roof/top height] */
  profile: Array<[number, number]>
  /** Beltline height (window bottom) */
  belt: number
  /** Glass range along length [t0, t1] */
  glass: [number, number]
  boxiness: number // superellipse exponent: 2 round .. 8 boxy
  tumblehome: number // top width factor
  kei?: boolean
  taxi?: boolean
  bus?: boolean
  truckBed?: [number, number] // t range of an open bed (kei truck) or box
  boxBody?: [number, number, number] // t0, t1, height of a cargo box
  colors: number[]
  mass: number
  power: number // kW
  maxSpeed: number // m/s
  seats: number
  driverEye: [number, number, number] // x (right +), y, z (forward -)
  /** Optimised third-party model ids (one picked per vehicle). */
  models?: string[]
  /** Measured from the model: wheel hub positions FL, FR, RL, RR. */
  wheelPos?: Array<[number, number, number]>
}

export const CAR_SPECS: CarSpec[] = [
  // Real models (Objaverse, CC BY 4.0 — see CREDITS)
  {
    id: 'kei_car',
    label: 'Kei car',
    labelJa: '軽自動車',
    length: 3.395, width: 1.475, height: 1.6, wheelbase: 2.43, wheelR: 0.28, clearance: 0.15,
    profile: [[0, 1.6], [1, 1.6]], belt: 0.95, glass: [0, 1], boxiness: 4, tumblehome: 0.9, kei: true,
    colors: [], mass: 900, power: 47, maxSpeed: 38, seats: 4, driverEye: [0.3, 1.22, -0.1],
    models: ['kei_car_generic'],
  },
  {
    id: 'kei_truck_m',
    label: 'Kei truck',
    labelJa: '軽トラック',
    length: 3.395, width: 1.475, height: 1.78, wheelbase: 1.9, wheelR: 0.27, clearance: 0.18,
    profile: [[0, 1.78], [1, 1.78]], belt: 1.05, glass: [0, 1], boxiness: 6, tumblehome: 0.92, kei: true,
    colors: [], mass: 780, power: 37, maxSpeed: 33, seats: 2, driverEye: [0.3, 1.35, -1.05],
    models: ['kei_truck_minicab', 'kei_truck_minicab', 'kei_truck_vintage'],
  },
  {
    id: 'kei_van',
    label: 'Kei van',
    labelJa: '軽バン',
    length: 3.395, width: 1.475, height: 1.9, wheelbase: 2.4, wheelR: 0.27, clearance: 0.15,
    profile: [[0, 1.9], [1, 1.9]], belt: 1.0, glass: [0, 1], boxiness: 5, tumblehome: 0.9, kei: true,
    colors: [], mass: 900, power: 47, maxSpeed: 36, seats: 4, driverEye: [0.3, 1.3, -0.3],
    models: ['kei_delivery'],
  },
  {
    id: 'sedan_m',
    label: 'Sedan',
    labelJa: 'セダン',
    length: 4.85, width: 1.8, height: 1.45, wheelbase: 2.8, wheelR: 0.32, clearance: 0.14,
    profile: [[0, 1.45], [1, 1.45]], belt: 0.98, glass: [0, 1], boxiness: 3, tumblehome: 0.8,
    colors: [0x111214, 0xf2f2f0, 0x9ea4aa, 0x2b2e33, 0x5b1f24, 0x1d2b46], mass: 1550, power: 135, maxSpeed: 58, seats: 5, driverEye: [0.38, 1.1, 0.05],
    models: ['sedan_2010', 'sedan_2010', 'sedan_86'],
  },
  {
    id: 'taxi_m',
    label: 'Taxi',
    labelJa: 'タクシー',
    length: 4.69, width: 1.7, height: 1.43, wheelbase: 2.68, wheelR: 0.31, clearance: 0.14,
    profile: [[0, 1.43], [1, 1.43]], belt: 0.98, glass: [0, 1], boxiness: 3, tumblehome: 0.8, taxi: true,
    // Tokyo taxi liveries: black, green/yellow two-tone fleets, cream
    colors: [0x0e0f12, 0x1f6b3a, 0xe7c94a, 0xe9e2cf, 0x8a1f1f], mass: 1450, power: 80, maxSpeed: 45, seats: 5, driverEye: [0.38, 1.1, 0.05],
    models: ['sedan_86'],
  },
  {
    id: 'light_truck_m',
    label: '2t truck',
    labelJa: '2トントラック',
    length: 4.69, width: 1.7, height: 2.1, wheelbase: 2.5, wheelR: 0.36, clearance: 0.22,
    profile: [[0, 2.1], [1, 2.1]], belt: 1.35, glass: [0, 1], boxiness: 6, tumblehome: 0.94,
    colors: [0xf2f2f0, 0xe9ebec, 0x2e5c9a, 0x15803d, 0xc9ccd0], mass: 3500, power: 110, maxSpeed: 33, seats: 3, driverEye: [0.42, 1.95, -1.6],
    models: ['light_truck_07', 'light_truck_90', 'box_truck'],
  },
  {
    id: 'pickup_m',
    label: 'Pickup',
    labelJa: 'ピックアップ',
    length: 4.7, width: 1.7, height: 1.6, wheelbase: 2.85, wheelR: 0.34, clearance: 0.2,
    profile: [[0, 1.6], [1, 1.6]], belt: 1.1, glass: [0, 1], boxiness: 5, tumblehome: 0.9,
    colors: [0x1d3d6b, 0xf2f2f0, 0x7a7d80, 0x6b2020], mass: 1700, power: 110, maxSpeed: 47, seats: 5, driverEye: [0.38, 1.35, 0],
    models: ['pickup_jp'],
  },
  {
    id: 'bus_m',
    label: 'City bus',
    labelJa: '路線バス',
    length: 10.5, width: 2.49, height: 3.1, wheelbase: 5.3, wheelR: 0.5, clearance: 0.3,
    profile: [[0, 3.1], [1, 3.1]], belt: 1.2, glass: [0, 1], boxiness: 8, tumblehome: 0.98, bus: true,
    colors: [], mass: 11000, power: 180, maxSpeed: 25, seats: 70, driverEye: [0.8, 2.0, -4.6],
    models: ['bus_erga_mio', 'bus_town'],
  },

  {
    id: 'kei_wagon',
    label: 'Kei tall wagon',
    labelJa: '軽トールワゴン',
    length: 3.395,
    width: 1.475,
    height: 1.79,
    wheelbase: 2.52,
    wheelR: 0.29,
    clearance: 0.15,
    profile: [
      [0, 0.75],
      [0.02, 1.62],
      [0.06, 1.78],
      [0.72, 1.79],
      [0.84, 1.52],
      [0.93, 1.0],
      [1, 0.72],
    ],
    belt: 0.98,
    glass: [0.04, 0.86],
    boxiness: 5,
    tumblehome: 0.9,
    kei: true,
    colors: [0xf2f2ef, 0x1d1f22, 0xd7c9a8, 0x3e5a7a, 0x8a2f3a, 0xbfc5c9, 0x6f8a68],
    mass: 950,
    power: 47,
    maxSpeed: 38,
    seats: 4,
    driverEye: [0.32, 1.28, -0.15],
  },
  {
    id: 'compact',
    label: 'Compact hatchback',
    labelJa: 'コンパクトカー',
    length: 3.99,
    width: 1.695,
    height: 1.52,
    wheelbase: 2.53,
    wheelR: 0.31,
    clearance: 0.15,
    profile: [
      [0, 0.82],
      [0.03, 1.2],
      [0.1, 1.46],
      [0.55, 1.52],
      [0.72, 1.18],
      [0.8, 0.98],
      [0.95, 0.88],
      [1, 0.62],
    ],
    belt: 0.95,
    glass: [0.06, 0.74],
    boxiness: 3.4,
    tumblehome: 0.82,
    colors: [0xf4f4f2, 0x24272c, 0xa8adb2, 0x2a4d8f, 0xb3202a, 0x6c6f73],
    mass: 1100,
    power: 72,
    maxSpeed: 47,
    seats: 5,
    driverEye: [0.36, 1.17, -0.2],
  },
  {
    id: 'sedan',
    label: 'Sedan',
    labelJa: 'セダン',
    length: 4.91,
    width: 1.8,
    height: 1.45,
    wheelbase: 2.92,
    wheelR: 0.33,
    clearance: 0.14,
    profile: [
      [0, 0.85],
      [0.03, 0.98],
      [0.2, 1.02],
      [0.31, 1.4],
      [0.6, 1.45],
      [0.7, 1.12],
      [0.74, 0.98],
      [0.96, 0.86],
      [1, 0.66],
    ],
    belt: 0.98,
    glass: [0.23, 0.72],
    boxiness: 3.2,
    tumblehome: 0.8,
    colors: [0x111214, 0xf2f2f0, 0x9ea4aa, 0x2b2e33, 0x5b1f24],
    mass: 1700,
    power: 180,
    maxSpeed: 60,
    seats: 5,
    driverEye: [0.38, 1.12, 0.1],
  },
  {
    id: 'taxi',
    label: 'Taxi (JPN-style)',
    labelJa: 'タクシー',
    length: 4.4,
    width: 1.695,
    height: 1.75,
    wheelbase: 2.75,
    wheelR: 0.3,
    clearance: 0.15,
    profile: [
      [0, 0.86],
      [0.03, 1.5],
      [0.08, 1.72],
      [0.66, 1.75],
      [0.78, 1.35],
      [0.86, 1.02],
      [0.97, 0.9],
      [1, 0.68],
    ],
    belt: 1.0,
    glass: [0.05, 0.8],
    boxiness: 4.2,
    tumblehome: 0.86,
    taxi: true,
    colors: [0x1a2238], // 濃藍 (deep indigo)
    mass: 1400,
    power: 74,
    maxSpeed: 45,
    seats: 5,
    driverEye: [0.36, 1.3, -0.05],
  },
  {
    id: 'minivan',
    label: 'Minivan',
    labelJa: 'ミニバン',
    length: 4.69,
    width: 1.695,
    height: 1.87,
    wheelbase: 2.86,
    wheelR: 0.32,
    clearance: 0.16,
    profile: [
      [0, 0.85],
      [0.02, 1.68],
      [0.06, 1.86],
      [0.72, 1.87],
      [0.82, 1.42],
      [0.9, 1.08],
      [1, 0.75],
    ],
    belt: 1.04,
    glass: [0.04, 0.84],
    boxiness: 5.2,
    tumblehome: 0.88,
    colors: [0xf3f3f1, 0x15171a, 0xb9bec3, 0x40362f],
    mass: 1650,
    power: 110,
    maxSpeed: 50,
    seats: 7,
    driverEye: [0.36, 1.45, -0.1],
  },
  {
    id: 'kei_truck',
    label: 'Kei truck',
    labelJa: '軽トラック',
    length: 3.395,
    width: 1.475,
    height: 1.78,
    wheelbase: 1.905,
    wheelR: 0.28,
    clearance: 0.18,
    profile: [
      [0, 0.82],
      [0.6, 0.82],
      [0.61, 1.78],
      [0.95, 1.78],
      [0.98, 1.45],
      [1, 0.9],
    ],
    belt: 1.05,
    glass: [0.62, 0.99],
    boxiness: 6,
    tumblehome: 0.92,
    kei: true,
    truckBed: [0, 0.6],
    colors: [0xf4f4f2, 0xe8e8e4, 0x7d8a8f],
    mass: 800,
    power: 37,
    maxSpeed: 33,
    seats: 2,
    driverEye: [0.3, 1.36, -1.05],
  },
  {
    id: 'light_truck',
    label: '2t box truck',
    labelJa: '2トントラック',
    length: 4.69,
    width: 1.695,
    height: 2.9,
    wheelbase: 2.5,
    wheelR: 0.35,
    clearance: 0.22,
    profile: [
      [0, 0.95],
      [0.62, 0.95],
      [0.63, 2.15],
      [0.95, 2.15],
      [0.98, 1.7],
      [1, 1.0],
    ],
    belt: 1.35,
    glass: [0.64, 0.99],
    boxiness: 6,
    tumblehome: 0.94,
    boxBody: [0, 0.6, 2.9],
    colors: [0xf2f2f0, 0x2e5c9a, 0x15803d],
    mass: 3500,
    power: 110,
    maxSpeed: 33,
    seats: 3,
    driverEye: [0.42, 1.95, -1.6],
  },
  {
    id: 'bus',
    label: 'City bus',
    labelJa: '路線バス',
    length: 10.5,
    width: 2.49,
    height: 3.1,
    wheelbase: 5.3,
    wheelR: 0.5,
    clearance: 0.3,
    profile: [
      [0, 2.9],
      [0.02, 3.08],
      [0.97, 3.1],
      [0.99, 2.9],
      [1, 2.3],
    ],
    belt: 1.2,
    glass: [0.03, 0.995],
    boxiness: 8,
    tumblehome: 0.98,
    bus: true,
    colors: [0xf2f2ee],
    mass: 11000,
    power: 180,
    maxSpeed: 25,
    seats: 70,
    driverEye: [0.8, 2.0, -4.6],
  },
]

// ---------------------------------------------------------------- materials

const plateCache = new Map<string, CanvasTexture>()
function plateTexture(kei: boolean, text: string): CanvasTexture {
  const key = `${kei}-${text}`
  const hit = plateCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const g = c.getContext('2d')!
  // Private regular cars: white plate, green text; kei: yellow plate, black text.
  g.fillStyle = kei ? '#f4d23c' : '#f7f7f2'
  g.fillRect(0, 0, 256, 128)
  g.strokeStyle = '#555'
  g.lineWidth = 6
  g.strokeRect(3, 3, 250, 122)
  g.fillStyle = kei ? '#111' : '#1d5e34'
  g.font = '500 28px "Noto Sans JP", sans-serif'
  g.textAlign = 'center'
  g.fillText(text.split(' ')[0], 128, 40)
  g.font = '700 58px "Noto Sans JP", sans-serif'
  g.fillText(text.split(' ')[1] ?? '12-34', 140, 106)
  g.font = '500 30px "Noto Sans JP", sans-serif'
  g.fillText('わ', 40, 104)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  plateCache.set(key, t)
  return t
}

export function carPaint(color: number): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color,
    metalness: 0.45,
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.1,
    name: 'paint',
  })
}

const shared: Record<string, Material> = {}
function mat(name: string, make: () => Material): Material {
  return (shared[name] ??= make())
}

function emissiveNight(base: number, emissive: number, dayGlow: number, nightGlow: number, name: string): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: base, roughness: 0.25, metalness: 0.1, emissive, name })
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = buildingUniforms.uNight
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix(${dayGlow.toFixed(2)}, ${nightGlow.toFixed(2)}, uNight);`)
  }
  return m
}

export const carMaterials = {
  glass: () =>
    mat('glass', () => new MeshPhysicalMaterial({ color: 0x0b0f12, metalness: 0.1, roughness: 0.04, clearcoat: 1, transparent: true, opacity: 0.82, name: 'glass' })),
  trim: () => mat('trim', () => new MeshStandardMaterial({ color: 0x141516, roughness: 0.6, metalness: 0.1, name: 'trim' })),
  chrome: () => mat('chrome', () => new MeshStandardMaterial({ color: 0xcfd3d6, roughness: 0.12, metalness: 1, name: 'chrome' })),
  tyre: () => mat('tyre', () => new MeshStandardMaterial({ color: 0x18181a, roughness: 0.92, metalness: 0, name: 'tyre' })),
  rim: () => mat('rim', () => new MeshStandardMaterial({ color: 0xb4b8bc, roughness: 0.3, metalness: 0.9, name: 'rim' })),
  head: () => mat('head', () => emissiveNight(0xe9eef2, 0xfff3dc, 0.15, 7, 'headlight')),
  tail: () => mat('tail', () => emissiveNight(0x6a0d10, 0xff2a1a, 0.2, 2.5, 'taillight')),
  brake: () => mat('brake', () => new MeshStandardMaterial({ color: 0x6a0d10, emissive: 0xff1a10, emissiveIntensity: 0, name: 'brake' })),
  bed: () => mat('bed', () => new MeshStandardMaterial({ color: 0x8b8f92, roughness: 0.6, metalness: 0.5, name: 'bed' })),
  andon: () => mat('andon', () => emissiveNight(0xf6efe0, 0xffd28a, 0.3, 4, 'andon')),
}

// ------------------------------------------------------------------ geometry

function interp(profile: Array<[number, number]>, t: number): number {
  for (let i = 1; i < profile.length; i++) {
    if (t <= profile[i][0]) {
      const [t0, h0] = profile[i - 1]
      const [t1, h1] = profile[i]
      const f = (t - t0) / Math.max(1e-6, t1 - t0)
      // smoothstep for softer transitions between keypoints
      const s = f * f * (3 - 2 * f)
      return h0 + (h1 - h0) * s
    }
  }
  return profile[profile.length - 1][1]
}

/**
 * Lofted body. Returns geometry with two groups: 0 = paint, 1 = glass.
 * Vehicle frame: x right, y up, z forward is -z (front at z = -L/2).
 */
export function bodyGeometry(spec: CarSpec): BufferGeometry {
  const ST = spec.bus ? 40 : 56 // stations along length
  const RING = 36 // points around section
  const L = spec.length
  const W = spec.width / 2
  const pos: number[] = []
  const nrm: number[] = []
  const isGlass: boolean[] = []
  const axleF = L / 2 - (L - spec.wheelbase) / 2 // distance from centre to front axle (z negative)
  const axleR = -axleF
  const archR = spec.wheelR + 0.06
  for (let i = 0; i <= ST; i++) {
    const t = i / ST // 0 rear .. 1 front
    const z = L / 2 - t * L // rear at +L/2
    const top = interp(spec.profile, t)
    // plan-view taper at the ends (rounded corners)
    const endT = Math.min(t, 1 - t) * L
    const taper = Math.min(1, 0.82 + Math.sqrt(Math.max(0, endT)) * 0.42)
    const w = W * taper
    // wheel arches: raise the bottom edge around each axle
    let bottom = spec.clearance
    for (const az of [-axleF, -axleR]) {
      const dz = z - az
      if (Math.abs(dz) < archR) bottom = Math.max(bottom, spec.wheelR + Math.sqrt(archR * archR - dz * dz) - 0.02)
    }
    const h = Math.max(0.05, top - bottom)
    const n = spec.boxiness
    for (let k = 0; k <= RING; k++) {
      // angle from bottom centre around the right side to the top and back
      const a = (k / RING) * Math.PI * 2 - Math.PI / 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      const sx = Math.sign(c) * Math.pow(Math.abs(c), 2 / n)
      const sy = Math.sign(s) * Math.pow(Math.abs(s), 2 / n)
      const yNorm = (sy + 1) / 2 // 0 bottom .. 1 top
      const y = bottom + yNorm * h
      // tumblehome: the glasshouse narrows above the beltline
      const above = Math.max(0, (y - spec.belt) / Math.max(0.1, top - spec.belt))
      const xw = w * (1 - (1 - spec.tumblehome) * Math.pow(above, 1.3))
      const x = sx * xw
      pos.push(x, y, z)
      nrm.push(0, 0, 0)
      const inGlassLen = t > spec.glass[0] && t < spec.glass[1]
      isGlass.push(inGlassLen && y > spec.belt + 0.04 && y < top - 0.06 && Math.abs(sx) < 0.995)
    }
  }
  const idxPaint: number[] = []
  const idxGlass: number[] = []
  const R1 = RING + 1
  for (let i = 0; i < ST; i++) {
    for (let k = 0; k < RING; k++) {
      const a = i * R1 + k
      const b = a + 1
      const c = a + R1
      const d = c + 1
      const glass = isGlass[a] && isGlass[b] && isGlass[c] && isGlass[d]
      const target = glass ? idxGlass : idxPaint
      target.push(a, b, c, b, d, c)
    }
  }
  // End caps (fan)
  for (const i of [0, ST]) {
    const centre = pos.length / 3
    const base = i * R1
    let cy = 0
    for (let k = 0; k <= RING; k++) cy += pos[(base + k) * 3 + 1]
    pos.push(0, cy / (RING + 1), pos[base * 3 + 2])
    nrm.push(0, 0, 0)
    isGlass.push(false)
    for (let k = 0; k < RING; k++) {
      if (i === 0) idxPaint.push(centre, base + k + 1, base + k)
      else idxPaint.push(centre, base + k, base + k + 1)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setIndex([...idxPaint, ...idxGlass])
  g.addGroup(0, idxPaint.length, 0)
  g.addGroup(idxPaint.length, idxGlass.length, 1)
  g.computeVertexNormals()
  // Normals: winding is mirrored by our frame; flip if they point inwards.
  const p = g.getAttribute('position') as BufferAttribute
  const nn = g.getAttribute('normal') as BufferAttribute
  let dot = 0
  for (let v = 0; v < p.count; v += 7) dot += p.getX(v) * nn.getX(v) + (p.getY(v) - 0.8) * nn.getY(v)
  if (dot < 0) {
    const ix = g.index!.array as Uint32Array | Uint16Array
    for (let q = 0; q < ix.length; q += 3) {
      const tmp = ix[q + 1]
      ix[q + 1] = ix[q + 2]
      ix[q + 2] = tmp
    }
    g.index!.needsUpdate = true
    g.computeVertexNormals()
  }
  return g
}

export interface VehicleModel {
  root: Group
  body: Mesh
  wheels: Group[] // FL, FR, RL, RR (pivot at hub)
  brakeLights: Mesh[]
  spec: CarSpec
  color: number
}

let plateSeq = 100
export function buildVehicle(spec: CarSpec, color?: number): VehicleModel {
  const root = new Group()
  root.name = `vehicle:${spec.id}`
  const col = color ?? spec.colors[Math.floor(Math.random() * spec.colors.length)]
  const paint = carPaint(col)
  const body = new Mesh(bodyGeometry(spec), [paint, carMaterials.glass()])
  body.castShadow = true
  body.receiveShadow = true
  root.add(body)
  const L = spec.length
  const W = spec.width / 2
  const frontZ = -L / 2
  const rearZ = L / 2
  const add = (g: BufferGeometry, m: Material, x: number, y: number, z: number, rx = 0, ry = 0) => {
    const mesh = new Mesh(g, m)
    mesh.position.set(x, y, z)
    mesh.rotation.set(rx, ry, 0)
    mesh.castShadow = true
    root.add(mesh)
    return mesh
  }
  const frontTop = interp(spec.profile, 1)
  const rearTop = interp(spec.profile, 0)
  const lampY = Math.min(frontTop - 0.12, spec.belt - 0.15)
  // Headlights, grille, bumpers
  for (const s of [-1, 1]) {
    add(new BoxGeometry(spec.bus ? 0.3 : 0.32, spec.bus ? 0.16 : 0.12, 0.05), carMaterials.head(), s * (W - (spec.bus ? 0.3 : 0.24)), lampY, frontZ + 0.03)
  }
  add(new BoxGeometry(spec.width * 0.42, 0.14, 0.04), carMaterials.trim(), 0, lampY - 0.18, frontZ + 0.02)
  add(new BoxGeometry(spec.width * 0.96, 0.16, 0.12), carMaterials.trim(), 0, spec.clearance + 0.12, frontZ + 0.06)
  add(new BoxGeometry(spec.width * 0.96, 0.16, 0.12), carMaterials.trim(), 0, spec.clearance + 0.12, rearZ - 0.06)
  // Tail lights + brake lights
  const brakeLights: Mesh[] = []
  const tailY = Math.min(rearTop - 0.15, spec.belt - 0.05)
  for (const s of [-1, 1]) {
    add(new BoxGeometry(0.12, spec.bus ? 0.5 : 0.28, 0.04), carMaterials.tail(), s * (W - 0.1), tailY, rearZ - 0.02)
    brakeLights.push(add(new BoxGeometry(0.1, 0.1, 0.03), carMaterials.brake().clone(), s * (W - 0.1), tailY - 0.2, rearZ - 0.01))
  }
  // Number plates (front + rear)
  const plateMat = new MeshStandardMaterial({ map: plateTexture(!!spec.kei, `品川 500 ${plateSeq}-${(plateSeq * 7) % 100}`.replace('500 ', '500 ')), roughness: 0.4 })
  plateSeq++
  add(new PlaneGeometry(0.33, 0.165), plateMat, 0, spec.clearance + 0.3, frontZ - 0.005, 0, Math.PI)
  add(new PlaneGeometry(0.33, 0.165), plateMat, 0, spec.clearance + 0.35, rearZ + 0.005)
  // Mirrors
  if (!spec.bus) for (const s of [-1, 1]) add(new BoxGeometry(0.06, 0.12, 0.2), new MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.4 }), s * (W + 0.07), spec.belt + 0.08, frontZ + L * 0.3)
  // Kei truck bed / box truck cargo box
  if (spec.truckBed) {
    const z0 = rearZ - spec.truckBed[0] * L
    const z1 = rearZ - spec.truckBed[1] * L
    const len = Math.abs(z0 - z1)
    const zc = (z0 + z1) / 2
    add(new BoxGeometry(spec.width, 0.05, len), carMaterials.bed(), 0, 0.82, zc)
    for (const s of [-1, 1]) add(new BoxGeometry(0.04, 0.3, len), carMaterials.bed(), s * (W - 0.02), 0.97, zc)
    add(new BoxGeometry(spec.width, 0.3, 0.04), carMaterials.bed(), 0, 0.97, z0 - 0.02)
  }
  if (spec.boxBody) {
    const z0 = rearZ - spec.boxBody[0] * L
    const z1 = rearZ - spec.boxBody[1] * L
    const len = Math.abs(z0 - z1)
    const hb = spec.boxBody[2] - 0.95
    add(new BoxGeometry(spec.width + 0.12, hb, len), new MeshStandardMaterial({ color: 0xe9ebec, roughness: 0.5, metalness: 0.3 }), 0, 0.95 + hb / 2, (z0 + z1) / 2)
  }
  // Taxi roof lamp (行灯)
  if (spec.taxi) add(new BoxGeometry(0.42, 0.16, 0.12), carMaterials.andon(), 0, spec.height + 0.08, -0.1)
  // Bus: destination sign + doors
  if (spec.bus) {
    add(new BoxGeometry(1.6, 0.28, 0.04), emissiveNight(0x101010, 0xff9a2a, 0.8, 3, 'destination'), 0, 2.78, frontZ - 0.01)
    add(new BoxGeometry(0.03, 2.0, 1.0), carMaterials.glass(), -W - 0.005, 1.3, frontZ + 1.2)
    add(new BoxGeometry(0.03, 2.0, 1.1), carMaterials.glass(), -W - 0.005, 1.3, 0.2)
    // Coloured band typical of Japanese city buses
    add(new BoxGeometry(spec.width + 0.01, 0.22, L * 0.96), new MeshStandardMaterial({ color: 0x1f6f4a, roughness: 0.4, metalness: 0.2 }), 0, 0.85, 0)
  }
  // Wheels
  const wheels: Group[] = []
  const axleZ = (L - spec.wheelbase) / 2
  const track = W - spec.wheelR * 0.25 - 0.08
  const tyreG = new TorusGeometry(spec.wheelR * 0.74, spec.wheelR * 0.26, 10, 22)
  const rimG = new CylinderGeometry(spec.wheelR * 0.6, spec.wheelR * 0.6, 0.16, 18)
  for (const [x, z] of [
    [-track, frontZ + axleZ],
    [track, frontZ + axleZ],
    [-track, rearZ - axleZ],
    [track, rearZ - axleZ],
  ]) {
    const pivot = new Group()
    pivot.position.set(x, spec.wheelR, z)
    const spin = new Group()
    const tyre = new Mesh(tyreG, carMaterials.tyre())
    tyre.rotation.y = Math.PI / 2
    tyre.scale.z = spec.bus ? 1.6 : 1.25
    const rim = new Mesh(rimG, carMaterials.rim())
    rim.rotation.z = Math.PI / 2
    tyre.castShadow = rim.castShadow = true
    spin.add(tyre, rim)
    pivot.add(spin)
    root.add(pivot)
    wheels.push(pivot)
  }
  return { root, body, wheels, brakeLights, spec, color: col }
}

/**
 * Build a vehicle from an optimised model (body + wheel_FL/FR/RL/RR nodes).
 * Measures the model to refine the spec (dimensions, wheel positions).
 */
export function vehicleFromScene(base: CarSpec, scene: Object3D, color?: number): { model: VehicleModel; spec: CarSpec } {
  const root = new Group()
  root.name = `vehicle:${base.id}`
  root.add(scene)
  const box = new Box3().setFromObject(scene)
  const size = box.getSize(new Vector3())
  const names = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']
  const wheels: Group[] = []
  const wheelPos: Array<[number, number, number]> = []
  let wheelR = base.wheelR
  for (const n of names) {
    const w = scene.getObjectByName(n)
    const pivot = new Group()
    if (w) {
      const wb = new Box3().setFromObject(w)
      const c = wb.getCenter(new Vector3())
      wheelR = Math.max(0.2, wb.getSize(new Vector3()).y / 2)
      pivot.position.copy(c)
      const spin = new Group()
      pivot.add(spin)
      w.removeFromParent()
      w.position.sub(c)
      spin.add(w)
      wheelPos.push([c.x, c.y, c.z])
    } else {
      pivot.add(new Group())
      wheelPos.push([0, base.wheelR, 0])
    }
    root.add(pivot)
    wheels.push(pivot)
  }
  // Recolour the paint (materials named body / bodycolor / *_body).
  let col = color ?? 0
  if (color !== undefined) {
    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      const out = mats.map((mat) => {
        if (/^(body|bodycolor|solar_body)$/i.test(mat.name) && !(mat as MeshStandardMaterial).map) {
          const c = (mat as MeshStandardMaterial).clone()
          c.color.setHex(color)
          return c
        }
        return mat
      })
      m.material = Array.isArray(m.material) ? out : out[0]
    })
  } else col = 0xffffff
  const spec: CarSpec = {
    ...base,
    length: size.z,
    width: Math.min(size.x, base.width + 0.1),
    height: size.y,
    wheelR,
    wheelbase: Math.abs(wheelPos[0][2] - wheelPos[2][2]) || base.wheelbase,
    wheelPos,
  }
  if (spec.taxi) {
    const andon = new Mesh(new BoxGeometry(0.42, 0.16, 0.12), carMaterials.andon())
    andon.position.set(0, size.y + 0.08, wheelPos[0][2] * 0.15)
    root.add(andon)
  }
  return { model: { root, body: scene as Mesh, wheels, brakeLights: [], spec, color: col }, spec }
}

export function specById(id: string): CarSpec {
  return CAR_SPECS.find((s) => s.id === id) ?? CAR_SPECS[0]
}

export function randomColor(spec: CarSpec): number {
  return spec.colors[Math.floor(Math.random() * spec.colors.length)]
}

export const tint = (c: number, k: number) => new Color(c).multiplyScalar(k).getHex()
