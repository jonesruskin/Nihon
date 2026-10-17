// Procedural Japanese rolling stock, dimensioned after the real cars:
// stainless commuter EMUs with line-colour bands (E233/E235-like), metro
// cars, the long-nosed N700/E5/E7 Shinkansen, low-floor trams and AGT.
// Bodies are swept cross-sections; windows, doors, liveries, headlights and
// destination displays are drawn by one shared shader from object-space
// coordinates, so every line gets its livery without textures.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type IUniform,
} from 'three'
import { assemble, at, colored } from '../world/props/models'
import { buildingUniforms } from '../render/materials/building'
import type { Line, LineKind } from './RailNetwork'

export interface TrainStyle {
  key: string
  kind: LineKind
  carLen: number
  cabLen: number
  width: number
  height: number // roof top above rail
  floor: number // floor above rail
  doors: number // per side per car; 0 = Shinkansen end doors
  gauge: number
  body: Color
  metal: number // 0 painted .. 1 stainless
  stripe: Color
  stripe2: Color
  pattern: number // 0 EMU bands, 1 metro, 2 N700, 3 E5, 4 tram, 5 E7, 6 painted metro (Ginza/Marunouchi)
  nose: number // nose length (m); 0 = flat cab
  cars: number
  pantograph: boolean
}

const C = (hex: string) => new Color(hex)

export function styleForLine(line: Line, cars?: number): TrainStyle {
  const color = C(line.color || '#3a8c4a')
  const base: TrainStyle = {
    key: `${line.kind}:${line.color}`,
    kind: line.kind,
    carLen: 20,
    cabLen: 20,
    width: 2.95,
    height: 3.65,
    floor: 1.15,
    doors: 4,
    gauge: 1.067,
    body: C('#a7abae'),
    metal: 1,
    stripe: color,
    stripe2: color,
    pattern: 0,
    nose: 0,
    cars: cars ?? 10,
    pantograph: true,
  }
  switch (line.kind) {
    case 'shinkansen': {
      const s: TrainStyle = { ...base, carLen: 25, cabLen: 27, width: 3.38, height: 3.6, floor: 1.3, doors: 0, gauge: 1.435, metal: 0, nose: 10.5, cars: cars ?? 16 }
      if (/東北|北海道/.test(line.ja)) return { ...s, key: 'E5', body: C('#f4f4f2'), stripe: C('#00995a'), stripe2: C('#e4007f'), pattern: 3, nose: 14, cabLen: 28, cars: cars ?? 10 }
      if (/北陸|上越/.test(line.ja)) return { ...s, key: 'E7', body: C('#f1efe8'), stripe: C('#0a6eb4'), stripe2: C('#b8763b'), pattern: 5, nose: 9, cars: cars ?? 12 }
      if (/九州/.test(line.ja)) return { ...s, key: 'N700-K', body: C('#f4f4f2'), stripe: C('#1b2a59'), stripe2: C('#b29654'), pattern: 2, cars: cars ?? 8 }
      return { ...s, key: 'N700', body: C('#f5f5f3'), stripe: C('#1d4f9c'), stripe2: C('#1d4f9c'), pattern: 2 }
    }
    case 'metro': {
      if (line.ja === '銀座線') return { ...base, key: 'ginza', carLen: 16, cabLen: 16, width: 2.55, height: 3.47, doors: 3, body: C('#ff9e1b'), metal: 0, stripe: C('#ffffff'), stripe2: C('#d07000'), pattern: 6, cars: cars ?? 6 }
      if (line.ja === '丸ノ内線') return { ...base, key: 'marunouchi', carLen: 18, cabLen: 18, width: 2.78, height: 3.48, doors: 3, body: C('#e60012'), metal: 0, stripe: C('#ffffff'), stripe2: C('#9a9a9a'), pattern: 6, cars: cars ?? 6 }
      return { ...base, key: `metro:${line.color}`, width: 2.8, height: 3.6, body: C('#b8bcbf'), metal: 0.9, pattern: 1, cars: cars ?? 10 }
    }
    case 'tram':
      return { ...base, key: `tram:${line.color}`, carLen: 15, cabLen: 15, width: 2.4, height: 3.65, floor: 0.38, doors: 2, body: C('#efe9da'), metal: 0, pattern: 4, cars: cars ?? 1, pantograph: true }
    case 'agt':
      return { ...base, key: `agt:${line.color}`, carLen: 9, cabLen: 9.5, width: 2.45, height: 3.3, floor: 1.05, doors: 2, body: C('#e9eaea'), metal: 0, pattern: 1, cars: cars ?? 6, pantograph: false, nose: 1.2 }
    case 'monorail':
      return { ...base, key: `mono:${line.color}`, carLen: 15, cabLen: 16, width: 2.98, height: 3.75, floor: 1.2, doors: 2, body: C('#eef0f0'), metal: 0, pattern: 1, cars: cars ?? 6, pantograph: false, nose: 1.5 }
    case 'cable':
      return { ...base, key: 'cable', carLen: 14, cabLen: 14, width: 2.6, height: 3.4, floor: 0.9, doors: 2, body: C('#d8d2c0'), metal: 0, pattern: 4, cars: 1, pantograph: false }
    default:
      return { ...base, key: `emu:${line.kind}:${line.color}`, cars: cars ?? (line.kind === 'jr' ? 10 : 8) }
  }
}

