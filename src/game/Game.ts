// NIHON game orchestrator: boots the world at a real place in Japan, streams
// it in around the player, and runs the frame loop.
import { Raycaster, Vector3, type Mesh } from 'three'
import { WorldFrame } from '../core/frame'
import { GameClock } from '../core/clock'
import { pendingRequests } from '../core/net'
import { approxDistanceMeters } from '../core/geo'
import { RenderPipeline, type QualityTier } from '../render/Renderer'
import { updateWater } from '../render/water'
import { buildingUniforms, nightFactorFromSun } from '../render/materials/building'
import { TerrainManager, GRID_INDICES } from '../world/terrain/TerrainManager'
import { PlateauManager } from '../world/plateau/PlateauManager'
import { VectorManager } from '../world/vector/VectorManager'
import type { Place } from '../world/vector/build'
import { Physics } from '../physics/Physics'
import { WorldColliders } from '../physics/WorldColliders'
import { Input } from '../player/Input'
import { Player } from '../player/Player'
import { CameraRig } from '../player/CameraRig'
import { CharacterLibrary, type Person } from '../people/CharacterLibrary'
import { Hud } from '../ui/Hud'

export interface StartParams {
  lat: number
  lon: number
  date?: Date
  heading: number
  pitch: number
  altitude: number
  quality: QualityTier
  mode: Mode
  character: string
}

export type Mode = 'loading' | 'onfoot' | 'fly'

function readParams(): StartParams {
  const q = new URLSearchParams(location.search)
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
  const altitude = num('alt', 0)
  return {
    // Default: the Shibuya Scramble Crossing.
    lat: num('lat', 35.65947),
    lon: num('lon', 139.70057),
    date: q.has('t') ? new Date(q.get('t')!) : undefined,
    heading: num('heading', 300),
    pitch: num('pitch', -5),
    altitude,
    quality: (q.get('quality') as QualityTier) ?? 'high',
    mode: q.get('mode') === 'fly' || altitude > 3 ? 'fly' : 'onfoot',
    character: q.get('char') ?? 'player_m',
  }
}

const REBASE_DISTANCE = 2500

export class Game {
  readonly params = readParams()
  readonly world = new WorldFrame(this.params.lat, this.params.lon)
  readonly clock = new GameClock(this.params.date)
  readonly pipeline: RenderPipeline
  readonly terrain: TerrainManager
  readonly plateau: PlateauManager
  readonly vector: VectorManager
  readonly physics = new Physics()
  readonly colliders: WorldColliders
  readonly input: Input
  readonly player: Player
  readonly rig: CameraRig
  readonly characters = new CharacterLibrary()
  readonly hud: Hud
  avatar: Person | null = null
  mode: Mode = 'loading'
  private last = performance.now()
  private elapsed = 0
  fps = 0
  private fpsAcc = 0
  private fpsFrames = 0
  private places: Place[] = []
  private currentPlace = ''
  private placeTimer = 0

  constructor(
    canvas: HTMLCanvasElement,
    readonly ui: HTMLDivElement,
  ) {
    this.hud = new Hud(ui)
    this.pipeline = new RenderPipeline(canvas, this.world)
    this.terrain = new TerrainManager(this.world)
    this.plateau = new PlateauManager(this.world, this.pipeline.camera, this.pipeline.renderer)
    this.vector = new VectorManager(this.world, this.terrain, this.plateau)
    this.colliders = new WorldColliders(this.physics)
    this.input = new Input(canvas)
    this.player = new Player(this.physics)
    this.rig = new CameraRig(this.pipeline.camera, this.physics)
    const scene = this.pipeline.scene
    scene.add(this.terrain.root, this.plateau.root, this.vector.root, this.player.object)
    this.wireColliders()
    this.world.onRebase((delta) => {
      this.pipeline.scene.updateMatrixWorld(true)
      this.physics.syncStatics()
      if (this.player.body) this.player.rebase(delta)
      this.pipeline.camera.position.applyMatrix4(delta)
      this.rig.snap()
    })
  }

