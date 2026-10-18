// Street-level materials, procedurally shaded so no texture downloads are
// needed: asphalt with Japanese road markings, interlocking sidewalk pavers,
// kawara roof tiles, weathered concrete, ballast with sleepers, steel rail.
import {
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineBasicMaterial,
  MeshStandardMaterial,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
  type IUniform,
} from 'three'
import { buildingUniforms } from './building'

let noiseTex: DataTexture | null = null

/** 256² tiling value-noise (4 octaves) for surface breakup. */
export function noiseTexture(): DataTexture {
  if (noiseTex) return noiseTex
  const N = 256
  const data = new Uint8Array(N * N)
  const lattice = (f: number, seed: number) => {
    const g = new Float32Array(f * f)
    for (let i = 0; i < g.length; i++) {
      const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
      g[i] = s - Math.floor(s)
    }
    return g
  }
  const acc = new Float32Array(N * N)
  let amp = 1
  let norm = 0
  for (const f of [8, 16, 32, 64, 128]) {
    const g = lattice(f, f)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * f
        const fy = (y / N) * f
        const ix = Math.floor(fx)
        const iy = Math.floor(fy)
        const tx = fx - ix
        const ty = fy - iy
        const sx = tx * tx * (3 - 2 * tx)
        const sy = ty * ty * (3 - 2 * ty)
        const a = g[(iy % f) * f + (ix % f)]
        const b = g[(iy % f) * f + ((ix + 1) % f)]
        const c = g[((iy + 1) % f) * f + (ix % f)]
        const d = g[((iy + 1) % f) * f + ((ix + 1) % f)]
        acc[y * N + x] += ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy) * amp
      }
    norm += amp
    amp *= 0.55
  }
  for (let i = 0; i < data.length; i++) data[i] = Math.round((acc[i] / norm) * 255)
  noiseTex = new DataTexture(data, N, N, RedFormat, UnsignedByteType)
  noiseTex.wrapS = noiseTex.wrapT = RepeatWrapping
  noiseTex.magFilter = LinearFilter
  noiseTex.minFilter = LinearMipmapLinearFilter
  noiseTex.generateMipmaps = true
  noiseTex.needsUpdate = true
  return noiseTex
}

interface Patch {
  vertexHead?: string
  vertexBody?: string
  fragmentHead: string
  albedo: string // GLSL computing vec3 albedo, float rough, float metal; may use vUv, vWPos
}

const shared = /* glsl */ `
uniform sampler2D uNoise;
uniform float uNight;
uniform float uWet;
uniform float uSnow;
uniform float uTime;
varying vec3 vWPos;
varying vec2 vUv2;
float n1(vec2 p) { return texture2D(uNoise, p).r; }
float fbm(vec2 p) { return n1(p) * 0.6 + n1(p * 4.13) * 0.3 + n1(p * 17.7) * 0.1; }
`
const fragOnly = /* glsl */ `
float aa(float edge, float x) { float w = max(fwidth(x), 1e-4); return smoothstep(edge - w, edge + w, x); }
float band(float x, float a, float b) { return aa(a, x) * (1.0 - aa(b, x)); }
`