// ------------------------------------------------------------ geometry

function profile(s: TrainStyle): [number, number][] {
  const W = s.width / 2
  const H = s.height
  const y0 = Math.max(0.25, s.floor - 0.2)
  if (s.kind === 'shinkansen')
    return [[0, y0], [W - 0.25, y0], [W - 0.06, y0 + 0.35], [W, 1.9], [W - 0.06, H - 0.85], [W - 0.32, H - 0.32], [W - 0.95, H - 0.05], [0, H]]
  return [[0, y0], [W - 0.12, y0], [W - 0.03, y0 + 0.45], [W, y0 + 1.0], [W, H - 0.72], [W - 0.07, H - 0.42], [W - 0.28, H - 0.16], [W - 0.7, H - 0.04], [0, H]]
}

/** Sweep the cross-section along z. `part` attribute: -1 body, 0..1 nose t, 2 flat cab face. */
function sweptBody(s: TrainStyle, cab: boolean): BufferGeometry {
  const half = profile(s)
  const ring: [number, number][] = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y] as [number, number])]
  const L = cab ? s.cabLen : s.carLen
  const y0 = half[0][1]
  const slices: { z: number; w: number; h: number; t: number }[] = [{ z: -L / 2, w: 1, h: 1, t: -1 }]
  if (cab && s.nose > 0) {
    const z0 = L / 2 - s.nose
    slices.push({ z: z0, w: 1, h: 1, t: -1 })
    const N = 16
    for (let i = 1; i <= N; i++) {
      const t = i / N
      const tt = Math.min(t, 0.985)
      const shinkansen = s.kind === 'shinkansen'
      slices.push({
        z: z0 + s.nose * tt,
        w: shinkansen ? Math.sqrt(Math.max(0.02, 1 - Math.pow(tt, 2.6))) : Math.sqrt(Math.max(0.3, 1 - Math.pow(tt, 4))),
        h: shinkansen ? 1 - 0.9 * Math.pow(tt, 1.45) : 1 - 0.25 * Math.pow(tt, 2),
        t,
      })
    }
  } else {
    slices.push({ z: L / 2, w: 1, h: 1, t: -1 })
  }
  const R = ring.length
  const pos: number[] = []
  const part: number[] = []
  const idx: number[] = []
  for (const sl of slices) {
    for (const [x, y] of ring) {
      pos.push(x * sl.w, y0 + (y - y0) * sl.h, sl.z)
      part.push(sl.t)
    }
  }
  for (let i = 0; i + 1 < slices.length; i++)
    for (let j = 0; j < R; j++) {
      const a = i * R + j
      const b = i * R + ((j + 1) % R)
      const c = (i + 1) * R + j
      const d = (i + 1) * R + ((j + 1) % R)
      idx.push(a, b, c, b, d, c)
    }
  // End caps (fans). Front cap of a flat-faced cab is tagged for the cab shader.
  const cap = (si: number, front: boolean, tag: number) => {
    const sl = slices[si]
    const centre = pos.length / 3
    pos.push(0, y0 + ((s.height - y0) * sl.h) / 2, sl.z)
    part.push(tag)
    const base = pos.length / 3
    for (const [x, y] of ring) {
      pos.push(x * sl.w, y0 + (y - y0) * sl.h, sl.z)
      part.push(tag)
    }
    for (let j = 0; j < R; j++) {
      const a = base + j
      const b = base + ((j + 1) % R)
      if (front) idx.push(centre, a, b)
      else idx.push(centre, b, a)
    }
  }
  cap(0, false, -1)
  cap(slices.length - 1, true, cab ? (s.nose > 0 ? 1 : 2) : -1)
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('part', new BufferAttribute(new Float32Array(part), 1))
  g.setIndex(idx)
  // Flat-shade the caps but keep the sweep smooth: split by non-indexing caps is overkill;
  // computeVertexNormals on the separate cap vertices already keeps them flat.
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