  private wireColliders(): void {
    this.terrain.onDetailTile = (key, group, grid) => {
      this.colliders.addRaw(`t:${key}`, group, grid.positions, GRID_INDICES, 200)
    }
    this.terrain.onTileDisposed = (key) => this.colliders.remove(`t:${key}`)
    this.vector.onTile = ({ build, group }) => {
      const key = `v:${build.id.z}/${build.id.x}/${build.id.y}`
      this.colliders.removePrefix(key + ':')
      for (const child of group.children) {
        const m = child as Mesh
        if (!m.isMesh || (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) continue
        if (['buildings', 'roads', 'structures', 'roofs'].includes(m.name)) this.colliders.addMesh(`${key}:${m.name}`, m)
      }
      const cyl: Array<[number, number, number, number, number]> = []
      const I = build.instances
      for (let i = 0; i < I.pole.length; i += 6) cyl.push([I.pole[i], I.pole[i + 1], I.pole[i + 2], 6, 0.2])
      for (let i = 0; i < I.light.length; i += 6) cyl.push([I.light[i], I.light[i + 1], I.light[i + 2], 4, 0.12])
      for (let i = 0; i < I.signal.length; i += 6) cyl.push([I.signal[i], I.signal[i + 1], I.signal[i + 2], 3, 0.14])
      for (let i = 0; i < I.vending.length; i += 6) cyl.push([I.vending[i], I.vending[i + 1], I.vending[i + 2], 0.92, 0.5])
      for (let i = 0; i < I.pillar.length; i += 6) cyl.push([I.pillar[i], I.pillar[i + 1], I.pillar[i + 2], I.pillar[i + 4] / 2, 1.3])
      this.colliders.addCylinders(`${key}:props`, group, cyl, 1500)
      this.places.push(...build.places)
    }
    this.vector.onTileRemoved = (key) => this.colliders.removePrefix(`v:${key}`)
    this.plateau.onModel = (key, mesh) => this.colliders.addMesh(`p:${key}`, mesh)
    this.plateau.onModelDisposed = (key) => this.colliders.removePrefix(`p:${key}`)
  }

  async start(): Promise<void> {
    const p = this.params
    this.hud.setLoading(0.05, 'Precomputing the sky over Japan…')
    this.applyQuality(p.quality)
    await Promise.all([this.pipeline.init(), this.plateau.init(), this.physics.init(), this.characters.init()])
    this.hud.setLoading(0.2, 'Reading the terrain (国土地理院)…')
    await this.terrain.prefetchAround(p.lat, p.lon, 300)
    const ground = this.terrain.heightAt(p.lat, p.lon)
    const cam = this.pipeline.camera
    cam.position.copy(this.world.worldFromGeodetic(p.lat, p.lon, ground + Math.max(1.7, p.altitude)))
    this.rig.yaw = (-p.heading * Math.PI) / 180
    this.rig.pitch = (p.pitch * Math.PI) / 180
    cam.rotation.set(this.rig.pitch, this.rig.yaw, 0, 'YXZ')
    requestAnimationFrame(this.frame)

    // Stream until the spot is ready at full detail.
    const t0 = performance.now()
    const cities = this.plateau.citiesAt(p.lat, p.lon)
    while (performance.now() - t0 < 90_000) {
      const terrainOk = this.terrain.isDetailedAt(p.lat, p.lon)
      const vectorOk = this.vector.loadedCount > 0 && this.vector.pending === 0
      const progress = 0.25 + (terrainOk ? 0.35 : 0) + (vectorOk ? 0.3 : 0)
      this.hud.setLoading(
        progress,
        !terrainOk
          ? 'Draping aerial photographs on the land…'
          : !vectorOk
            ? 'Laying streets, rail and buildings (OpenStreetMap)…'
            : cities.length
              ? `Raising ${cities[0].name} (PLATEAU)…`
              : 'Almost there…',
      )
      if (terrainOk && vectorOk) break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (p.mode === 'onfoot') await this.spawnPlayer(p.lat, p.lon)
    else this.mode = 'fly'
    this.hud.setLoading(1, '')
    this.hud.hideLoading()
    this.updateHints()
  }

  /** Rendering + streaming budget per quality tier. */
  applyQuality(q: QualityTier): void {
    this.pipeline.setQuality(q)
    const t = {
      low: { far: 30_000, split: 1.3, near: 800, vfar: 1300, err: 48 },
      medium: { far: 60_000, split: 1.5, near: 1200, vfar: 2000, err: 32 },
      high: { far: 90_000, split: 1.6, near: 1500, vfar: 2600, err: 24 },
      ultra: { far: 120_000, split: 2.0, near: 1800, vfar: 3200, err: 16 },
    }[q]
    this.terrain.settings.farRadius = t.far
    this.terrain.settings.splitFactor = t.split
    this.vector.nearRadius = t.near
    this.vector.farRadius = t.vfar
    this.plateau.errorTarget = t.err
  }

  private async spawnPlayer(lat: number, lon: number): Promise<void> {
    const ground = this.terrain.heightAt(lat, lon)
    const at = this.world.worldFromGeodetic(lat, lon, ground)
    this.pipeline.scene.updateMatrixWorld(true)
    this.colliders.activateNow(at)
    // Land on whatever is there (road, bridge, plaza), not inside a building.
    const top = this.physics.groundBelow(at.x, at.y + 60, at.z, 120)
    if (top !== null && top - ground < 15) at.y = top
    this.player.spawn(at.add(new Vector3(0, 0.05, 0)))
    this.player.heading = this.rig.yaw
    if (!this.avatar && this.characters.manifest.length) {
      try {
        this.avatar = await this.characters.create(this.params.character)
        this.player.object.add(this.avatar.object)
      } catch (e) {
        console.warn('avatar failed', e)
      }
    }
    this.player.enabled = true
    this.mode = 'onfoot'
    this.rig.snap()
  }

  private updateHints(): void {
    const v = this.rig.mode === 'first' ? '1st person' : '3rd person'
    this.hud.setHints(
      this.mode === 'fly'
        ? '<kbd>WASD</kbd>fly <kbd>Q/E</kbd>down/up <kbd>Shift</kbd>fast <kbd>G</kbd>land'
        : `<kbd>WASD</kbd>walk <kbd>Shift</kbd>run <kbd>Space</kbd>jump <kbd>V</kbd>${v} <kbd>F</kbd>fly`,
    )
  }

  private frame = (t: number): void => {
    requestAnimationFrame(this.frame)
    const realDt = (t - this.last) / 1000
    const dt = Math.min(0.1, realDt)
    this.last = t
    this.elapsed += dt
    this.fpsAcc += realDt
    this.fpsFrames++
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc
      this.fpsAcc = 0
      this.fpsFrames = 0
    }
    this.clock.tick(dt)
    const cam = this.pipeline.camera
    const input = this.input
    const ax = input.axes()
    this.rig.look(ax.lookX, ax.lookY)
    if (input.wheel) this.rig.zoom(input.wheel)
    if (input.hit('KeyV')) {
      this.rig.toggle()
      this.updateHints()
    }
    if (input.hit('KeyF') && this.mode === 'onfoot') {
      this.mode = 'fly'
      this.player.enabled = false
      if (this.avatar) this.avatar.object.visible = false
      this.updateHints()
    } else if (input.hit('KeyG') && this.mode === 'fly') {
      const g = this.world.geodeticFromWorld(cam.position)
      void this.spawnPlayer(g.lat, g.lon).then(() => this.updateHints())
    }

    if (this.mode === 'onfoot' && this.player.body) {
      this.player.yaw = this.rig.yaw
      this.physics.update(dt, (h) => this.player.fixedUpdate(h, input))
      this.player.syncObject()
      if (this.avatar) {
        this.avatar.object.visible = this.rig.mode === 'third'
        this.avatar.update(dt, this.player.speed)
      }
      const feet = this.player.feet
      const stepHz = this.player.speed < 0.2 ? 0 : this.player.speed < 2.4 ? 1.85 : 2.8
      this.rig.update(dt, {
        pivot: feet.clone().add(new Vector3(0, this.rig.mode === 'first' ? 1.62 : 1.55, 0)),
        exclude: this.player.collider,
        speed: this.player.speed,
        stepHz,
        distance: 3.4,
        shoulder: this.rig.mode === 'third' ? 0.35 : 0,
      })
      this.colliders.update(dt, feet)
      this.keepAboveGround(feet)
      this.maybeRebase(feet)
    } else if (this.mode === 'fly') {
      this.updateFly(dt)
      this.maybeRebase(cam.position)
    }

    cam.updateMatrixWorld()
    this.terrain.update(cam.position, t)
    this.plateau.update(cam.position)
    this.vector.update(cam.position, t)
    this.pipeline.setDate(this.clock.date)
    const focus = this.mode === 'onfoot' && this.player.body ? this.player.feet : cam.position
    this.pipeline.update(dt, focus)
    updateWater(this.elapsed)
    buildingUniforms.uNight.value = nightFactorFromSun(this.pipeline.sunElevation())
    buildingUniforms.uTime.value = this.elapsed
    this.pipeline.render(dt)
    this.updateHud(dt)
    input.endFrame()
  }

  private updateFly(dt: number): void {
    const cam = this.pipeline.camera
    const ax = this.input.axes()
    cam.rotation.set(this.rig.pitch, this.rig.yaw, 0, 'YXZ')
    const g = this.world.geodeticFromWorld(cam.position)
    const ground = this.terrain.heightAt(g.lat, g.lon)
    const agl = Math.max(2, g.h - (Number.isNaN(ground) ? 0 : ground))
    const speed = (this.input.isDown('ShiftLeft') ? 6 : 1) * Math.max(8, agl * 0.8)
    const f = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
    const r = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    cam.position.addScaledVector(f, ax.moveY * speed * dt).addScaledVector(r, ax.moveX * speed * dt)
    if (this.input.isDown('KeyE')) cam.position.y += speed * dt
    if (this.input.isDown('KeyQ')) cam.position.y -= speed * dt
  }

  /** Safety net for data gaps: never let the player end up under the land. */
  private keepAboveGround(feet: Vector3): void {
    const g = this.world.geodeticFromWorld(feet)
    const ground = this.terrain.heightAt(g.lat, g.lon)
    if (Number.isNaN(ground) || g.h > ground - 1.5) return
    const at = this.world.worldFromGeodetic(g.lat, g.lon, ground)
    const top = this.physics.groundBelow(at.x, at.y + 3, at.z, 6)
    this.player.teleport(new Vector3(at.x, (top ?? at.y) + 0.05, at.z))
  }

  private maybeRebase(p: Vector3): void {
    if (Math.hypot(p.x, p.z) < REBASE_DISTANCE) return
    const g = this.world.geodeticFromWorld(p)
    this.world.rebase(g.lat, g.lon)
  }

  private updateHud(dt: number): void {
    const cam = this.pipeline.camera
    const j = this.clock.jst
    const pad = (n: number) => String(n).padStart(2, '0')
    const wd = ['日', '月', '火', '水', '木', '金', '土'][j.weekday]
    this.hud.setClock(`${j.month}月${j.day}日(${wd})  ${pad(j.hour)}:${pad(j.minute)} JST`)
    this.hud.setCompass(this.rig.yaw)
    this.placeTimer += dt
    if (this.placeTimer > 1.5 && this.mode !== 'loading') {
      this.placeTimer = 0
      this.updatePlace(cam.position)
    }
    this.hud.setDebug(
      `fps ${this.fps.toFixed(0)}  mode ${this.mode}  speed ${this.player.speed.toFixed(2)}\n` +
        `terrain ${this.terrain.visibleCount}/${this.terrain.readyCount}  vector ${this.vector.loadedCount}  net ${pendingRequests()}\n` +
        `physics ${this.physics.staticCount}/${this.colliders.candidateCount}  plateau ${this.plateau.activeNames.join(',')}`,
    )
  }

  private updatePlace(p: Vector3): void {
    const g = this.world.geodeticFromWorld(p)
    let best: Place | null = null
    let bestD = Infinity
    for (const pl of this.places) {
      if (!['neighbourhood', 'quarter', 'suburb', 'village', 'hamlet', 'town', 'city'].includes(pl.cls)) continue
      const w = pl.cls === 'neighbourhood' || pl.cls === 'quarter' ? 1 : pl.cls === 'suburb' || pl.cls === 'hamlet' ? 1.6 : 3
      const d = approxDistanceMeters(g, pl) / w
      if (d < bestD) {
        bestD = d
        best = pl
      }
    }
    if (!best || bestD > 1500 || best.name === this.currentPlace) return
    this.currentPlace = best.name
    const city = this.plateau.citiesAt(g.lat, g.lon)[0]
    this.hud.showPlace({
      kanji: best.name,
      reading: best.reading,
      romaji: best.romaji || best.nameEn,
      sub: city ? `${city.pref} ${city.name}` : undefined,
    })
  }

  /** Debug/test helper. */
  stats(): Record<string, number | string> {
    return {
      fps: Math.round(this.fps),
      mode: this.mode,
      terrainReady: this.terrain.readyCount,
      terrainVisible: this.terrain.visibleCount,
      pending: pendingRequests(),
      vectorTiles: this.vector.loadedCount,
      vectorPending: this.vector.pending,
      physics: this.physics.staticCount,
      settled: Number(this.mode !== 'loading' && this.elapsed > 8 && pendingRequests() === 0),
    }
  }

  /** Debug: what does a ray from the camera hit? */
  debugPick(dx: number, dy: number, dz: number): Array<{ name: string; parent: string; d: number; y: number }> {
    const rc = new Raycaster(this.pipeline.camera.position.clone(), new Vector3(dx, dy, dz).normalize(), 0, 5000)
    this.pipeline.scene.updateMatrixWorld(true)
    return rc
      .intersectObjects([this.terrain.root, this.vector.root, this.plateau.root], true)
      .filter((h) => h.object.visible && (h.object.parent?.visible ?? true))
      .slice(0, 6)
      .map((h) => ({ name: h.object.name, parent: h.object.parent?.name ?? '', d: Math.round(h.distance * 100) / 100, y: Math.round(h.point.y * 100) / 100 }))
  }
}
