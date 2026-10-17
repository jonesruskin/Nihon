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
flat varying float vFh;
float bhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bhash1(float p) { return fract(sin(p * 91.345) * 47453.5453); }
`

const vertexHead = /* glsl */ `
attribute float bh;
attribute float seed;
attribute float kind;
attribute float fh;
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
        vKind = kind;
        vFh = fh;`,
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
  bool house = kind == 1.0;
  bool glassTower = kind == 3.0;
  bool industrial = kind == 4.0;
  bool wood = kind == 5.0;
  bool apartment = kind == 6.0;
  bool commercial = kind == 7.0;

  float floorH = vFh > 0.0 ? vFh : (house ? 2.9 : (glassTower ? 4.0 : (apartment ? 2.95 : mix(3.2, 3.9, bhash1(s * 3.1)))));
  float bay = house ? mix(2.6, 3.6, bhash1(s * 5.7)) : (glassTower ? 1.5 : (apartment ? mix(5.5, 7.0, bhash1(s * 7.3)) : mix(1.8, 3.4, bhash1(s * 7.3))));
  float fl = floor(v / floorH);
  float fy = fract(v / floorH);
  float bx = floor(u / bay);
  float fx = fract(u / bay);

  vec3 wall = palette(bhash1(s * 11.7), kind);
  // Low-frequency weathering: rain streaks under windows, dirt near street.
  float streak = bhash(vec2(floor(u * 1.5), floor(v * 0.2))) * 0.05;
  wall *= 1.0 - streak - 0.08 * smoothstep(3.0, 0.0, v);

  float winW = house ? 0.42 : (glassTower ? 0.9 : mix(0.45, 0.75, bhash1(s * 13.1)));
  float winH = house ? 0.45 : (glassTower ? 0.82 : mix(0.45, 0.65, bhash1(s * 17.9)));
  float wx = abs(fx - 0.5) * 2.0;
  float wy = abs(fy - 0.55) * 2.0;
  float isWin = (1.0 - aastep(winW, wx)) * (1.0 - aastep(winH, wy));
  if (house) isWin *= step(0.35, bhash(vec2(bx, fl) + s));
  bool shop = (commercial || (!house && !glassTower && !industrial && !apartment && !wood && bhash1(s * 23.0) > 0.25)) && v < 4.2;
  if (shop) { isWin = (1.0 - aastep(0.92, abs(fx - 0.5) * 2.0)) * aastep(0.08, v) * (1.0 - aastep(3.3, v)); }
  if (industrial) isWin *= aastep(0.6, fy) * (1.0 - aastep(0.85, fy)) * step(0.5, bhash1(bx + s));
  float band = (!house && !glassTower && !apartment) ? aastep(0.9, fy) * 0.12 : 0.0;

  // Glass shows a mix of sky reflection and interiors.
  float pane = bhash(vec2(bx * 3.7 + s * 50.0, fl * 1.3 + s * 20.0));
  vec3 interior = mix(vec3(0.10, 0.11, 0.12), vec3(0.42, 0.40, 0.36), step(0.62, pane) * fract(pane * 13.0));
  vec3 glass = mix(vec3(0.13, 0.16, 0.19), interior, 0.55);
  if (glassTower) {
    glass = mix(vec3(0.16, 0.22, 0.27), vec3(0.24, 0.28, 0.31), bhash1(s * 29.0));
    wall = mix(vec3(0.30, 0.32, 0.34), vec3(0.55, 0.56, 0.58), bhash1(s * 31.0));
  }
  vec3 albedo = mix(wall * (1.0 - band), glass, isWin);
  float rough = mix(mix(0.82, 0.35, uWet), 0.04, isWin);
  float metal = isWin * (glassTower ? 0.55 : 0.3);
  vec3 emis = vec3(0.0);

  // マンション: continuous balconies with slab edges, frosted railing panels,
  // sliding glass doors behind, unit partitions and the odd AC unit.
  if (apartment && v > 3.0) {
    float slab = 1.0 - aastep(0.07, fy);
    float rail = aastep(0.07, fy) * (1.0 - aastep(0.4, fy));
    float door = aastep(0.45, fy) * (1.0 - aastep(0.93, fy)) * (1.0 - aastep(0.84, wx));
    float part = 1.0 - aastep(0.025, min(fx, 1.0 - fx));
    vec3 slabC = vec3(0.78, 0.77, 0.74);
    vec3 railC = mix(vec3(0.62, 0.64, 0.66), vec3(0.72, 0.70, 0.66), bhash1(s * 41.0));
    float curtain = step(0.45, pane);
    vec3 doorC = mix(vec3(0.12, 0.14, 0.16), mix(vec3(0.55, 0.52, 0.46), vec3(0.42, 0.45, 0.5), fract(pane * 7.0)), curtain * 0.6);
    // AC outdoor unit on some balconies
    float ac = step(0.6, bhash(vec2(bx, fl) + s * 3.0)) * aastep(0.12, fx) * (1.0 - aastep(0.27, fx)) * aastep(0.4, fy) * (1.0 - aastep(0.62, fy));
    albedo = wall;
    albedo = mix(albedo, doorC, door);
    albedo = mix(albedo, railC, rail);
    albedo = mix(albedo, vec3(0.86, 0.86, 0.84), ac);
    albedo = mix(albedo, slabC, max(slab, part));
    rough = mix(0.8, 0.08, door);
    metal = door * 0.25;
    isWin = door;
  }

  // 雑居ビル signage: vertical kanban near one edge and sign bands per
  // floor — the visual signature of Shinjuku, Shibuya, Dotonbori.
  if (commercial && v > 3.6) {
    float signRow = step(0.55, bhash(vec2(fl, s * 9.0)));
    float bandSign = signRow * aastep(0.02, fy) * (1.0 - aastep(0.28, fy));
    float edge = aastep(0.0, fx) * (1.0 - aastep(0.18, fx)) * step(0.5, bhash1(bx * 0.37 + s * 5.0));
    float hue = bhash(vec2(bx, fl) + s * 13.0);
    vec3 signC = hue < 0.25 ? vec3(0.85, 0.12, 0.10) : hue < 0.45 ? vec3(0.95, 0.75, 0.12) : hue < 0.6 ? vec3(0.12, 0.35, 0.8) : hue < 0.75 ? vec3(0.95, 0.95, 0.92) : hue < 0.88 ? vec3(0.1, 0.55, 0.3) : vec3(0.85, 0.3, 0.6);
    float sign = max(bandSign, edge * step(fy, 0.92));
    // faux characters: blocky glyph texture inside signs
    vec2 gp = vec2(u * 2.2, v * 2.2);
    float glyph = step(0.55, bhash(floor(gp))) * step(0.15, fract(gp.x)) * step(0.15, fract(gp.y));
    vec3 signFace = mix(signC, vec3(1.0) - signC * 0.7, glyph * 0.8);
    albedo = mix(albedo, signFace, sign);
    rough = mix(rough, 0.4, sign);
    emis += signFace * sign * mix(0.06, 0.5, uNight);
  }

  // Temples & shrines: dark timber, white plaster panels, no glass.
  if (wood) {
    float post = 1.0 - aastep(0.08, min(fx, 1.0 - fx));
    float beam = 1.0 - aastep(0.06, abs(fy - 0.1)) + (1.0 - aastep(0.04, abs(fy - 0.85)));
    vec3 timber = vec3(0.24, 0.15, 0.10);
    vec3 plaster = vec3(0.82, 0.80, 0.74);
    albedo = mix(plaster, timber, clamp(post + beam, 0.0, 1.0));
    if (v < 1.0) albedo = vec3(0.45, 0.43, 0.40);
    rough = 0.85;
    metal = 0.0;
    isWin = 0.0;
  }

  // Far away the pattern is sub-pixel: fade to its average to avoid moire.
  float fw = max(fwidth(u / bay), fwidth(v / floorH));
  float far = smoothstep(0.2, 0.55, fw);
  o.albedo = mix(albedo, mix(wall, glass, winW * winH * (house ? 0.6 : 1.0)) * (wood ? 0.6 : 1.0), far * (apartment || commercial || wood ? 0.6 : 1.0));
  o.roughness = rough;
  o.metalness = metal;

  // Night: a believable fraction of windows lit, warm or fluorescent white.
  if (uNight > 0.01) {
    float h = bhash(vec2(bx * 1.7 + s * 91.0, fl * 3.1 + s * 13.0));
    float occupancy = house ? 0.45 : (apartment ? 0.6 : (glassTower ? 0.55 : 0.5));
    float lit = step(h, occupancy) * isWin;
    vec3 warm = vec3(1.0, 0.72, 0.42);
    vec3 cool = vec3(0.85, 0.92, 1.0);
    vec3 col = mix(warm, cool, step(apartment ? 0.7 : 0.5, bhash1(h * 7.0 + s)));
    float intensity = mix(0.02, 0.09, bhash1(h * 3.0));
    // Inside each window: ceiling light falls off downward, half-drawn
    // curtains or blinds, and the occasional blue TV flicker.
    float wyIn = clamp((fy - 0.55) / max(winH, 0.05) + 0.5, 0.0, 1.0);
    float ceiling = 0.55 + 0.45 * wyIn;
    float r2 = bhash1(h * 17.0);
    float curtainX = r2 < 0.35 ? step(0.5 + 0.4 * (r2 / 0.35 - 0.5), abs(fx - 0.5) * 2.0) : 0.0;
    float blinds = r2 > 0.8 ? 0.6 + 0.4 * step(0.5, fract(fy * 40.0)) : 1.0;
    float shade = mix(1.0, 0.35, curtainX) * blinds * ceiling;
    if (r2 > 0.72 && r2 < 0.8) { col = vec3(0.45, 0.6, 1.0); intensity *= 0.5 + 0.3 * sin(uTime * 3.0 + h * 50.0); }
    intensity *= shade;
    emis += col * lit * intensity * uNight;
  }
  o.emissive = emis;
  return o;
}
`

export function nightFactorFromSun(sunElevationDeg: number): number {
  // Lights come on through civil twilight.
  return Math.min(1, Math.max(0, (2 - sunElevationDeg) / 8))
}

export const BUILDING_KIND = { generic: 0, house: 1, office: 2, glass: 3, industrial: 4, wood: 5, apartment: 6, commercial: 7 } as const

export function seedColor(seed: number): Color {
  return new Color().setHSL(seed, 0.2, 0.5)
}