function details(s: TrainStyle, cab: boolean, panto: boolean): BufferGeometry {
  const L = cab ? s.cabLen : s.carLen
  const W = s.width
  const y0 = Math.max(0.25, s.floor - 0.2)
  const parts: BufferGeometry[] = []
  const dark = 0x26282a
  const grey = 0x55585b
  const wheelR = s.kind === 'tram' ? 0.33 : s.kind === 'shinkansen' ? 0.43 : 0.41
  const bogieOff = s.kind === 'shinkansen' ? L / 2 - 3.6 : s.kind === 'tram' ? L / 2 - 3 : L / 2 - 2.6
  const frontZ = cab ? L / 2 - s.nose : L / 2
  const bogies = s.kind === 'agt' || s.kind === 'monorail' ? [] : [-bogieOff, cab && s.nose > 6 ? frontZ - 3.2 : bogieOff]
  for (const bz of bogies) {
    parts.push(colored(at(new BoxGeometry(2.1, 0.32, 2.7), 0, wheelR + 0.12, bz), dark))
    parts.push(colored(at(new BoxGeometry(0.25, 0.45, 2.5), (s.gauge / 2 + 0.28), wheelR + 0.05, bz), 0x3a3c3e))
    parts.push(colored(at(new BoxGeometry(0.25, 0.45, 2.5), -(s.gauge / 2 + 0.28), wheelR + 0.05, bz), 0x3a3c3e))
    for (const az of [-1.05, 1.05])
      for (const x of [-s.gauge / 2 - 0.03, s.gauge / 2 + 0.03])
        parts.push(colored(at(new CylinderGeometry(wheelR, wheelR, 0.13, 14), x, wheelR, bz + az, 0, 0, Math.PI / 2), 0x3d3a37))
  }
  // Rubber-tyred AGT / monorail running gear: a dark skirt.
  if (!bogies.length) parts.push(colored(at(new BoxGeometry(W - 0.3, y0, L - 2), 0, y0 / 2, 0), dark))
  // Underfloor equipment between the bogies.
  if (s.kind !== 'tram' && bogies.length) {
    const span = Math.abs(bogies[1] - bogies[0]) - 3.4
    const mid = (bogies[0] + bogies[1]) / 2
    for (let i = 0; i < 4; i++) {
      const len = span / 4 - 0.35
      parts.push(colored(at(new BoxGeometry(W - 0.55, 0.55, len), 0, y0 - 0.28, mid - span / 2 + (i + 0.5) * (span / 4)), i % 2 ? dark : grey))
    }
  }
  // Gangway bellows at coupled ends.
  const bell = (z: number) => parts.push(colored(at(new BoxGeometry(1.25, 2.1, 0.55), 0, s.floor + 1.05, z), 0x1d1d1d))
  bell(-L / 2 - 0.2)
  if (!cab) bell(L / 2 + 0.2)
  // Roof: AC units (commuter) and pantograph.
  if (s.kind !== 'shinkansen' && s.kind !== 'cable') {
    parts.push(colored(at(new BoxGeometry(1.9, 0.32, 3.2), 0, s.height + 0.12, -L * 0.18), 0x8e9295))
    if (L > 15) parts.push(colored(at(new BoxGeometry(1.9, 0.32, 3.2), 0, s.height + 0.12, L * 0.2), 0x8e9295))
  }
  if (panto) {
    const pz = cab ? -L * 0.32 : L * 0.36
    const top = s.height + 1.45
    parts.push(colored(at(new BoxGeometry(1.2, 0.15, 1.2), 0, s.height + 0.08, pz), 0x404244))
    parts.push(colored(at(new BoxGeometry(0.06, 0.06, 1.55), 0, s.height + 0.62, pz - 0.35, -0.95, 0, 0), 0x303234))
    parts.push(colored(at(new BoxGeometry(0.06, 0.06, 1.45), 0, s.height + 1.12, pz - 0.15, 0.85, 0, 0), 0x303234))
    parts.push(colored(at(new BoxGeometry(1.9, 0.05, 0.08), 0, top, pz + 0.12), 0x2a2a2a))
    if (s.kind === 'shinkansen') parts.push(colored(at(new BoxGeometry(0.6, 0.35, 2.4), 0, s.height + 0.15, pz), 0xd8d8d6)) // pantograph cover
  }
  // Cab skirt / snowplough.
  if (cab && s.nose < 3) parts.push(colored(at(new BoxGeometry(W - 0.5, 0.55, 0.25), 0, y0 - 0.2, L / 2 - 0.25), 0x2e3032))
  return assemble(parts)
}

