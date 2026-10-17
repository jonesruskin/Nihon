// Physically based rendering pipeline:
//   scene (PBR, real sun + sky light) -> volumetric clouds -> aerial
//   perspective (Bruneton precomputed scattering) -> bloom -> AgX -> SMAA.
import {
  CubeCamera,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipMapLinearFilter,
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
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
  type Texture,
  type WebGLRenderTarget,
} from 'three'
import {
  BloomEffect,
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

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra'

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
    this.clouds.events.addEventListener('change', (e) => {
      if (e.property === 'atmosphereOverlay') this.aerial.overlay = this.clouds.atmosphereOverlay
      if (e.property === 'atmosphereShadow') this.aerial.shadow = this.clouds.atmosphereShadow
      if (e.property === 'atmosphereShadowLength') this.aerial.shadowLength = this.clouds.atmosphereShadowLength
    })
    this.aerial = new AerialPerspectiveEffect(this.camera, { sky: true, sun: true, moon: true })
    this.aerial.overlay = this.clouds.atmosphereOverlay
    this.aerial.shadow = this.clouds.atmosphereShadow
    this.aerial.shadowLength = this.clouds.atmosphereShadowLength

    this.bloom = new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.92, luminanceSmoothing: 0.25, mipmapBlur: true })
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
    const debug = new URLSearchParams(location.search)
    if (!debug.has('noclouds')) this.composer.addPass(new EffectPass(this.camera, this.clouds))
    this.composer.addPass(new EffectPass(this.camera, this.aerial))
    this.composer.addPass(new EffectPass(this.camera, this.bloom, this.toneMapping))
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })))

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
    this.clouds.skipRendering = q === 'low'
    this.renderer.shadowMap.enabled = q !== 'low'
    this.sun.shadow.mapSize.setScalar(q === 'ultra' ? 4096 : 2048)
    this.sun.shadow.map?.dispose()
    this.sun.shadow.map = null
    this.resize()
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
    const dim = 1 - this.overcast * 0.85
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
    this.scene.environmentIntensity = 1 - this.overcast * 0.35
  }

  render(dt: number): void {
    this.composer.render(dt)
  }
}
