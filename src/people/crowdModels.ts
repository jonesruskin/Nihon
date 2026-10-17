// GPU crowd archetypes: low-poly MakeHuman bakes (scripts/blender/make_crowd.py)
// with their walk/idle cycles stored as vertex-animation textures. One
// InstancedMesh per archetype draws hundreds of people in a single call; the
// vertex shader picks and blends animation frames per instance.
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  NearestFilter,
  RGBADepthPacking,
  RGBAFormat,
  Sphere,
  Vector3,
  type IUniform,
} from 'three'

export interface CrowdArchetype {
  name: string
  gender: 'm' | 'f'
  age: number
  geometry: BufferGeometry
  vat: DataTexture
  frames: Record<string, [number, number]>
}

const BASE = `${import.meta.env.BASE_URL}models/crowd/`

export async function loadCrowdArchetypes(): Promise<CrowdArchetype[]> {
  const manifest: { name: string; gender: 'm' | 'f'; age: number }[] = await (await fetch(`${BASE}manifest.json`)).json()
  return Promise.all(
    manifest.map(async (m) => {
      let buf: ArrayBuffer | null = null
      for (let i = 0; i < 3 && !buf; i++) {
        try {
          buf = await (await fetch(`${BASE}${m.name}.bin`)).arrayBuffer()
        } catch (e) {
          if (i === 2) throw e
          await new Promise((r) => setTimeout(r, 500 * (i + 1)))
        }
      }
      if (!buf) throw new Error(`crowd model ${m.name} failed`)
      return { ...m, ...parse(buf) }
    }),
  )
}

function parse(buf: ArrayBuffer): Omit<CrowdArchetype, 'name' | 'gender' | 'age'> {
  const dv = new DataView(buf)
  const hl = dv.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl))) as {
    verts: number
    indices: number
    frames: Record<string, [number, number]>
    min: number[]
    max: number[]
  }
  let off = 4 + hl
  off = (off + 3) & ~3
  const index = new Uint16Array(buf.slice(off, off + header.indices * 2))
  off += header.indices * 2
  off = (off + 3) & ~3
  const nV = header.verts
  const colors = new Uint8Array(buf.slice(off, off + nV * 4))
  off += nV * 4
  const nF = Object.values(header.frames).reduce((a, [s, c]) => Math.max(a, s + c), 0)
  const raw = new Int16Array(buf.slice(off, off + nF * nV * 8))
  const { min, max } = header
  const data = new Float32Array(nF * nV * 4)
  for (let i = 0; i < nF * nV; i++) {
    for (let k = 0; k < 3; k++) data[i * 4 + k] = min[k] + ((raw[i * 4 + k] + 32768) / 65535) * (max[k] - min[k])
    data[i * 4 + 3] = raw[i * 4 + 3] + 32768 // packed octahedral normal (0..65535)
  }
  const vat = new DataTexture(data, nV, nF, RGBAFormat, FloatType)
  vat.minFilter = vat.magFilter = NearestFilter
  vat.needsUpdate = true

  const g = new BufferGeometry()
  g.setIndex(new BufferAttribute(index, 1))
  // Frame 0 as rest position (bounds, and a sane fallback).
  const pos = new Float32Array(nV * 3)
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = data[i * 4 + k]
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nV * 3).fill(0.5), 3))
  // Baked as sRGB bytes; three expects linear vertex colours.
  // Alpha marks clothing, which each person re-tints.
  const lin = new Float32Array(nV * 4)
  for (let i = 0; i < nV; i++) {
    for (let k = 0; k < 3; k++) {
      const c = colors[i * 4 + k] / 255
      lin[i * 4 + k] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    lin[i * 4 + 3] = colors[i * 4 + 3] / 255
  }
  g.setAttribute('color', new BufferAttribute(lin, 4))
  return { geometry: g, vat, frames: header.frames }
}

export const crowdTime: IUniform<number> = { value: 0 }

const vatHead = /* glsl */ `
uniform sampler2D uVat;
uniform float uTime;
attribute vec4 aAnim; // clip start frame, clip frames, phase (0..1), cycles per second
attribute vec4 aTint; // top colour (rgb) and how strongly to apply it
attribute vec4 aTint2; // bottoms colour (rgb), shoe darkness
vec3 octDecode(float p) {
  float x = floor(p / 256.0) / 255.0 * 2.0 - 1.0;
  float y = mod(p, 256.0) / 255.0 * 2.0 - 1.0;
  vec3 n = vec3(x, y, 1.0 - abs(x) - abs(y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return normalize(n);
}
`

const vatFetch = /* glsl */ `
  float vatF = fract(uTime * aAnim.w + aAnim.z) * aAnim.y;
  int vf0 = int(aAnim.x) + int(floor(vatF));
  int vf1 = int(aAnim.x) + int(mod(floor(vatF) + 1.0, aAnim.y));
  float vatT = fract(vatF);
  vec4 vatA = texelFetch(uVat, ivec2(gl_VertexID, vf0), 0);
  vec4 vatB = texelFetch(uVat, ivec2(gl_VertexID, vf1), 0);
`

function patch(shader: { uniforms: Record<string, IUniform>; vertexShader: string }, vat: DataTexture, normals: boolean): void {
  shader.uniforms.uVat = { value: vat }
  shader.uniforms.uTime = crowdTime
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vatHead}`)
  if (normals) {
    // Re-tint clothing per person, keeping the fabric's shading detail.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
      float cloth = color.a;
      float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      float hy = position.y;
      vec3 tc = hy > 0.97 ? aTint.rgb : (hy > 0.11 ? aTint2.rgb : vec3(aTint2.w));
      vColor.rgb = mix(color.rgb, tc * (0.35 + 1.6 * lum), cloth * aTint.w);
      vColor.a = 1.0;`,
    )
  }
  if (normals)
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `${vatFetch}\nvec3 objectNormal = normalize(mix(octDecode(vatA.w), octDecode(vatB.w), vatT));\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif`,
    )
  else shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `${vatFetch}\n#include <begin_vertex>`)
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed = mix(vatA.xyz, vatB.xyz, vatT);`)
}

/** One instanced draw for up to `capacity` people of an archetype. */
export function createCrowdMesh(a: CrowdArchetype, capacity: number): InstancedMesh {
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 })
  mat.customProgramCacheKey = () => 'nihon-crowd-v1'
  mat.onBeforeCompile = (s) => patch(s, a.vat, true)
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
  depth.onBeforeCompile = (s) => patch(s, a.vat, false)
  depth.customProgramCacheKey = () => 'nihon-crowd-depth-v1'
  const g = a.geometry.clone()
  g.setAttribute('aAnim', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
  g.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
  g.setAttribute('aTint2', new InstancedBufferAttribute(new Float32Array(capacity * 4), 4))
  const mesh = new InstancedMesh(g, mat, capacity)
  mesh.customDepthMaterial = depth
  mesh.count = 0
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  g.boundingSphere = new Sphere(new Vector3(), 1e5)
  return mesh
}