// ------------------------------------------------------------ material

const bodyFrag = /* glsl */ `
uniform vec3 uBody; uniform vec3 uStripe; uniform vec3 uStripe2;
uniform float uMetal; uniform float uPattern; uniform float uLen; uniform float uDoors;
uniform float uFloor; uniform float uHeight; uniform float uWidth; uniform float uTail; uniform float uCut;
uniform float uNight; uniform float uNose;
varying vec3 vP; varying vec3 vN; varying float vPart;
float aas(float e, float x) { float w = max(fwidth(x), 1e-4); return smoothstep(e - w, e + w, x); }
float box(vec2 p, vec2 a, vec2 b) { return aas(a.x, p.x) * (1.0 - aas(b.x, p.x)) * aas(a.y, p.y) * (1.0 - aas(b.y, p.y)); }
`

const bodyMain = /* glsl */ `
  vec3 albedo = uBody; float rough = mix(0.28, 0.32, uMetal); float metal = uMetal * 0.85; vec3 emis = vec3(0.0);
  float y = vP.y; float z = vP.z; float ax = abs(vP.x);
  bool side = abs(vN.x) > 0.55;
  bool roof = vN.y > 0.55 && y > uHeight - 0.6;
  float win = 0.0; float door = 0.0; float glass = 0.0;
  float winBot = uFloor + 0.85; float winTop = uFloor + 1.95;
  if (uPattern == 2.0 || uPattern == 3.0 || uPattern == 5.0) { winBot = uFloor + 0.62; winTop = uFloor + 1.14; }
  if (vPart < -0.5 && side) {
    if (uDoors > 0.0) {
      float pitch = uLen / uDoors;
      float dz = mod(z + uLen * 0.5, pitch) - pitch * 0.5;
      float dw = 0.65;
      door = box(vec2(dz, y), vec2(-dw, uFloor - 0.05), vec2(dw, uFloor + 1.88));
      float doorWin = box(vec2(abs(dz), y), vec2(0.12, uFloor + 0.95), vec2(dw - 0.1, uFloor + 1.75));
      float seam = 1.0 - aas(0.012, abs(dz));
      float bandWin = box(vec2(abs(dz), y), vec2(dw + 0.25, winBot), vec2(pitch * 0.5 - 0.25, winTop));
      float pillar = 1.0 - aas(0.06, abs(fract((abs(dz) - dw - 0.25) / 1.45) - 0.5) * 1.45);
      win = max(doorWin * door, bandWin * (1.0 - pillar));
      albedo = mix(albedo, albedo * 0.82, door * (1.0 - doorWin));
      albedo = mix(albedo, vec3(0.05), seam * door);
    } else {
      // Shinkansen: a small window per seat row, doors near both ends.
      float dz = abs(z) - (uLen * 0.5 - 1.6);
      door = box(vec2(dz, y), vec2(-0.5, uFloor - 0.05), vec2(0.5, uFloor + 1.85));
      float seat = abs(fract(z / 1.04) - 0.5) * 2.0;
      win = (1.0 - aas(0.62, seat)) * box(vec2(abs(z), y), vec2(0.0, winBot), vec2(uLen * 0.5 - 2.6, winTop));
      albedo = mix(albedo, albedo * 0.9, door);
    }
    glass = win;
  }
  // Liveries.
  if (uPattern == 0.0) { // stainless EMU: line colour bands below and above windows
    float b1 = box(vec2(0.0, y), vec2(-1.0, winBot - 0.32), vec2(1.0, winBot - 0.1));
    float b2 = box(vec2(0.0, y), vec2(-1.0, winTop + 0.12), vec2(1.0, winTop + 0.24));
    albedo = mix(albedo, uStripe, max(b1, b2) * (1.0 - door * 0.6));
    if (side) albedo = mix(albedo, uStripe, door * box(vec2(0.0, y), vec2(-1.0, uFloor + 1.82), vec2(1.0, uFloor + 1.9)));
  } else if (uPattern == 1.0) { // metro aluminium: single band + window-belt
    float b1 = box(vec2(0.0, y), vec2(-1.0, winTop + 0.12), vec2(1.0, winTop + 0.32));
    float b2 = box(vec2(0.0, y), vec2(-1.0, winBot - 0.18), vec2(1.0, winBot - 0.06));
    albedo = mix(albedo, uStripe, max(b1, b2 * 0.9));
  } else if (uPattern == 6.0) { // painted metro (Ginza yellow, Marunouchi red with white wave)
    float b = box(vec2(0.0, y), vec2(-1.0, winBot - 0.25), vec2(1.0, winBot - 0.12));
    albedo = mix(albedo, uStripe, b);
  } else if (uPattern == 2.0) { // N700: blue stripe under the windows
    float b1 = box(vec2(0.0, y), vec2(-1.0, uFloor - 0.15), vec2(1.0, uFloor + 0.16));
    float b2 = box(vec2(0.0, y), vec2(-1.0, uFloor + 0.24), vec2(1.0, uFloor + 0.3));
    albedo = mix(albedo, uStripe, b1);
    albedo = mix(albedo, uStripe2, b2);
  } else if (uPattern == 3.0) { // E5: tokiwa green top (running down the nose), pink stripe, white lower
    float th = vPart >= 0.0 && vPart <= 1.0 ? mix(uFloor + 1.35, uFloor - 0.05, pow(vPart, 0.9)) : uFloor + 1.35;
    float top = aas(th, y);
    albedo = mix(albedo, uStripe, top * (1.0 - glass));
    float pink = box(vec2(0.0, y), vec2(-1.0, th - 0.1), vec2(1.0, th - 0.02));
    albedo = mix(albedo, uStripe2, pink);
  } else if (uPattern == 5.0) { // E7: sky-blue roof, copper + blue bands
    float top = aas(uFloor + 1.55, y);
    albedo = mix(albedo, vec3(0.38, 0.62, 0.82), top * (1.0 - glass));
    albedo = mix(albedo, uStripe, box(vec2(0.0, y), vec2(-1.0, uFloor - 0.1), vec2(1.0, uFloor + 0.18)));
    albedo = mix(albedo, uStripe2, box(vec2(0.0, y), vec2(-1.0, uFloor + 0.2), vec2(1.0, uFloor + 0.27)));
  } else if (uPattern == 4.0) { // tram: coloured lower body, cream upper
    albedo = mix(uStripe, albedo, aas(uFloor + 0.75, y));
  }
  // Nose: windscreen, headlights.
  if (vPart >= 0.0 && vPart <= 1.0) {
    float t = vPart;
    float ws = (1.0 - aas(0.36, t)) * aas(0.08, t) * aas(uFloor + 0.55 + t * 0.6, y) * (1.0 - aas(0.62, ax / (uWidth * 0.5)));
    glass = max(glass, ws);
    float hl = box(vec2(t, y), vec2(0.6, uFloor - 0.35), vec2(0.78, uFloor - 0.05)) * aas(0.35, ax);
    vec3 lamp = uTail > 0.5 ? vec3(1.0, 0.05, 0.03) * 2.5 : vec3(1.0, 0.97, 0.9) * 6.0;
    emis += lamp * hl;
    albedo = mix(albedo, vec3(0.1), hl);
  }
  // Flat cab face: windscreen, headlights, destination LED, dark mask.
  if (vPart > 1.5) {
    vec2 q = vec2(vP.x, y);
    float mask = box(q, vec2(-uWidth * 0.5 + 0.12, uFloor + 0.55), vec2(uWidth * 0.5 - 0.12, uHeight - 0.15));
    albedo = mix(albedo, vec3(0.06), mask);
    float ws = box(q, vec2(-uWidth * 0.5 + 0.22, uFloor + 0.95), vec2(uWidth * 0.5 - 0.22, uHeight - 0.62));
    glass = max(glass, ws);
    float led = box(q, vec2(-0.75, uHeight - 0.5), vec2(0.75, uHeight - 0.25));
    float glyph = step(0.5, fract(sin(dot(floor(q * vec2(28.0, 18.0)), vec2(12.9, 78.2))) * 43758.5)) * 0.8;
    emis += vec3(1.0, 0.55, 0.1) * led * glyph * mix(0.4, 0.9, uNight) * (1.0 - uTail);
    float hl = box(vec2(ax, y), vec2(uWidth * 0.5 - 0.6, uFloor + 0.3), vec2(uWidth * 0.5 - 0.25, uFloor + 0.52));
    vec3 lamp = uTail > 0.5 ? vec3(1.0, 0.05, 0.03) * 2.5 : vec3(1.0, 0.97, 0.9) * 6.0;
    emis += lamp * hl;
    albedo = mix(albedo, uStripe, box(q, vec2(-uWidth, uFloor + 0.05), vec2(uWidth, uFloor + 0.3)) * (1.0 - hl));
  }
  if (roof) { albedo = mix(albedo, vec3(0.45, 0.46, 0.47), 0.7); rough = 0.6; metal = 0.3; }
  if (y < uFloor - 0.05 && vPart < -0.5 && uPattern != 4.0 && uPattern != 2.0 && uPattern != 5.0) albedo *= 0.55; // grimy skirt
  // Glass: dark tinted with lit interior behind.
  if (glass > 0.0) {
    if (uCut > 0.5 && glass > 0.5) discard;
    vec3 inside = vec3(0.86, 0.9, 0.95) * (0.04 + 0.08 * uNight);
    albedo = mix(albedo, vec3(0.03, 0.035, 0.04), glass);
    rough = mix(rough, 0.05, glass);
    metal = mix(metal, 0.0, glass);
    emis += inside * glass;
  }
`

