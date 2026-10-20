// Shader lamps: the night's street lamps, 防犯灯, vending machines and car
// headlights as a small data texture read by every lit material, instead of
// three.js SpotLights. Real lights are paid for by every pixel of every lit
// material whether they are on or not (24 of them cost a third of a daytime
// frame); a lamp here is skipped by a uniform loop bound that is 0 by day,
// and at night by a distance test before any shading happens.
//
// The GLSL is spliced into three's light chunks once, globally; the uniform
// objects are attached to each program through a Material.onBeforeCompile
// accessor, so materials with their own onBeforeCompile need no changes.
import { DataTexture, FloatType, Material, NearestFilter, RGBAFormat, ShaderChunk, type WebGLProgramParametersWithUniforms } from 'three'

export const MAX_LAMPS = 48

/**
 * View-space lamp data, rewritten every frame by NightLights: three texels
 * per lamp in a float texture (a uniform array this size would overrun the
 * fragment uniform budget of some mobile GPUs).
 *   0: xyz position, w range (m)
 *   1: rgb colour x intensity (candela), w cos(outer cone) (-2 = omnidirectional)
 *   2: xyz beam direction, w cos(inner cone)
 */
export const lampData = new Float32Array(MAX_LAMPS * 3 * 4)
const lampTexture = new DataTexture(lampData, MAX_LAMPS * 3, 1, RGBAFormat, FloatType)
lampTexture.minFilter = lampTexture.magFilter = NearestFilter
lampTexture.generateMipmaps = false

export const lampUniforms = {
  uLampTex: { value: lampTexture },
  uLampCount: { value: 0 },
}

/** Upload after writing lampData. */
export function commitLamps(count: number): void {
  lampUniforms.uLampCount.value = count
  if (count > 0) lampTexture.needsUpdate = true
}

const PARS = /* glsl */ `
uniform highp sampler2D uLampTex;
uniform int uLampCount;
`

const LOOP = /* glsl */ `
for (int li = 0; li < ${MAX_LAMPS}; li++) {
  if (li >= uLampCount) break;
  vec4 lampP = texelFetch(uLampTex, ivec2(li * 3, 0), 0);
  vec3 lv = lampP.xyz - geometryPosition;
  float d2 = dot(lv, lv);
  float range = lampP.w;
  if (d2 > range * range) continue;
  float ld = sqrt(d2);
  IncidentLight lampLight;
  lampLight.direction = lv / ld;
  // Inverse square with a smooth window to zero at the range.
  float win = clamp(1.0 - pow(ld / range, 4.0), 0.0, 1.0);
  float att = win * win / max(d2, 0.25);
  vec4 lampC = texelFetch(uLampTex, ivec2(li * 3 + 1, 0), 0);
  vec4 lampD = texelFetch(uLampTex, ivec2(li * 3 + 2, 0), 0);
  float cone = lampC.w < -1.5 ? 1.0 : smoothstep(lampC.w, lampD.w, dot(-lampLight.direction, lampD.xyz));
  lampLight.color = lampC.rgb * (att * cone);
  lampLight.visible = cone > 0.0;
  if (lampLight.visible) RE_Direct(lampLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}
`

let installed = false

/** Splice the lamp loop into three's lighting; call before anything compiles. */
export function installLamps(): void {
  if (installed) return
  installed = true
  ShaderChunk.lights_pars_begin += PARS
  ShaderChunk.lights_fragment_begin += LOOP

  // Every lit program needs the shared uniform objects. Intercept
  // onBeforeCompile on all materials: whatever a material sets runs first.
  const proto = Material.prototype as unknown as Record<string, unknown>
  const noop = proto.onBeforeCompile as (s: WebGLProgramParametersWithUniforms, r: unknown) => void
  const wrapped = new WeakMap<object, (s: WebGLProgramParametersWithUniforms, r: unknown) => void>()
  const attach = (s: WebGLProgramParametersWithUniforms) => {
    if (s.fragmentShader.includes('lights_fragment_begin')) Object.assign(s.uniforms, lampUniforms)
  }
  const plain = (s: WebGLProgramParametersWithUniforms) => attach(s)
  plain.toString = () => noop.toString()
  Object.defineProperty(Material.prototype, 'onBeforeCompile', {
    configurable: true,
    get(this: object) {
      return wrapped.get(this) ?? plain
    },
    set(this: object, fn: (s: WebGLProgramParametersWithUniforms, r: unknown) => void) {
      const w = (s: WebGLProgramParametersWithUniforms, r: unknown) => {
        fn.call(this, s, r)
        attach(s)
      }
      // Program caching keys on onBeforeCompile.toString(): keep the material's own.
      w.toString = () => fn.toString()
      wrapped.set(this, w)
    },
  })
}
