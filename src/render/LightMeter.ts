// Measures how bright the exposed frame actually is (median luminance of a
// 32x18 downsample, read back asynchronously so the GPU never stalls). The
// renderer uses it at night to stop the eye down in very bright spots (a
// crossing full of headlights and screens) the way a real eye or camera does.
import { ShaderMaterial, UnsignedByteType, WebGLRenderTarget, type WebGLRenderer, type Texture } from 'three'
import { Pass } from 'postprocessing'

const W = 32
const H = 18

export class LightMeter extends Pass {
  /** Median exposed luminance of the last reading (-1 until the first). */
  median = -1
  private target = new WebGLRenderTarget(W, H, { type: UnsignedByteType, depthBuffer: false })
  private buf = new Uint8Array(W * H * 4)
  private busy = false
  private frame = 0
  private mat = new ShaderMaterial({
    uniforms: { tMap: { value: null as Texture | null } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
    `,
    // Luminance, compressed L/(1+L) so it fits a byte.
    fragmentShader: /* glsl */ `
      uniform sampler2D tMap;
      varying vec2 vUv;
      void main() {
        float l = dot(texture2D(tMap, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
        l = max(l, 0.0);
        gl_FragColor = vec4(vec3(l / (1.0 + l)), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  })

  constructor() {
    super('LightMeter')
    this.needsSwap = false
    this.fullscreenMaterial = this.mat
  }

  render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null): void {
    if (!inputBuffer || this.busy || this.frame++ % 15) return
    this.mat.uniforms.tMap.value = inputBuffer.texture
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    this.busy = true
    renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, W, H, this.buf)
      .then(() => {
        const v: number[] = []
        for (let i = 0; i < this.buf.length; i += 4) {
          const c = Math.min(this.buf[i] / 255, 0.995)
          v.push(c / (1 - c))
        }
        v.sort((a, b) => a - b)
        this.median = v[v.length >> 1]
      })
      .catch(() => {})
      .finally(() => (this.busy = false))
  }
}
