// NIHON game orchestrator: boots the world at a real place in Japan, streams
// it in around the player, and runs the frame loop.
import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, Raycaster, Vector3, type Mesh } from 'three'
import { WorldFrame } from '../core/frame'
import { GameClock, fromJst, jstParts } from '../core/clock'
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
import { VehicleManager } from '../vehicles/VehicleManager'
import { Traffic, type AICar } from '../vehicles/Traffic'
import { MapView } from '../ui/MapView'
import type { Destination } from '../data/places'
import { RailRide } from '../transit/RailRide'
import { Crowd } from '../people/Crowd'
import { PopulationGrid, pedestriansPerHectare } from '../people/density'
import { DESTINATIONS } from '../data/places'
import { SCRAMBLES, scrambleWalkTime } from '../people/scramble'
import { WeatherSystem, type WeatherPreset } from '../weather/WeatherSystem'
import { StationPanel } from '../ui/StationPanel'
import type { Station } from '../transit/RailNetwork'

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

export type Mode = 'loading' | 'onfoot' | 'driving' | 'passenger' | 'train' | 'fly'

/** `t` accepts an ISO date or a bare JST wall-clock time ("19:30") today. */
function parseTime(t: string): Date | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (m) {
    const now = jstParts(new Date())
    return fromJst(now.year, now.month, now.day, Number(m[1]), Number(m[2]))
  }
  const d = new Date(t)
  return isNaN(d.getTime()) ? undefined : d
}

