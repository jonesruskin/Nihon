// Procedural facade material shared by PLATEAU and OSM buildings.
//
// Japanese urban facades are, overwhelmingly: beige/white/grey tile or
// concrete mid-rises with regular window bands, glass curtain-wall towers,
// and small 2-storey houses. This shader derives windows, mullions, floor
// bands, glass reflectance and night lighting from world position, the
// wall's normal, the height above the building's base (`bh`) and a stable
// per-building random seed (`seed`). No UVs needed, so it works on any mesh.
import { Color, MeshStandardMaterial, type IUniform } from 'three'

export interface BuildingUniforms {
  uNight: IUniform<number> // 0 day .. 1 deep night
  uWet: IUniform<number> // rain wetness 0..1
  uSnow: IUniform<number> // snow cover on roofs 0..1
  uTime: IUniform<number>
}

export const buildingUniforms: BuildingUniforms = {
  uNight: { value: 0 },
  uWet: { value: 0 },
  uSnow: { value: 0 },
  uTime: { value: 0 },
}

const common = /* glsl */ `
uniform float uNight;
uniform float uWet;
uniform float uSnow;
uniform float uTime;
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vBh;
flat varying float vSeed;
flat varying float vKind;
float bhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bhash1(float p) { return fract(sin(p * 91.345) * 47453.5453); }
`

const vertexHead = /* glsl */ `
attribute float bh;
attribute float seed;
attribute float kind;
`

/**
 * kind: 0 = generic (decide by height), 1 = house, 2 = office/commercial,
 * 3 = glass tower, 4 = industrial/warehouse, 5 = temple/shrine (wood)
 */
export function createBuildingMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 })
  m.name = 'facade'
  m.customProgramCacheKey = () => 'nihon-facade-v1'
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, buildingUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}\n${common}`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * objectNormal);
        vBh = bh;
        vSeed = seed;
        vKind = kind;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${common}\n${facadeFns}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        FacadeSample fs = facade();
        diffuseColor.rgb *= fs.albedo;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = fs.roughness;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = fs.metalness;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += fs.emissive;`,
      )
  }
  return m
}