export function createTrainMaterial(s: TrainStyle, variant: 'body' | 'tail' | 'cut' = 'body'): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.5 })
  m.name = `train-${s.key}-${variant}`
  m.customProgramCacheKey = () => 'nihon-train-v1'
  const uniforms: Record<string, IUniform> = {
    uBody: { value: s.body },
    uStripe: { value: s.stripe },
    uStripe2: { value: s.stripe2 },
    uMetal: { value: s.metal },
    uPattern: { value: s.pattern },
    uLen: { value: s.carLen },
    uDoors: { value: s.doors },
    uFloor: { value: s.floor },
    uHeight: { value: s.height },
    uWidth: { value: s.width },
    uNose: { value: s.nose },
    uTail: { value: variant === 'tail' ? 1 : 0 },
    uCut: { value: variant === 'cut' ? 1 : 0 },
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uNight: buildingUniforms.uNight })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part;\nvarying vec3 vP; varying vec3 vN; varying float vPart;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position; vN = normal; vPart = part;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${bodyFrag}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${bodyMain}\ndiffuseColor.rgb = albedo;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = rough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = metal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += emis;')
  }
  return m
}

// ------------------------------------------------------------ assembly

interface StyleKit {
  plain: BufferGeometry
  cab: BufferGeometry
  detailPlain: BufferGeometry
  detailPanto: BufferGeometry
  detailCab: BufferGeometry
  mat: MeshStandardMaterial
  tail: MeshStandardMaterial
  detailMat: MeshStandardMaterial
}