function readParams(): StartParams {
  const q = new URLSearchParams(location.search)
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
  const altitude = num('alt', 0)
  return {
    // Default: the Shibuya Scramble Crossing.
    lat: num('lat', 35.65947),
    lon: num('lon', 139.70057),
    date: q.has('t') ? parseTime(q.get('t')!) : undefined,
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
  readonly vehicles: VehicleManager
  readonly traffic: Traffic
  readonly map: MapView
  readonly rail: RailRide
  readonly stationPanel: StationPanel
  readonly crowd = new Crowd()
  readonly weather = new WeatherSystem()
  private population: PopulationGrid | null = null
  private crowdTimer = 0
  private crowdTarget = 0
  /** Pedestrians per hectare right here, right now (debug/HUD). */
  pedDensity = 0
  private nearStation: Station | null = null
  private stationTimer = 0
  private trainBaseYaw: number | null = null
  /** Money: cash and a Suica-style IC card. */
  wallet = { cash: 30000, ic: 3000 }
  private ride: { car: AICar; kind: 'taxi' | 'bus'; meterM: number; slowS: number; last: Vector3; fare: number } | null = null
  private hailed: AICar | null = null
  destination: { lat: number; lon: number; label: string } | null = null
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
    this.vector.lights = this.pipeline.lights
    this.colliders = new WorldColliders(this.physics)
    this.vehicles = new VehicleManager(this.physics, this.vector)
    this.traffic = new Traffic(this.physics, this.vector)
    this.input = new Input(canvas)
    this.player = new Player(this.physics)
    this.rig = new CameraRig(this.pipeline.camera, this.physics)
    const scene = this.pipeline.scene
    scene.add(this.terrain.root, this.plateau.root, this.vector.root, this.player.object, this.vehicles.root, this.traffic.root, this.crowd.root, this.weather.precip.mesh)
    const wp = new URLSearchParams(location.search).get('weather')
    if (wp) this.weather.preset = wp as WeatherPreset
    this.map = new MapView(ui, {
      travel: (lat, lon, heading, dest) => void this.travelTo(lat, lon, heading, dest),
      setDestination: (lat, lon, label) => {
        this.destination = { lat, lon, label }
        this.hud.toast(`Destination set: <b>${label}</b>${this.ride?.kind === 'taxi' ? ' — the driver nods.' : ''}`)
      },
      playerPos: () => {
        const p = this.mode === 'onfoot' && this.player.body ? this.player.feet : this.pipeline.camera.position
        const g = this.world.geodeticFromWorld(p)
        return { lat: g.lat, lon: g.lon, heading: -this.rig.yaw }
      },
    })
    this.rail = new RailRide({
      world: this.world,
      terrain: this.terrain,
      vector: this.vector,
      scene,
      hud: this.hud,
      ui,
      advanceClock: (sec) => this.clock.advance(sec),
      payIC: (yen) => this.pay(yen, 'ic'),
      finish: (st) => void this.leaveTrain(st),
      veil: (text) => (text ? this.hud.showLoading(text) : this.hud.hideLoading()),
      worldReadyAt: (p) => {
        const g = this.world.geodeticFromWorld(p)
        return this.terrain.isDetailedAt(g.lat, g.lon) && this.vector.pending === 0
      },
    })
    this.stationPanel = new StationPanel(ui, () => this.rail.net, {
      wallet: () => this.wallet,
      charge: (yen) => {
        if (this.wallet.cash < yen) {
          this.hud.toast('Not enough cash to charge the card.')
          return false
        }
        this.wallet.cash -= yen
        this.wallet.ic += yen
        this.hud.toast(`Charged ¥${yen.toLocaleString()} onto your IC card (チャージ).`)
        return true
      },
      board: (route) => this.boardTrain(route),
      close: () => this.stationPanel.hide(),
      here: () => {
        const g = this.world.geodeticFromWorld(this.player.feet)
        return { lat: g.lat, lon: g.lon }
      },
    })
    this.placeScrambles()
    this.traffic.graph.allRed = (pos) =>
      this.crowd.scrambles.some((sc) => sc.walkTime() >= 0 && Math.hypot(pos.x - sc.center.x, pos.z - sc.center.z) < sc.radius + 18)
    this.wireColliders()
    this.world.onRebase((delta) => {
      this.placeScrambles()
      this.rail.snap.invalidate()
      this.crowd.rebase(delta)
      this.pipeline.scene.updateMatrixWorld(true)
      this.physics.syncStatics()
      if (this.player.body) this.player.rebase(delta)
      this.vehicles.rebase(delta)
      this.traffic.rebase(delta)
      this.pipeline.lights.invalidate()
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
    await Promise.all([
      this.pipeline.init(),
      this.plateau.init(),
      this.physics.init(),
      this.characters.init(),
      this.rail.load().catch((e) => console.warn('rail network unavailable', e)),
      this.crowd.init(Math.ceil(this.crowd.cap / 5)).catch((e) => console.warn('crowd unavailable', e)),
      PopulationGrid.load()
        .then((g) => (this.population = g))
        .catch((e) => console.warn('population grid unavailable', e)),
    ])
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
    if (this.rail) this.rail.maxAmbient = { low: 2, medium: 3, high: 5, ultra: 7 }[q]
    const c = { low: [75, 70], medium: [100, 170], high: [120, 320], ultra: [150, 520] }[q]
    this.crowd.maxRadius = this.crowd.radius = c[0]
    this.crowd.cap = c[1]
    this.weather.budget = { low: 3000, medium: 6000, high: 10000, ultra: 16000 }[q]
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

  /** Nearest point on a street or footpath (never inside a building). */
  private nearestWalkable(at: Vector3, maxDist = 200): Vector3 | null {
    let best: Vector3 | null = null
    let bd = maxDist
    const p = new Vector3()
    for (const t of this.vector.readyTiles) {
      t.group.updateWorldMatrix(true, false)
      for (const path of t.build.paths) {
        if (path.kind === 'rail' || path.bridge) continue
        for (let i = 0; i < path.pts.length; i += 3) {
          p.set(path.pts[i], path.pts[i + 1], path.pts[i + 2]).applyMatrix4(t.group.matrixWorld)
          const d = Math.hypot(p.x - at.x, p.z - at.z)
          if (d < bd) {
            bd = d
            best = p.clone()
          }
        }
      }
    }
    return best
  }

  private async spawnPlayer(lat: number, lon: number): Promise<void> {
    const ground = this.terrain.heightAt(lat, lon)
    let at = this.world.worldFromGeodetic(lat, lon, ground)
    this.pipeline.scene.updateMatrixWorld(true)
    at = this.nearestWalkable(at) ?? at
    this.colliders.activateNow(at)
    // Land on the street surface (or bridge deck) right there.
    const top = this.physics.groundBelow(at.x, at.y + 3, at.z, 10)
    if (top !== null) at.y = top
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
    this.placeScrambles()
    const carParam = new URLSearchParams(location.search).get('car')
    if (carParam && !this.vehicles.vehicles.length) {
      const fwd = new Vector3(-Math.sin(this.rig.yaw), 0, -Math.cos(this.rig.yaw))
      const right = new Vector3(Math.cos(this.rig.yaw), 0, -Math.sin(this.rig.yaw))
      const at = this.player.feet.clone().addScaledVector(fwd, 5).addScaledVector(right, -1.5)
      void this.vehicles.spawnAt(carParam, at, this.rig.yaw)
    }
  }

  private updateHints(): void {
    const v = this.rig.mode === 'first' ? '1st person' : '3rd person'
    this.hud.setHints(
      this.mode === 'fly'
        ? '<kbd>WASD</kbd>fly <kbd>Q/E</kbd>down/up <kbd>Shift</kbd>fast <kbd>G</kbd>land'
        : this.mode === 'train'
          ? '<kbd>T</kbd>skip to next station <kbd>Shift+T</kbd>skip to destination <kbd>V</kbd>seat / cab / outside <kbd>E</kbd>get off (when stopped)'
          : this.mode === 'passenger'
          ? `<kbd>M</kbd>map <kbd>V</kbd>${v} <kbd>E</kbd>get off`
          : this.mode === 'driving'
          ? `<kbd>W/S</kbd>drive/brake <kbd>A/D</kbd>steer <kbd>Space</kbd>handbrake <kbd>E</kbd>get out <kbd>V</kbd>${v}`
          : `<kbd>WASD</kbd>walk <kbd>Shift</kbd>run <kbd>E</kbd>use <kbd>H</kbd>hail taxi <kbd>M</kbd>map <kbd>V</kbd>${v}`,
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
    if (input.hit('KeyV') && this.mode !== 'train') {
      this.rig.toggle()
      this.updateHints()
    }
    if (input.hitAlways('KeyM') || (this.map.open && input.hitAlways('Escape'))) {
      this.map.toggle()
      if (this.map.open) document.exitPointerLock?.()
    }
    input.enabled = !this.map.open && !this.stationPanel.open && this.mode !== 'loading'
    if (this.stationPanel.open && input.hitAlways('Escape')) this.stationPanel.hide()
    if (input.hit('KeyF') && this.mode === 'onfoot') {
      this.mode = 'fly'
      this.player.enabled = false
      if (this.avatar) this.avatar.object.visible = false
      this.updateHints()
    } else if (input.hit('KeyG') && this.mode === 'fly') {
      const g = this.world.geodeticFromWorld(cam.position)
      void this.spawnPlayer(g.lat, g.lon).then(() => this.updateHints())
    }

    if ((this.mode === 'onfoot' && this.player.body) || this.mode === 'driving') {
      if (this.mode === 'onfoot') this.player.yaw = this.rig.yaw
      this.physics.update(dt, (h) => {
        if (this.mode === 'onfoot') this.player.fixedUpdate(h, input)
        this.vehicles.fixedUpdate(h, input)
      })
      this.vehicles.sync()
    }
    if (this.mode === 'onfoot' && this.player.body) {
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
      // Interactions
      const car = this.vehicles.nearestEnterable(feet)
      const boardable = this.boardable(feet)
      if (boardable) {
        const taxi = boardable.role === 'taxi'
        this.hud.setPrompt(taxi ? '<kbd>E</kbd>Get in the taxi <span style="opacity:.7">— the rear door opens by itself</span>' : `<kbd>E</kbd>Board the bus <span style="opacity:.7">¥210 · IC card</span>`)
        if (input.hit('KeyE')) this.board(boardable)
      } else if (car) {
        this.hud.setPrompt(`<kbd>E</kbd>Drive the ${car.spec.label} <span style="opacity:.7">${car.spec.labelJa}</span>`)
        if (input.hit('KeyE')) this.enterVehicle(car)
      } else {
        this.stationTimer -= dt
        if (this.stationTimer <= 0) {
          this.stationTimer = 0.5
          const g = this.world.geodeticFromWorld(feet)
          this.nearStation = this.rail.stationNear(g.lat, g.lon)
        }
        const st = this.nearStation
        this.hud.setPrompt(st ? `<kbd>E</kbd>Enter <b>${st.ja}駅</b> <span style="opacity:.75">${st.en ? st.en + ' Station' : ''} · ${this.stationModes(st)}</span>` : null)
        if (st && input.hit('KeyE')) {
          document.exitPointerLock?.()
          this.stationPanel.show(st)
        }
      }
      if (input.hit('KeyH')) {
        this.hailed = this.traffic.hailTaxi(feet)
        this.hud.toast(this.hailed ? 'You raise your hand. A taxi showing <b>空車</b> (vacant) pulls over.' : 'No vacant taxi nearby — look for the red <b>空車</b> sign on major streets.')
      }
      this.colliders.update(dt, feet)
      this.keepAboveGround(feet)
      this.vehicles.update(dt, feet)
      this.hud.setSpeed(null)
      this.maybeRebase(feet)
    } else if (this.mode === 'driving' && this.vehicles.current) {
      const v = this.vehicles.current
      const pos = v.position
      if (input.hit('KeyE') && Math.abs(v.speed) < 2) this.exitVehicle()
      else {
        // Chase camera eases behind the car unless the player is looking around.
        if (Math.abs(ax.lookX) + Math.abs(ax.lookY) > 0.0005) this.lookIdle = 0
        else this.lookIdle += dt
        if (this.lookIdle > 1.2 && this.rig.mode === 'third') {
          let d = v.yaw - this.rig.yaw
          while (d > Math.PI) d -= Math.PI * 2
          while (d < -Math.PI) d += Math.PI * 2
          this.rig.yaw += d * Math.min(1, dt * 2.5 * Math.min(1, Math.abs(v.speed) / 3))
          this.rig.pitch += (-0.16 - this.rig.pitch) * Math.min(1, dt * 1.5)
        }
        const pivot = this.rig.mode === 'first' ? v.driverEye() : pos.clone().add(new Vector3(0, v.spec.height * 0.85, 0))
        this.rig.update(dt, {
          pivot,
          exclude: v.collider,
          speed: Math.abs(v.speed),
          stepHz: 0,
          distance: v.spec.bus ? 11 : v.spec.length > 4.6 ? 7.2 : 6.2,
          shoulder: 0,
        })
        this.hud.setSpeed(Math.abs(v.speed) * 3.6)
        this.colliders.update(dt, pos)
        this.vehicles.update(dt, pos)
        this.maybeRebase(pos)
      }
    } else if (this.mode === 'train' && this.rail.active) {
      this.updateTrain(dt, input)
    } else if (this.mode === 'passenger' && this.ride) {
      this.updateRide(dt, input)
    } else if (this.mode === 'fly') {
      this.updateFly(dt)
      this.maybeRebase(cam.position)
    }

    if (this.mode === 'onfoot' || this.mode === 'driving' || this.mode === 'passenger' || this.mode === 'train') {
      const focus = this.mode === 'train' ? cam.position : this.mode === 'driving' && this.vehicles.current ? this.vehicles.current.position : this.ride ? this.ride.car.pos : this.player.feet
      this.traffic.playerPos = this.mode === 'onfoot' ? this.player.feet : null
      this.traffic.playerCar = this.mode === 'driving' && this.vehicles.current ? { pos: this.vehicles.current.position, length: this.vehicles.current.spec.length } : null
      this.traffic.update(dt, focus, this.clock.jst.hourFloat)
      this.rail.updateAmbient(dt, cam.position, this.clock.jst.hourFloat)
      this.updateCrowd(dt, this.mode === 'onfoot' ? this.player.feet : cam.position)
    }
    cam.updateMatrixWorld()
    this.terrain.update(cam.position, t)
    this.plateau.update(cam.position)
    this.vector.update(cam.position, t)
    this.pipeline.setDate(this.clock.date)
    const focus = this.mode === 'onfoot' && this.player.body ? this.player.feet : cam.position
    const night = nightFactorFromSun(this.pipeline.sunElevation())
    this.pipeline.night = night
    {
      const g = this.world.geodeticFromWorld(cam.position)
      const ground = this.terrain.heightAt(g.lat, g.lon)
      this.weather.update(dt, g.lat, g.lon, Number.isFinite(ground) ? ground : 0, this.clock.date, this.pipeline)
      this.weather.precip.mesh.visible &&= this.pipeline.indoor < 0.5
      this.crowd.rain = this.weather.rainFactor
    }
    this.pipeline.update(dt, focus)
    updateWater(this.elapsed)
    buildingUniforms.uNight.value = night
    buildingUniforms.uTime.value = this.elapsed
    this.pipeline.render(dt)
    this.updateHud(dt)
    input.endFrame()
  }

  private lookIdle = 0

  /** Scramble crossings within reach, in world space, on the game clock. */
  private placeScrambles(): void {
    this.crowd.scrambles = SCRAMBLES.filter((s) => Math.hypot((s.lat - this.world.frame.lat) * 111000, (s.lon - this.world.frame.lon) * 91000) < 8000).map((s) => ({
      center: this.world.worldFromGeodetic(s.lat, s.lon, this.terrain.heightAt(s.lat, s.lon) || 0),
      radius: s.radius,
      pedPhase: s.ped,
      walkTime: () => scrambleWalkTime(s, this.clock.date.getTime() / 1000),
    }))
  }

  /** Real-data crowd density around the player → number of pedestrians. */
  private updateCrowd(dt: number, at: Vector3): void {
    if (!this.crowd.ready) return
    this.crowd.maybeRebuild(dt, this.vector.readyTiles)
    this.crowdTimer -= dt
    if (this.crowdTimer <= 0) {
      this.crowdTimer = 2
      const g = this.world.geodeticFromWorld(at)
      const j = this.clock.jst
      const stations = this.rail.net ? this.rail.net.nearby(g.lat, g.lon, 900).map((n) => ({ riders: n.station.riders, distance: n.d })) : []
      let hotspot = 0
      for (const d of DESTINATIONS) {
        const dist = Math.hypot((d.lat - g.lat) * 111000, (d.lon - g.lon) * 91000)
        if (dist < 600) hotspot = Math.max(hotspot, d.tags.includes('iconic') ? 1 : d.tags.some((t) => ['temple', 'shrine', 'castle', 'old town'].includes(t)) ? 0.4 : 0)
      }
      this.pedDensity = pedestriansPerHectare({
        residentsPerKm2: this.population?.densityAt(g.lat, g.lon) ?? 0,
        shopsWithin300m: this.crowd.shopsNear(at, 300),
        stations,
        hour: j.hourFloat,
        weekend: j.weekday === 0 || j.weekday === 6,
        rain: this.weather.rainFactor,
        hotspot,
      })
    }
    this.crowd.update(dt, at, this.pedDensity, this.elapsed)
    this.crowdTarget = this.crowd.target
  }

  private stationModes(st: Station): string {
    const net = this.rail.net!
    const kinds = new Set(net.complex(st.id).map((c) => net.lines[c.line].kind))
    const names: string[] = []
    if (kinds.has('shinkansen')) names.push('Shinkansen')
    if (kinds.has('jr')) names.push('JR')
    if (kinds.has('metro')) names.push('subway')
    if (kinds.has('private')) names.push('private railway')
    if (kinds.has('tram')) names.push('tram')
    if (kinds.has('monorail') || kinds.has('agt')) names.push('monorail')
    const n = new Set(net.complex(st.id).map((c) => c.line)).size
    return `${names.join(', ')} · ${n} line${n > 1 ? 's' : ''}`
  }

  private boardTrain(route: import('../transit/RailNetwork').Route): void {
    // Tap in: Japanese gates need at least the minimum fare on the card.
    if (this.wallet.ic < 150) {
      this.hud.toast('Your IC card balance is too low for the gate — charge it first.')
      return
    }
    this.stationPanel.hide()
    this.hud.setPrompt(null)
    this.hud.toast('ピッ — through the ticket gate. Head for the platform…', 2500)
    this.mode = 'train'
    this.player.enabled = false
    this.player.object.visible = false
    this.player.body?.setEnabled(false)
    if (this.vehicles.current) this.vehicles.exit()
    this.rail.view = 'seat'
    this.trainBaseYaw = null
    this.rail.begin(route)
    this.updateHints()
  }

  private updateTrain(dt: number, input: import('../player/Input').Input): void {
    this.rail.update(dt, {
      skip: input.hit('KeyT') && !input.isDown('ShiftLeft') && !input.isDown('ShiftRight'),
      skipAll: input.hit('KeyT') && (input.isDown('ShiftLeft') || input.isDown('ShiftRight')),
      exit: input.hit('KeyE'),
      view: input.hit('KeyV'),
    })
    const t = this.rail.cameraTarget()
    if (!t) return
    // The view turns with the train; mouse-look is an offset on top.
    const base = Math.atan2(-t.forward.x, -t.forward.z)
    if (this.trainBaseYaw === null || this.rail.view !== this.lastTrainView) {
      this.rig.yaw = base
      this.rig.pitch = this.rail.view === 'outside' ? -0.18 : -0.05
      this.lastTrainView = this.rail.view
    } else {
      let d = base - this.trainBaseYaw
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      this.rig.yaw += d
    }
    this.trainBaseYaw = base
    this.rig.mode = t.first ? 'first' : 'third'
    this.rig.update(dt, { pivot: t.pivot, speed: 0, stepHz: 0, distance: t.distance, shoulder: 0 })
    this.hud.setSpeed(null)
    this.pipeline.indoor += ((this.rail.run?.underground ? 1 : 0) - this.pipeline.indoor) * Math.min(1, dt * 1.5)
    this.maybeRebase(t.pivot)
  }

  private lastTrainView = ''

  /** Debug/test: board the fastest route between two stations by name. */
  debugRide(from: string, to: string, view: 'seat' | 'cab' | 'outside' = 'seat'): string {
    const net = this.rail.net
    if (!net) return 'no network'
    const a = net.search(from, 1)[0]
    const b = net.search(to, 1)[0]
    const r = a && b ? net.route(a.id, b.id) : null
    if (!r) return 'no route'
    this.boardTrain(r)
    this.rail.view = view
    return r.legs.map((l) => `${l.line.ja} ${net.stations[l.stations[0]].ja}→${net.stations[l.stations[l.stations.length - 1]].ja}`).join(' / ')
  }

  private async leaveTrain(st: Station): Promise<void> {
    this.pipeline.indoor = 0
    this.mode = 'loading'
    this.player.body?.setEnabled(true)
    this.player.object.visible = true
    this.rig.mode = 'third'
    await this.spawnPlayer(st.lat, st.lon)
    this.hud.showPlace({ kanji: st.ja + '駅', reading: st.kana, romaji: st.en ? st.en + ' Station' : '', sub: this.rail.net?.lines[st.line].ja })
    this.updateHints()
  }

  /** A stopped bus or a hailed, stopped taxi right next to the player. */
  private boardable(feet: Vector3): AICar | null {
    for (const c of this.traffic.cars) {
      if (c.v > 0.4) continue
      const d = c.pos.distanceTo(feet)
      if (c.role === 'taxi' && c === this.hailed && d < 5) return c
      if (c.role === 'bus' && c.stopTimer > 0 && d < 7) return c
    }
    return null
  }

  private board(c: AICar): void {
    const kind = c.role === 'taxi' ? 'taxi' : 'bus'
    if (kind === 'bus') {
      if (!this.pay(210, 'ic')) return
      this.hud.toast('ピッ — ¥210 from your IC card. Buses in Tokyo charge a flat fare when you board at the front.')
    } else {
      c.vacant = false
      c.hailed = false
      this.hailed = null
      this.hud.toast(this.destination ? `「<b>${this.destination.label}</b>までお願いします」— Please take me to ${this.destination.label}.` : 'The driver asks 「どちらまで？」 (Where to?) — open the map (<kbd>M</kbd>) and choose <b>Set destination</b>.', 7000)
    }
    c.passengerAboard = true
    c.stopTimer = 0
    this.ride = { car: c, kind, meterM: 0, slowS: 0, last: c.pos.clone(), fare: kind === 'taxi' ? 500 : 210 }
    this.mode = 'passenger'
    this.player.enabled = false
    this.player.object.visible = false
    this.player.body.setEnabled(false)
    this.rig.mode = 'third'
    this.rig.snap()
    this.routeTimer = 0
    this.updateHints()
  }

  private routeTimer = 0

  private updateRide(dt: number, input: import('../player/Input').Input): void {
    const r = this.ride!
    const c = r.car
    if (!this.traffic.cars.includes(c)) {
      // The vehicle left the simulated area (e.g. data gap): end the ride.
      this.leaveRide()
      return
    }
    // Taximeter (Tokyo 2022): ¥500 for the first 1.096 km, ¥100 per 255 m
    // after that, plus ¥100 per 95 s spent below 10 km/h.
    const moved = c.pos.distanceTo(r.last)
    r.last.copy(c.pos)
    if (r.kind === 'taxi') {
      r.meterM += moved
      if (c.v < 2.8) r.slowS += dt
      r.fare = 500 + Math.max(0, Math.ceil((r.meterM - 1096) / 255)) * 100 + Math.floor(r.slowS / 95) * 100
      this.routeTimer -= dt
      if (this.destination && this.routeTimer <= 0) {
        this.routeTimer = 4
        const goal = this.world.worldFromGeodetic(this.destination.lat, this.destination.lon, this.terrain.heightAt(this.destination.lat, this.destination.lon) || 0)
        c.route = this.traffic.graph.route(c.lane.id, goal)
        c.nextLane = -1
        c.destination = goal
        if (c.pos.distanceTo(goal) < 60) {
          c.stopTimer = 1
        }
      }
      this.hud.setSpeed(c.v * 3.6)
      this.hud.setPrompt(
        `<span style="opacity:.75">メーター</span> <b>¥${r.fare.toLocaleString()}</b>` +
          (this.destination ? ` · <kbd>T</kbd>skip ride · <kbd>E</kbd>${c.v < 0.5 ? 'pay & get out' : 'stop here'}` : ' · <kbd>M</kbd>choose destination · <kbd>E</kbd>get out'),
      )
      if (input.hit('KeyT') && this.destination) {
        // Skip ahead: pay a distance-based estimate and arrive.
        const g = this.world.geodeticFromWorld(c.pos)
        const km = Math.hypot((g.lat - this.destination.lat) * 111, (g.lon - this.destination.lon) * 91) * 1.3
        const fare = r.fare + Math.ceil((km * 1000) / 255) * 100
        if (this.pay(fare, 'cash')) {
          const d = this.destination
          this.leaveRide(true)
          void this.travelTo(d.lat, d.lon, undefined, undefined, `Taxi ride · ¥${fare.toLocaleString()}`)
        }
        return
      }
      if (input.hit('KeyE')) {
        if (c.v > 0.5) c.stopTimer = 3
        else if (this.pay(r.fare, 'cash')) this.leaveRide()
      }
    } else {
      this.hud.setSpeed(null)
      this.hud.setPrompt(c.stopTimer > 0 ? '<kbd>E</kbd>Get off here <span style="opacity:.7">次は… (next stop)</span>' : '<span style="opacity:.8">Riding the bus — press the stop button (<kbd>E</kbd>) to get off at the next stop</span>')
      if (input.hit('KeyE') && c.stopTimer > 0) this.leaveRide()
    }
    const pivot = c.pos.clone().add(new Vector3(0, c.spec.height * 0.85, 0))
    this.rig.update(dt, { pivot, speed: c.v, stepHz: 0, distance: c.role === 'bus' ? 11 : 6.2, shoulder: 0 })
    this.colliders.update(dt, c.pos)
    this.maybeRebase(c.pos)
  }

  private leaveRide(silent = false): void {
    const r = this.ride
    if (!r) return
    const c = r.car
    c.passengerAboard = false
    if (r.kind === 'taxi') {
      c.vacant = true
      c.route = []
      c.destination = null
    }
    this.ride = null
    this.hud.setPrompt(null)
    this.hud.setSpeed(null)
    if (!silent) {
      // Step out on the kerb side (left in Japan).
      const left = new Vector3(c.tan.z, 0, -c.tan.x).normalize()
      const at = c.pos.clone().addScaledVector(left, c.spec.width / 2 + 0.9)
      this.player.body.setEnabled(true)
      const top = this.physics.groundBelow(at.x, at.y + 3, at.z, 8)
      this.player.teleport(new Vector3(at.x, (top ?? at.y) + 0.05, at.z))
      this.player.object.visible = true
      this.player.enabled = true
      this.mode = 'onfoot'
      if (r.kind === 'taxi') this.hud.toast(`Paid <b>¥${r.fare.toLocaleString()}</b>. No tipping in Japan — a simple ありがとうございました is perfect.`)
    }
    this.updateHints()
  }

  /** Pay from cash or IC card; returns false if short. */
  pay(yen: number, method: 'cash' | 'ic'): boolean {
    if (method === 'ic' && this.wallet.ic >= yen) {
      this.wallet.ic -= yen
      return true
    }
    if (this.wallet.cash >= yen) {
      this.wallet.cash -= yen
      return true
    }
    this.hud.toast(`Not enough money (need ¥${yen.toLocaleString()}). Top up your IC card at a station machine or ATM at a konbini.`)
    return false
  }

  /** Fast travel: re-anchor the world at a new place and stream it in. */
  async travelTo(lat: number, lon: number, heading?: number, dest?: Destination, note?: string): Promise<void> {
    this.mode = 'loading'
    this.hud.showLoading(dest ? `Travelling to ${dest.kanji} · ${dest.en}` : note ?? 'Travelling…')
    this.hud.setPrompt(null)
    this.hud.setSpeed(null)
    if (this.vehicles.current) this.vehicles.exit()
    for (const c of [...this.traffic.cars]) this.traffic.remove(c)
    this.rail.clearAmbient()
    this.crowd.clear()
    for (const v of [...this.vehicles.vehicles]) v.dispose()
    this.vehicles.vehicles.length = 0
    this.player.enabled = false
    this.world.rebase(lat, lon)
    this.places = []
    this.currentPlace = ''
    await this.terrain.prefetchAround(lat, lon, 300).catch(() => {})
    const ground = this.terrain.heightAt(lat, lon)
    const cam = this.pipeline.camera
    cam.position.copy(this.world.worldFromGeodetic(lat, lon, (Number.isNaN(ground) ? 0 : ground) + 1.7))
    if (heading !== undefined) this.rig.yaw = (-heading * Math.PI) / 180
    const t0 = performance.now()
    while (performance.now() - t0 < 60_000) {
      const terrainOk = this.terrain.isDetailedAt(lat, lon)
      const vectorOk = this.vector.loadedCount > 0 && this.vector.pending === 0
      this.hud.setLoading(0.2 + (terrainOk ? 0.4 : 0) + (vectorOk ? 0.3 : 0), !terrainOk ? 'Draping aerial photographs on the land…' : 'Laying streets and buildings…')
      if (terrainOk && vectorOk) break
      await new Promise((r) => setTimeout(r, 300))
    }
    this.player.body?.setEnabled(true)
    await this.spawnPlayer(lat, lon)
    this.hud.hideLoading()
    if (dest) {
      this.currentPlace = dest.kanji
      this.hud.showPlace({ kanji: dest.kanji, reading: dest.reading, romaji: dest.romaji, meaning: dest.meaning, sub: `${dest.pref} · ${dest.en}` })
      setTimeout(() => this.hud.toast(dest.blurb, 9000), 2500)
    }
    this.updateHints()
  }

  private enterVehicle(car: import('../vehicles/Vehicle').Vehicle): void {
    this.vehicles.enter(car)
    this.mode = 'driving'
    this.player.enabled = false
    this.player.object.visible = false
    this.player.body.setEnabled(false)
    this.rig.yaw = car.yaw
    this.rig.snap()
    this.hud.setPrompt(null)
    this.hud.toast(`<b>${car.spec.labelJa}</b> · ${car.spec.label}<br><span style="opacity:.75">Japan drives on the left. Speed limits: 30–60 km/h in town, 100–120 km/h on expressways.</span>`, 6000)
    this.updateHints()
  }

  private exitVehicle(): void {
    const door = this.vehicles.exit()
    if (!door) return
    this.player.body.setEnabled(true)
    const top = this.physics.groundBelow(door.x, door.y + 3, door.z, 8)
    this.player.teleport(new Vector3(door.x, (top ?? door.y) + 0.05, door.z))
    this.player.object.visible = true
    this.player.enabled = true
    this.mode = 'onfoot'
    this.rig.snap()
    this.updateHints()
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
    this.hud.setClock(`${j.month}月${j.day}日(${wd})  ${pad(j.hour)}:${pad(j.minute)} JST   ${this.weather.label()}`)
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
      peds: this.crowd.peds.length,
      pedTarget: Math.round(this.crowdTarget),
      pedPerHa: Math.round(this.pedDensity * 10) / 10,
    }
  }

  /** Debug: draw the pedestrian network (green foot, blue sidewalk, yellow road edge, red scramble). */
  debugCrowdLines(): number {
    const d = this.crowd.debugLines()
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(d.pos, 3))
    g.setAttribute('color', new BufferAttribute(d.col, 3))
    const l = new LineSegments(g, new LineBasicMaterial({ vertexColors: true, depthTest: false }))
    l.renderOrder = 999
    this.pipeline.scene.add(l)
    return d.pos.length / 6
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