const facadeFns = /* glsl */ `
float aastep(float edge, float x) { float w = max(fwidth(x) * 0.7, 1e-4); return smoothstep(edge - w, edge + w, x); }
struct FacadeSample { vec3 albedo; float roughness; float metalness; vec3 emissive; };

vec3 palette(float s, float kind) {
  // Measured-ish albedos of common Japanese cladding.
  vec3 tile_beige = vec3(0.62, 0.56, 0.47);
  vec3 tile_white = vec3(0.74, 0.73, 0.70);
  vec3 concrete = vec3(0.52, 0.52, 0.50);
  vec3 tile_brown = vec3(0.42, 0.33, 0.27);
  vec3 grey_panel = vec3(0.38, 0.39, 0.40);
  vec3 cream = vec3(0.70, 0.66, 0.56);
  vec3 siding_grey = vec3(0.55, 0.55, 0.52);
  vec3 siding_navy = vec3(0.24, 0.27, 0.32);
  if (kind > 0.5 && kind < 1.5) {
    // houses: siding in white/beige/grey/brown/navy
    if (s < 0.25) return tile_white;
    if (s < 0.45) return cream;
    if (s < 0.65) return siding_grey;
    if (s < 0.82) return tile_brown;
    return siding_navy;
  }
  if (s < 0.22) return tile_beige;
  if (s < 0.42) return tile_white;
  if (s < 0.58) return concrete;
  if (s < 0.70) return tile_brown;
  if (s < 0.84) return grey_panel;
  return cream;
}

FacadeSample facade() {
  FacadeSample o;
  o.albedo = vec3(1.0);
  o.roughness = 0.85;
  o.metalness = 0.0;
  o.emissive = vec3(0.0);
  // Exact face normal from derivatives: interpolated (quantised) normals
  // jitter, and u = dot(worldPos, tangent) amplifies that by the distance
  // from the origin.
  vec3 n = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
  if (dot(n, vWNrm) < 0.0) n = -n;
  // Hashes amplify tiny interpolation error enormously: keep these exact.
  float s = floor(vSeed * 4096.0 + 0.5) / 4096.0;
  float kind = floor(vKind + 0.5);
  float up = n.y;
  if (up > 0.6) {
    // Roofs: concrete / waterproofing membrane / metal, with snow.
    float r = bhash(floor(vWPos.xz * 0.5) + s * 17.0);
    vec3 roof = mix(vec3(0.42, 0.42, 0.40), vec3(0.55, 0.55, 0.52), r * 0.5 + s * 0.5);
    if (kind > 0.5 && kind < 1.5) roof = vec3(0.22, 0.23, 0.25);
    o.albedo = mix(roof, vec3(0.92), uSnow);
    o.roughness = mix(0.9, 0.25, uWet);
    return o;
  }
  if (up < -0.6) { o.albedo = vec3(0.35); return o; }

  // Walls. Coordinates: u along the wall (m), v above building base (m).
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  float u = dot(vWPos.xz, t);
  float v = vBh;
  bool glassTower = kind > 2.5 && kind < 3.5;
  bool house = kind > 0.5 && kind < 1.5;
  bool industrial = kind > 3.5 && kind < 4.5;
  bool wood = kind > 4.5;

  float floorH = house ? 2.9 : (glassTower ? 4.0 : mix(3.2, 3.9, bhash1(s * 3.1)));
  float bay = house ? mix(2.6, 3.6, bhash1(s * 5.7)) : (glassTower ? 1.5 : mix(1.8, 3.4, bhash1(s * 7.3)));
  float fl = floor(v / floorH);
  float fy = fract(v / floorH);
  float bx = floor(u / bay);
  float fx = fract(u / bay);

  vec3 wall = palette(bhash1(s * 11.7), kind);
  // Low-frequency weathering: rain streaks under windows, dirt near street.
  float streak = bhash(vec2(floor(u * 1.5), floor(v * 0.2))) * 0.05;
  wall *= 1.0 - streak - 0.08 * smoothstep(3.0, 0.0, v);
  if (wood) wall = vec3(0.30, 0.20, 0.13);

  float winW = house ? 0.42 : (glassTower ? 0.9 : mix(0.45, 0.75, bhash1(s * 13.1)));
  float winH = house ? 0.45 : (glassTower ? 0.82 : mix(0.45, 0.65, bhash1(s * 17.9)));
  float wx = abs(fx - 0.5) * 2.0;
  float wy = abs(fy - 0.55) * 2.0;
  float isWin = (1.0 - aastep(winW, wx)) * (1.0 - aastep(winH, wy));
  // Houses: only some bays have windows; ground floor of commercial = shopfront.
  if (house) isWin *= step(0.35, bhash(vec2(bx, fl) + s));
  bool shop = !house && !glassTower && !industrial && v < 4.2 && bhash1(s * 23.0) > 0.25;
  if (shop) { isWin = (1.0 - aastep(0.92, abs(fx - 0.5) * 2.0)) * aastep(0.08, v) * (1.0 - aastep(3.3, v)); }
  if (industrial) isWin *= aastep(0.6, fy) * (1.0 - aastep(0.85, fy)) * step(0.5, bhash1(bx + s));
  if (wood) isWin = 0.0;
  // Far away the pattern is sub-pixel: fade to its average to avoid moire.
  float fw = max(fwidth(u / bay), fwidth(v / floorH));
  isWin = mix(isWin, winW * winH * (house ? 0.6 : 1.0), smoothstep(0.2, 0.55, fw));
  // Horizontal spandrel band (common on Japanese mid-rises).
  float band = (!house && !glassTower) ? aastep(0.9, fy) * 0.12 : 0.0;

  // Glass shows a mix of sky reflection and interiors: blinds, curtains,
  // ceiling lights. Each pane gets its own interior.
  float pane = bhash(vec2(bx * 3.7 + s * 50.0, fl * 1.3 + s * 20.0));
  vec3 interior = mix(vec3(0.10, 0.11, 0.12), vec3(0.42, 0.40, 0.36), step(0.62, pane) * fract(pane * 13.0));
  vec3 glass = mix(vec3(0.13, 0.16, 0.19), interior, 0.55);
  if (glassTower) {
    glass = mix(vec3(0.16, 0.22, 0.27), vec3(0.24, 0.28, 0.31), bhash1(s * 29.0));
    wall = mix(vec3(0.30, 0.32, 0.34), vec3(0.55, 0.56, 0.58), bhash1(s * 31.0));
  }
  o.albedo = mix(wall * (1.0 - band), glass, isWin);
  o.roughness = mix(mix(0.82, 0.35, uWet), 0.04, isWin);
  o.metalness = isWin * (glassTower ? 0.55 : 0.3);

  // Night: a believable fraction of windows lit, warm or fluorescent white.
  if (uNight > 0.01) {
    float h = bhash(vec2(bx * 1.7 + s * 91.0, fl * 3.1 + s * 13.0));
    float occupancy = house ? 0.45 : (glassTower ? 0.55 : 0.5);
    float lit = step(h, occupancy) * isWin;
    vec3 warm = vec3(1.0, 0.72, 0.42);
    vec3 cool = vec3(0.85, 0.92, 1.0);
    vec3 col = mix(warm, cool, step(0.5, bhash1(h * 7.0 + s)));
    float intensity = mix(1.2, 3.0, bhash1(h * 3.0));
    if (shop) { lit = isWin; intensity = 5.0; col = vec3(1.0, 0.9, 0.75); }
    o.emissive = col * lit * intensity * uNight;
  }
  return o;
}
`

export function nightFactorFromSun(sunElevationDeg: number): number {
  // Lights come on through civil twilight.
  return Math.min(1, Math.max(0, (2 - sunElevationDeg) / 8))
}

export const BUILDING_KIND = { generic: 0, house: 1, office: 2, glass: 3, industrial: 4, wood: 5 } as const

export function seedColor(seed: number): Color {
  return new Color().setHSL(seed, 0.2, 0.5)
}