const kits = new Map<string, StyleKit>()

function kit(s: TrainStyle): StyleKit {
  let k = kits.get(s.key)
  if (k) return k
  k = {
    plain: sweptBody(s, false),
    cab: sweptBody(s, true),
    detailPlain: details(s, false, false),
    detailPanto: details(s, false, s.pantograph),
    detailCab: details(s, true, s.pantograph && s.kind === 'tram'),
    mat: createTrainMaterial(s, 'body'),
    tail: createTrainMaterial(s, 'tail'),
    detailMat: new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 }),
  }
  kits.set(s.key, k)
  return k
}

export interface Car {
  group: Group
  length: number
  cab: 'front' | 'rear' | 'none'
}

/**
 * Build a consist. Car 0 is the leading car (cab facing +z); cars run
 * backwards along -z. Positions are set each frame by the train runner.
 */
export function buildConsist(s: TrainStyle): Car[] {
  const k = kit(s)
  const cars: Car[] = []
  const n = Math.max(1, s.cars)
  for (let i = 0; i < n; i++) {
    const g = new Group()
    const front = i === 0
    const rear = i === n - 1 && n > 1
    const cab = front || rear
    const body = new Mesh(cab ? k.cab : k.plain, front || n === 1 ? k.mat : k.tail)
    const det = new Mesh(cab ? k.detailCab : i % 2 === 1 ? k.detailPanto : k.detailPlain, k.detailMat)
    body.castShadow = det.castShadow = true
    body.receiveShadow = true
    const inner = new Group()
    inner.add(body, det)
    if (rear) inner.rotation.y = Math.PI // cab faces backwards
    g.add(inner)
    g.userData.body = body
    cars.push({ group: g, length: cab ? s.cabLen : s.carLen, cab: front ? 'front' : rear ? 'rear' : 'none' })
  }
  return cars
}

/** Clone of the body material with see-through windows, for the car you ride in. */
export function cutawayMaterial(s: TrainStyle): MeshStandardMaterial {
  return createTrainMaterial(s, 'cut')
}