function patched(name: string, p: Patch, params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...params })
  m.name = name
  m.customProgramCacheKey = () => `nihon-${name}-v1`
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, buildingUniforms, { uNoise: { value: noiseTexture() } as IUniform })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${shared}\n${p.vertexHead ?? ''}`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vUv2 = uv;
        ${p.vertexBody ?? ''}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${shared}\n${fragOnly}\n${p.fragmentHead}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 albedo = vec3(0.5); float rough = 0.9; float metal = 0.0; vec3 emis = vec3(0.0);
        ${p.albedo}
        diffuseColor.rgb = albedo;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = rough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = metal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += emis;')
  }
  return m
}

/** Asphalt with Japanese markings. road attr: halfWidth, class, junctionDist, lanes. */
export function createRoadMaterial(): MeshStandardMaterial {
  const m = patched(
    'road',
    {
      vertexHead: 'attribute vec4 road; varying vec4 vRoad;',
      vertexBody: 'vRoad = road;',
      fragmentHead: 'varying vec4 vRoad;',
      albedo: /* glsl */ `
        float u = vUv2.x;            // metres across from centreline
        float s = vUv2.y;            // metres along
        float hw = vRoad.x;
        float cls = vRoad.y;
        float jd = vRoad.z;
        float lanes = vRoad.w;
        vec2 wp = vWPos.xz;
        float grain = fbm(wp * 0.11);
        float patchy = smoothstep(0.45, 0.75, n1(wp * 0.013));
        vec3 asphalt = mix(vec3(0.115, 0.118, 0.122), vec3(0.165, 0.165, 0.16), grain);
        asphalt = mix(asphalt, vec3(0.085, 0.087, 0.09), patchy * 0.7);   // newer resurfaced patches
        // tyre tracks polish the lanes slightly
        float track = (1.0 - smoothstep(0.0, 0.5, abs(abs(u) - hw * 0.5)));
        asphalt *= 1.0 - track * 0.05;
        float paint = 0.0;
        float markOK = step(6.0, jd);  // markings stop at junctions
        bool isMotor = cls < 0.5;
        bool major = cls < 4.5;
        // edge lines (outer white)
        if (major || cls < 5.5) paint += band(abs(u), hw - 0.35, hw - 0.2) * markOK;
        // centre line: solid white on 2-lane roads, dashed lane dividers on wider
        if (!isMotor && major && lanes >= 2.0) {
          float centre = band(abs(u), 0.0, 0.08);
          if (lanes >= 4.0) {
            paint += band(abs(u), 0.1, 0.25) * markOK; // double centre (yellow-ish no passing)
            float dash = step(fract(s / 10.0), 0.5);
            paint += band(abs(abs(u) - hw * 0.5), 0.0, 0.075) * dash * markOK;
          } else paint += centre * markOK;
        }
        if (isMotor) {
          float dash = step(fract(s / 20.0), 0.4);
          paint += band(abs(u), 0.0, 0.08) * dash;
        }
        // Zebra crossings (横断歩道) a few metres before junctions on major roads.
        float zebra = 0.0;
        if (major && !isMotor && jd > 2.0 && jd < 6.0) {
          zebra = step(0.5, fract(u / 0.9 + 0.25)) * step(abs(u), hw - 0.3);
          // stop line
          zebra = max(zebra, band(jd, 6.2, 6.6) * step(abs(u), hw - 0.3));
        }
        paint = clamp(paint + zebra, 0.0, 1.0);
        float wornPaint = paint * (0.75 + 0.25 * fbm(wp * 0.7));
        vec3 white = vec3(0.78, 0.78, 0.76);
        albedo = mix(asphalt, white, wornPaint);
        // wetness darkens and makes it glossy, puddles in low spots
        float puddle = smoothstep(0.62, 0.7, n1(wp * 0.05)) * uWet;
        albedo *= mix(1.0, 0.55, uWet);
        rough = mix(mix(0.92, 0.5, wornPaint), 0.12, max(uWet * 0.6, puddle));
        albedo = mix(albedo, vec3(0.92), uSnow * (1.0 - track * 0.8));
      `,
    },
    { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
  )
  return m
}

export function createSidewalkMaterial(): MeshStandardMaterial {
  return patched(
    'sidewalk',
    {
      fragmentHead: '',
      albedo: /* glsl */ `
        vec2 wp = vWPos.xz;
        // 30x30 cm interlocking pavers, slight per-block shade variation,
        // and the yellow tactile paving strip (点字ブロック) Japan pioneered.
        vec2 g = wp / 0.3;
        vec2 cell = floor(g);
        vec2 f = fract(g);
        float joint = 1.0 - aa(0.04, min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y)));
        float shade = n1(cell * 0.137) * 0.12;
        vec3 paver = vec3(0.52, 0.51, 0.49) - shade;
        paver = mix(paver, vec3(0.36, 0.35, 0.34), joint * 0.6);
        float tactile = band(vUv2.x, 0.55, 0.85);
        vec3 yellow = vec3(0.78, 0.62, 0.12);
        albedo = mix(paver, yellow, tactile);
        if (vUv2.x < 0.0) albedo = vec3(0.6, 0.6, 0.58); // kerb
        albedo *= mix(1.0, 0.6, uWet);
        rough = mix(0.85, 0.3, uWet);
        albedo = mix(albedo, vec3(0.92), uSnow);
      `,
    },
    { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 },
  )
}

/** Kawara (瓦) or metal roofing; seed picks the type and colour. */
export function createRoofMaterial(): MeshStandardMaterial {
  return patched('roof', {
    vertexHead: 'attribute float seed; flat varying float vSeedR;',
    vertexBody: 'vSeedR = seed;',
    fragmentHead: 'flat varying float vSeedR;',
    albedo: /* glsl */ `
      float style = floor(vSeedR + 0.0001);
      float sd = floor(fract(vSeedR) * 4096.0 + 0.5) / 4096.0;
      float u = vUv2.x;
      float v = vUv2.y;
      float kind = style > 3.5 && style < 4.5 ? 0.0 : fract(sd * 7.31);
      vec3 col;
      float rowH = 0.27;
      if (style > 1.5 && style < 2.5) {
        // 茅葺 thatch: thick straw, darkened and mossy with age, combed ridges.
        float straw = fbm(vec2(u * 3.0, v * 0.6) + sd * 9.0);
        col = mix(vec3(0.30, 0.24, 0.15), vec3(0.46, 0.38, 0.24), straw);
        col = mix(col, vec3(0.20, 0.22, 0.13), smoothstep(0.55, 0.8, n1(vWPos.xz * 0.05 + sd)) * 0.5);
        col *= 0.88 + 0.18 * sin(u * 9.0 + straw * 4.0);
        rough = 0.95;
      } else if (style > 5.5 && style < 6.5) {
        // 赤瓦 Ryukyu red tiles with white mortar ridges.
        float row = fract(v / 0.24);
        float mortar = smoothstep(0.9, 0.97, fract(u / 0.32));
        col = mix(vec3(0.62, 0.22, 0.14), vec3(0.88, 0.86, 0.80), mortar * 0.8);
        col *= 0.85 + 0.2 * smoothstep(0.0, 0.8, row);
        rough = 0.6;
      } else if (style > 7.5) {
        // Shrine roofs: green copper (緑青) or cypress bark (檜皮葺).
        col = fract(sd * 3.7) < 0.5 ? vec3(0.27, 0.45, 0.38) : vec3(0.27, 0.17, 0.11);
        col *= 0.9 + 0.15 * fbm(vec2(u, v) * 0.8);
        rough = 0.55;
        metal = fract(sd * 3.7) < 0.5 ? 0.3 : 0.0;
      } else if (kind < 0.55) {
        // いぶし瓦 (smoked silver-grey) or glazed blue/brown tiles
        float c = fract(sd * 13.7);
        col = c < 0.55 ? vec3(0.20, 0.21, 0.23) : (c < 0.8 ? vec3(0.13, 0.17, 0.26) : vec3(0.27, 0.17, 0.12));
        float row = fract(v / rowH);
        float wave = sin(u / 0.3 * 6.2831) * 0.5 + 0.5;
        float shadeRow = smoothstep(0.75, 1.0, row) * 0.45;
        col *= 0.85 + wave * 0.25 - shadeRow;
        rough = 0.55;
      } else {
        // corrugated metal (galvalume / painted) — common in suburbs & countryside
        float c = fract(sd * 5.1);
        col = c < 0.4 ? vec3(0.32, 0.33, 0.34) : (c < 0.65 ? vec3(0.12, 0.2, 0.32) : (c < 0.85 ? vec3(0.42, 0.12, 0.1) : vec3(0.15, 0.25, 0.18)));
        float rib = smoothstep(0.85, 1.0, fract(u / 0.45));
        col *= 0.9 + rib * 0.2;
        rough = 0.45;
        metal = 0.4;
      }
      col *= 0.9 + 0.2 * fbm(vWPos.xz * 0.3);
      vec3 fn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
      albedo = mix(col, vec3(0.93), uSnow * smoothstep(0.2, 0.6, abs(fn.y)));
      rough = mix(rough, 0.2, uWet);
    `,
  })
}

export function createConcreteMaterial(): MeshStandardMaterial {
  return patched(
    'concrete',
    {
      fragmentHead: '',
      albedo: /* glsl */ `
        float g = fbm(vWPos.xz * 0.05 + vWPos.y * 0.05);
        albedo = mix(vec3(0.45, 0.45, 0.43), vec3(0.6, 0.6, 0.58), g);
        // water stains run down from the deck edge
        albedo *= 1.0 - 0.15 * smoothstep(0.4, 0.9, n1(vec2(vWPos.x * 0.2 + vWPos.z * 0.2, vWPos.y * 0.02)));
        rough = 0.92;
      `,
    },
    { side: DoubleSide },
  )
}

export function createBallastMaterial(): MeshStandardMaterial {
  return patched('ballast', {
    fragmentHead: '',
    albedo: /* glsl */ `
      float s = vUv2.y;
      float u = vUv2.x;
      float stones = fbm(vWPos.xz * 1.7);
      vec3 b = mix(vec3(0.33, 0.31, 0.29), vec3(0.5, 0.47, 0.43), stones);
      // concrete sleepers (PC枕木) every 0.6 m
      float sleeper = band(fract(s / 0.6), 0.0, 0.35) * step(abs(u), 1.2);
      albedo = mix(b, vec3(0.55, 0.55, 0.52), sleeper);
      albedo *= 1.0 - 0.25 * smoothstep(0.3, 1.6, abs(u)) ;
      rough = 0.95;
    `,
  })
}

export function createRailMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0x8a8580, metalness: 0.9, roughness: 0.32, side: DoubleSide, name: 'rail' })
}

export function createWireMaterial(): LineBasicMaterial {
  return new LineBasicMaterial({ color: 0x141414, transparent: true, opacity: 0.85 })
}
