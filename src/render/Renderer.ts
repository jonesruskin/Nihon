// Physically based rendering pipeline:
//   scene (PBR, real sun + sky light) -> volumetric clouds -> aerial
//   perspective (Bruneton precomputed scattering) -> bloom -> AgX -> SMAA.
import {
  CubeCamera,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipMapLinearFilter,
  Matrix4,
  Mesh,
  NoColorSpace,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RedFormat,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Uniform,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
  type Texture,
  type WebGLRenderTarget,
} from 'three'
import {
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import {
  AerialPerspectiveEffect,
  getMoonDirectionECEF,
  getSunDirectionECEF,
  PrecomputedTexturesGenerator,
  SkyMaterial,
  SunDirectionalLight,
  type PrecomputedTextures,
} from '@takram/three-atmosphere'
import { CloudsEffect, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE, CLOUD_SHAPE_TEXTURE_SIZE } from '@takram/three-clouds'
import { DataTextureLoader, parseUint8Array, STBNLoader } from '@takram/three-geospatial'
import type { WorldFrame } from '../core/frame'
import { NightLights } from './NightLights'

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra'

/** Replaces NaN/Inf (e.g. rare aerial-perspective pixels at night), clamps
 *  fireflies so bloom can never smear them over the whole frame, and adds
 *  the urban sky glow: the orange-grey dome of light pollution over a
 *  Japanese city at night, brighter under cloud, absent in the countryside. */
class SanitizeEffect extends Effect {
  constructor() {
    super(
      'Sanitize',
      `uniform mat4 uInvViewProj;
      uniform vec3 uCamPos;
      uniform vec3 uGlow;
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        bool bad = any(isnan(c)) || any(isinf(c));
        c = bad ? vec3(0.0) : clamp(c, vec3(0.0), vec3(64.0));
        if (depth >= 0.99999 && dot(uGlow, uGlow) > 0.0) {
          vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
          vec3 dir = normalize(w.xyz / w.w - uCamPos);
          float el = max(dir.y, 0.0);
          c += uGlow * (0.25 + 0.75 * exp(-el * 7.0));
        }
        outputColor = vec4(c, 1.0);
      }`,
      {
        attributes: EffectAttribute.DEPTH,
        uniforms: new Map<string, Uniform>([
          ['uInvViewProj', new Uniform(new Matrix4())],
          ['uCamPos', new Uniform(new Vector3())],
          ['uGlow', new Uniform(new Vector3())],
        ]),
      },
    )
  }
}

const ASSET = (p: string) => `${import.meta.env.BASE_URL}takram/${p}`

export class RenderPipeline {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly camera: PerspectiveCamera
  readonly composer: EffectComposer
  readonly aerial: AerialPerspectiveEffect
  readonly clouds: CloudsEffect
  readonly sun: SunDirectionalLight
  readonly sunDirection = new Vector3()
  readonly moonDirection = new Vector3()
  textures: PrecomputedTextures | null = null
  private skyScene = new Scene()
  private skyMaterial = new SkyMaterial()
  private pmrem: PMREMGenerator
  private envTarget: WebGLRenderTarget | null = null
  private cubeTarget = new WebGLCubeRenderTarget(64, { type: HalfFloatType })
  private cubeCamera = new CubeCamera(1, 1e6, this.cubeTarget)
  private envAge = Infinity
  private lastSunDir = new Vector3()
  private bloom: BloomEffect
  private sanitize = new SanitizeEffect()
  readonly lights: NightLights
  /** 0 outdoors .. 1 underground (tunnels, subway): no sun or sky light. */
  indoor = 0
  /** 0 day .. 1 night; set by the game each frame (drives lights + glow). */
  night = 0
  private toneMapping: ToneMappingEffect
  /** 0 = clear, 1 = overcast. Dims direct sun and scales sky light. */
  overcast = 0
  quality: QualityTier = 'high'
  ready = false

  constructor(
    canvas: HTMLCanvasElement,
    private world: WorldFrame,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      depth: false,
      stencil: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap
    this.renderer.toneMappingExposure = 3

    this.camera = new PerspectiveCamera(62, 1, 0.1, 400_000)
    this.scene.add(this.camera)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType, multisampling: 0 })
    this.composer.addPass(new RenderPass(this.scene, this.camera))

    this.clouds = new CloudsEffect(this.camera)
    this.clouds.coverage = 0.35
    this.clouds.qualityPreset = 'medium'
    this.clouds.haze = false
    this.clouds.localWeatherVelocity.set(0.00004, 0)
    this.clouds.events.addEventListener('change', () => this.linkCloudBuffers())
    this.aerial = new AerialPerspectiveEffect(this.camera, { sky: true, sun: true, moon: true })
    this.linkCloudBuffers()

    this.bloom = new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.92, luminanceSmoothing: 0.25, mipmapBlur: true })
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
    const debug = new URLSearchParams(location.search)
    if (!debug.has('noclouds')) this.composer.addPass(new EffectPass(this.camera, this.clouds))
    if (!debug.has('noaerial')) this.composer.addPass(new EffectPass(this.camera, this.aerial))
    this.composer.addPass(new EffectPass(this.camera, this.sanitize))
    this.composer.addPass(debug.has('nobloom') ? new EffectPass(this.camera, this.toneMapping) : new EffectPass(this.camera, this.bloom, this.toneMapping))
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })))

    this.lights = new NightLights(this.scene)
    this.lights.setPoolSize(16)

    this.sun = new SunDirectionalLight({ distance: 600 })
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -90
    sc.right = sc.top = 90
    sc.near = 1
    sc.far = 1400
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    this.scene.add(this.sun, this.sun.target)

    const sky = new Mesh(new PlaneGeometry(2, 2), this.skyMaterial)
    sky.frustumCulled = false
    this.skyMaterial.sun = false
    this.skyMaterial.moon = false
    this.skyScene.add(sky, this.cubeCamera)
    this.pmrem = new PMREMGenerator(this.renderer)

    window.addEventListener('resize', () => this.resize())
    this.resize()
  }

  async init(): Promise<void> {
    const generator = new PrecomputedTexturesGenerator(this.renderer, { higherOrderScattering: true })
    const textures = await generator.update()
    this.textures = textures
    Object.assign(this.aerial, textures)
    Object.assign(this.skyMaterial, textures)
    this.sun.transmittanceTexture = textures.transmittanceTexture
    Object.assign(this.clouds, {
      irradianceTexture: textures.irradianceTexture,
      scatteringTexture: textures.scatteringTexture,
      transmittanceTexture: textures.transmittanceTexture,
      singleMieScatteringTexture: textures.singleMieScatteringTexture ?? null,
      higherOrderScatteringTexture: textures.higherOrderScatteringTexture ?? null,
    })
    await this.loadCloudTextures()
    this.ready = true
  }

  private async loadCloudTextures(): Promise<void> {
    const tex2d = (url: string) =>
      new TextureLoader().loadAsync(url).then((t: Texture) => {
        t.minFilter = LinearMipMapLinearFilter
        t.magFilter = LinearFilter
        t.wrapS = t.wrapT = RepeatWrapping
        t.colorSpace = NoColorSpace
        t.needsUpdate = true
        return t
      })
    const tex3d = (url: string, size: number) =>
      new DataTextureLoader(Data3DTexture, parseUint8Array, {
        width: size,
        height: size,
        depth: size,
        format: RedFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        wrapS: RepeatWrapping,
        wrapT: RepeatWrapping,
        wrapR: RepeatWrapping,
        colorSpace: NoColorSpace,
      }).loadAsync(url)
    const [weather, shape, detail, turbulence, stbn] = await Promise.all([
      tex2d(ASSET('local_weather.png')),
      tex3d(ASSET('shape.bin'), CLOUD_SHAPE_TEXTURE_SIZE),
      tex3d(ASSET('shape_detail.bin'), CLOUD_SHAPE_DETAIL_TEXTURE_SIZE),
      tex2d(ASSET('turbulence.png')),
      new STBNLoader().loadAsync(ASSET('stbn.bin')),
    ])
    this.clouds.localWeatherTexture = weather
    this.clouds.shapeTexture = shape as Data3DTexture
    this.clouds.shapeDetailTexture = detail as Data3DTexture
    this.clouds.turbulenceTexture = turbulence
    this.clouds.stbnTexture = stbn
    this.aerial.stbnTexture = stbn
  }

  setQuality(q: QualityTier): void {
    this.quality = q
    const dpr = window.devicePixelRatio || 1
    const ratio = { low: 0.6, medium: 1, high: Math.min(dpr, 1.5), ultra: Math.min(dpr, 2) }[q]
    this.renderer.setPixelRatio(ratio)
    this.clouds.qualityPreset = q === 'ultra' ? 'high' : q === 'high' ? 'medium' : 'low'
    this.updateCloudSkip()
    this.renderer.shadowMap.enabled = q !== 'low'
    this.lights.setPoolSize({ low: 8, medium: 16, high: 24, ultra: 32 }[q])
    this.sun.shadow.mapSize.setScalar(q === 'ultra' ? 4096 : 2048)
    this.sun.shadow.map?.dispose()
    this.sun.shadow.map = null
    this.resize()
  }

  /** Feed the cloud overlay / shadow buffers into the aerial perspective only
   *  while clouds really render: skipped clouds leave those render targets
   *  uninitialised (NaN in half-float), which blacks out the whole frame. */
  private linkCloudBuffers(): void {
    const on = !this.clouds.skipRendering && !this.noClouds
    this.aerial.overlay = on ? this.clouds.atmosphereOverlay : null
    this.aerial.shadow = on ? this.clouds.atmosphereShadow : null
    this.aerial.shadowLength = on ? this.clouds.atmosphereShadowLength : null
  }

  private noClouds = new URLSearchParams(location.search).has('noclouds')

  /** Clouds are skipped on the low tier, and after dark: the cloud march
   *  produces NaNs once the sun is below the horizon. */
  private updateCloudSkip(): void {
    const skip = this.quality === 'low' || (this.textures !== null && this.sunElevation() < -2)
    if (this.clouds.skipRendering !== skip) {
      this.clouds.skipRendering = skip
      this.linkCloudBuffers()
    }
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h, false)
  }

  /** Update celestial state for a real date (the sun is where it really is). */
  setDate(date: Date): void {
    getSunDirectionECEF(date, this.sunDirection)
    getMoonDirectionECEF(date, this.moonDirection)
  }

  /** Sun elevation above the local horizon in degrees at the world origin. */
  sunElevation(): number {
    const up = new Vector3().setFromMatrixColumn(this.world.worldToECEF, 1)
    return (Math.asin(Math.max(-1, Math.min(1, up.dot(this.sunDirection)))) * 180) / Math.PI
  }

  update(dt: number, focus: Vector3): void {
    const w2e = this.world.worldToECEF
    for (const t of [this.aerial, this.clouds, this.skyMaterial, this.sun]) t.worldToECEFMatrix.copy(w2e)
    this.aerial.sunDirection.copy(this.sunDirection)
    this.aerial.moonDirection.copy(this.moonDirection)
    this.clouds.sunDirection.copy(this.sunDirection)
    this.skyMaterial.sunDirection.copy(this.sunDirection)
    this.skyMaterial.moonDirection.copy(this.moonDirection)
    this.sun.sunDirection.copy(this.sunDirection)

    // Keep the shadow frustum centred on what the player sees, snapped to
    // texels to avoid shimmering.
    const step = 180 / this.sun.shadow.mapSize.x
    this.sun.target.position.set(
      Math.round(focus.x / step) * step,
      Math.round(focus.y / step) * step,
      Math.round(focus.z / step) * step,
    )
    this.sun.update()
    const dim = (1 - this.overcast * 0.85) * (1 - this.indoor)
    this.sun.intensity = dim
    this.sun.castShadow = this.overcast < 0.85 && this.sunElevation() > -2

    this.envAge += dt
    if (this.textures && (this.envAge > 4 || this.lastSunDir.angleTo(this.sunDirection) > 0.01)) {
      this.envAge = 0
      this.lastSunDir.copy(this.sunDirection)
      this.cubeCamera.position.copy(focus)
      this.cubeCamera.update(this.renderer, this.skyScene)
      this.envTarget?.dispose()
      this.envTarget = this.pmrem.fromCubemap(this.cubeTarget.texture)
      this.scene.environment = this.envTarget.texture
    }
    this.scene.environmentIntensity = (1 - this.overcast * 0.35) * (1 - 0.92 * this.indoor)
    // Eye adaptation: the visual system opens up at dusk and night.
    const el = this.sunElevation()
    const outdoor = el > 8 ? 3 : el > -6 ? 3 + ((8 - el) / 14) * 3 : 6 + Math.min(4, (-6 - el) / 6)
    const target = outdoor + (Math.max(outdoor, 5) - outdoor) * this.indoor
    this.exposure += (target * (1 + this.overcast * 0.4) - this.exposure) * Math.min(1, dt * 0.8)
    // Bloom acts on scene radiance; only what would clip after exposure blooms.
    this.bloom.luminanceMaterial.threshold = 2.6 / this.exposure
    this.bloom.intensity = 0.55 - 0.25 * this.night
    this.renderer.toneMappingExposure = this.exposure

    this.updateCloudSkip()
    this.lights.update(dt, this.camera.position, this.night)
    // Sky glow in scene radiance (exposure is applied later): sodium/LED mix,
    // ~3x brighter when low cloud reflects the city back down.
    const g = this.night * (0.15 + 0.85 * this.lights.urban) * 0.0035 * (1 + this.overcast * 2.5)
    const su = this.sanitize.uniforms
    ;(su.get('uGlow')!.value as Vector3).set(g * 1.0, g * 0.78, g * 0.6)
    ;(su.get('uCamPos')!.value as Vector3).copy(this.camera.position)
    ;(su.get('uInvViewProj')!.value as Matrix4).multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse)
  }

  private exposure = 3

  private debugNoPost = new URLSearchParams(location.search).has('nopost')

  render(dt: number): void {
    if (this.debugNoPost) {
      this.renderer.toneMapping = 7 // AgX
      this.renderer.render(this.scene, this.camera)
      return
    }
    this.composer.render(dt)
  }
}
