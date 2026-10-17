import { Vector3 } from 'three'
import { WorldFrame } from '../core/frame'
import { GameClock } from '../core/clock'
import { RenderPipeline } from '../render/Renderer'
import { TerrainManager } from '../world/terrain/TerrainManager'
import { updateWater } from '../render/water'
import { pendingRequests } from '../core/net'
import { PlateauManager } from '../world/plateau/PlateauManager'
import { buildingUniforms, nightFactorFromSun } from '../render/materials/building'

export interface StartParams {
  lat: number
  lon: number
  date?: Date
  heading?: number
  pitch?: number
  altitude?: number
}

function readParams(): StartParams {
  const q = new URLSearchParams(location.search)
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
  return {
    lat: num('lat', 35.65952),
    lon: num('lon', 139.70057),
    date: q.has('t') ? new Date(q.get('t')!) : undefined,
    heading: num('heading', 0),
    pitch: num('pitch', -5),
    altitude: num('alt', 1.7),
  }
}

export class Game {
  readonly params = readParams()
  readonly world = new WorldFrame(this.params.lat, this.params.lon)
  readonly clock = new GameClock(this.params.date)
  readonly pipeline: RenderPipeline
  readonly terrain: TerrainManager
  readonly plateau: PlateauManager
  private last = performance.now()
  private elapsed = 0
  fps = 0
  private fpsAcc = 0
  private fpsFrames = 0

  constructor(
    canvas: HTMLCanvasElement,
    readonly ui: HTMLDivElement,
  ) {
    this.pipeline = new RenderPipeline(canvas, this.world)
    this.terrain = new TerrainManager(this.world)
    this.pipeline.scene.add(this.terrain.root)
    this.plateau = new PlateauManager(this.world, this.pipeline.camera, this.pipeline.renderer)
    this.pipeline.scene.add(this.plateau.root)
  }

  async start(): Promise<void> {
    await Promise.all([this.pipeline.init(), this.plateau.init()])
    const { lat, lon } = this.params
    await this.terrain.prefetchAround(lat, lon, 300)
    const ground = this.terrain.heightAt(lat, lon)
    const cam = this.pipeline.camera
    cam.position.copy(this.world.worldFromGeodetic(lat, lon, ground + (this.params.altitude ?? 1.7)))
    cam.rotation.order = 'YXZ'
    cam.rotation.y = (-(this.params.heading ?? 0) * Math.PI) / 180
    cam.rotation.x = ((this.params.pitch ?? 0) * Math.PI) / 180
    requestAnimationFrame(this.frame)
  }

  private frame = (t: number): void => {
    requestAnimationFrame(this.frame)
    const dt = Math.min(0.1, (t - this.last) / 1000)
    this.last = t
    this.elapsed += dt
    this.fpsAcc += dt
    this.fpsFrames++
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc
      this.fpsAcc = 0
      this.fpsFrames = 0
    }
    this.clock.tick(dt)
    const cam = this.pipeline.camera
    this.terrain.update(cam.position, t)
    cam.updateMatrixWorld()
    this.plateau.update(cam.position)
    this.pipeline.setDate(this.clock.date)
    this.pipeline.update(dt, cam.position)
    updateWater(this.elapsed)
    buildingUniforms.uNight.value = nightFactorFromSun(this.pipeline.sunElevation())
    buildingUniforms.uTime.value = this.elapsed
    this.pipeline.render(dt)
  }

  /** Debug/test helper. */
  stats(): Record<string, number> {
    return { fps: this.fps, terrainReady: this.terrain.readyCount, terrainVisible: this.terrain.visibleCount, pending: pendingRequests(), settled: Number(this.elapsed > 8 && pendingRequests() === 0) }
  }

  focus(): Vector3 {
    return this.pipeline.camera.position
  }
}
