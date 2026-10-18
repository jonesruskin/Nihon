// Rain and snow around the camera. Particles live in a box that wraps around
// the viewer (so they never run out), fall with the wind, and are drawn as
// camera-facing streaks (rain) or soft flakes (snow) in a single draw call.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Vector3,
  type IUniform,
} from 'three'

const BOX = new Vector3(44, 26, 44)

function particles(n: number): BufferGeometry {
  const seed = new Float32Array(n * 4 * 4)
  const corner = new Float32Array(n * 4 * 2)
  const idx = new Uint32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()]
    for (let k = 0; k < 4; k++) {
      seed.set(s, (i * 4 + k) * 4)
      corner.set([k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0], (i * 4 + k) * 2)
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 4 * 3), 3))
  g.setAttribute('seed', new BufferAttribute(seed, 4))
  g.setAttribute('corner', new BufferAttribute(corner, 2))
  g.setIndex(new BufferAttribute(idx, 1))
  return g
}

const vertex = /* glsl */ `
  // Wrap the particle into the box around the camera.
  vec3 box = uBox;
  vec3 fall = uVel * uTime;
  vec3 sway = uSnow > 0.5 ? vec3(sin(uTime * 1.3 + seed.w * 40.0), 0.0, cos(uTime * 1.1 + seed.w * 31.0)) * 0.35 : vec3(0.0);
  vec3 p = mod(seed.xyz * box + fall + sway - cameraPosition + box * 0.5, box) + cameraPosition - box * 0.5;
  vec3 dir = normalize(uVel);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam));
  float len = uSnow > 0.5 ? uSize * (0.6 + seed.w) : uLen * (0.7 + 0.6 * seed.w);
  float wid = uSnow > 0.5 ? len : uSize;
  vec3 up = uSnow > 0.5 ? normalize(cross(side, toCam)) : -dir;
  transformed = p + side * (corner.x - 0.5) * wid + up * (corner.y - 0.5) * len;
  vCorner = corner;
`

export class Precipitation {
  readonly mesh: Mesh
  private uniforms: Record<string, IUniform>
  private max: number
  private mat: MeshBasicMaterial

  constructor(max = 12000) {
    this.max = max
    this.uniforms = {
      uTime: { value: 0 },
      uVel: { value: new Vector3(0, -9, 0) },
      uBox: { value: BOX },
      uSnow: { value: 0 },
      uLen: { value: 0.75 },
      uSize: { value: 0.012 },
    }
    this.mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.3, side: DoubleSide })
    this.mat.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, this.uniforms)
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 seed; attribute vec2 corner; uniform float uTime; uniform vec3 uVel; uniform vec3 uBox; uniform float uSnow; uniform float uLen; uniform float uSize; varying vec2 vCorner;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertex}`)
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow; varying vec2 vCorner;')
        .replace(
          '#include <alphamap_fragment>',
          `#include <alphamap_fragment>
          vec2 q = vCorner - 0.5;
          // Rain: bright core fading at the ends; snow: soft round flake.
          diffuseColor.a *= uSnow > 0.5 ? smoothstep(0.5, 0.15, length(q)) : (1.0 - smoothstep(0.1, 0.5, abs(q.x))) * (1.0 - smoothstep(0.2, 0.5, abs(q.y)));`,
        )
    }
    this.mat.customProgramCacheKey = () => 'nihon-precip-v1'
    this.mesh = new Mesh(particles(max), this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
    this.mesh.visible = false
  }

  /**
   * @param rain mm/h, @param snow cm/h, @param wind m/s vector (x,z),
   * @param light 0..1 scene brightness for the drops' sheen.
   */
  update(dt: number, rain: number, snow: number, wind: Vector3, light: number, budget: number): void {
    this.uniforms.uTime.value += dt
    const snowing = snow > rain * 0.5 && snow > 0.02
    const amount = snowing ? Math.min(1, snow / 2.5) : Math.min(1, rain / 8)
    const visible = amount > 0.01
    this.mesh.visible = visible
    if (!visible) return
    const n = Math.round(Math.min(this.max, budget) * (0.15 + 0.85 * amount))
    this.mesh.geometry.setDrawRange(0, n * 6)
    this.uniforms.uSnow.value = snowing ? 1 : 0
    const vel = this.uniforms.uVel.value as Vector3
    if (snowing) {
      vel.set(wind.x * 0.8, -1.1, wind.z * 0.8)
      this.uniforms.uSize.value = 0.045
      this.mat.blending = NormalBlending
      this.mat.color.copy(new Color(1, 1, 1).multiplyScalar(0.25 + 0.9 * light))
      this.mat.opacity = 0.9
    } else {
      vel.set(wind.x, -8.5 - amount * 2, wind.z)
      this.uniforms.uLen.value = 0.7 + amount * 0.6
      this.uniforms.uSize.value = 0.012 + amount * 0.008
      this.mat.blending = AdditiveBlending
      this.mat.color.setRGB(0.6, 0.65, 0.72).multiplyScalar(0.12 + 0.9 * light)
      this.mat.opacity = 0.6
    }
  }
}

/** Round soft texture (kept for umbrellas etc.). */
export function softDot(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const x = c.getContext('2d')!
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  x.fillStyle = g
  x.fillRect(0, 0, 32, 32)
  return new CanvasTexture(c)
}
