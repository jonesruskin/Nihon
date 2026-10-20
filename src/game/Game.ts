// NIHON game orchestrator: boots the world at a real place in Japan, streams
// it in around the player, and runs the frame loop.
import { initGltf } from '../core/gltf'
import { lampUniforms } from '../render/lamps'
import { deviceTier, FrameGovernor, TIERS } from '../render/FrameGovernor'
import { BufferAttribute, BufferGeometry, Color, Frustum, LineBasicMaterial, LineSegments, Matrix4, Raycaster, Sphere, Vector3, type InstancedMesh, type Light, type Mesh, type Object3D } from 'three'
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
import { seasonUniforms } from '../world/props/models'
import { Journal } from '../tourism/Journal'
import { ActivityPanel, SpotIndex, spotPrompt, type Spot } from '../tourism/Activities'
import { Phone } from '../ui/Phone'
import { Soundscape } from '../audio/Soundscape'
import { PlacedProps } from '../world/props/PlacedProps'
import { ForestFill } from '../world/props/ForestFill'
import { NearPeople } from '../people/NearPeople'
import { AddressLookup } from '../core/address'
import { busRule, distanceFare, type BusRule } from '../transit/busFare'
import { FerryTracer, distM, ferryFare, ferrySpeed, type FerryRoute, type LL } from '../transit/ferry'
import { createFerry, type FerryShip } from '../transit/ferryModel'
import { Fireworks } from '../world/Fireworks'
import { festivalsNear, type Festival } from '../data/festivals'
import { airportNear, destinations, flightFare, flightKm, flightMinutes, type Airport } from '../transit/flights'
import { PREFECTURES } from '../data/prefectures'
import { DISCOVERIES } from '../tourism/Journal'
import { TouchControls } from '../ui/TouchControls'
import { BENCH_STOPS, Bench } from './Bench'
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

export type Mode = 'loading' | 'onfoot' | 'driving' | 'passenger' | 'train' | 'ferry' | 'fly'

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
    quality: (q.get('quality') as QualityTier | null) ?? 'high',
    mode: q.get('mode') === 'fly' || altitude > 3 ? 'fly' : 'onfoot',
    character: q.get('char') ?? 'player_m',
  }
}

const REBASE_DISTANCE = 2500

function seasonNow(k: 'bloom' | 'autumn'): number {
  return k === 'bloom' ? seasonUniforms.uBloom.value : seasonUniforms.uAutumn.value
}

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
  private touch: TouchControls
  readonly vehicles: VehicleManager
  readonly traffic: Traffic
  readonly map: MapView
  readonly rail: RailRide
  readonly stationPanel: StationPanel
  readonly crowd = new Crowd()
  readonly weather = new WeatherSystem()
  readonly journal = new Journal()
  readonly spots = new SpotIndex()
  readonly activity: ActivityPanel
  readonly phone: Phone
  readonly sound = new Soundscape()
  readonly placed = new PlacedProps()
  forest!: ForestFill
  readonly fireworks = new Fireworks()
  private festTimer = 0
  private placeWaits = 0
  private festNow: Festival | null = null
  private festNoticed = new Set<string>()
  private forestTimer = 0
  readonly nearPeople: NearPeople
  readonly address = new AddressLookup()
  private currentPref = 0
  private bench = new URLSearchParams(location.search).has('bench') ? new Bench() : null
  private benchSpin = false
  private governor: FrameGovernor
  private ownLamp = { pos: new Vector3(), dir: new Vector3(), color: new Color(1, 0.96, 0.9), intensity: 110, range: 55, outer: 0.5, inner: 0.22 }
  private gpuName = ''
  /** Main-thread ms per frame (smoothed), of which submitting the render; decaying peak. */
  private cpuFrame = 0
  private cpuRender = 0
  private cpuPeak = 0
  private explicitQuality = new URLSearchParams(location.search).has('quality') || this.bench !== null
  private placedTimer = 0
  private nearSpot: Spot | null = null
  private purchases = 0
  private discoverTimer = 0
  private rideTime = 0
  private population: PopulationGrid | null = null
  private crowdTimer = 0
  private crowdTarget = 0
  /** Pedestrians per hectare right here, right now (debug/HUD). */
  pedDensity = 0
  private nearStation: Station | null = null
  private liveTime = !new URLSearchParams(location.search).has('t')
  private stationTimer = 0
  private trainBaseYaw: number | null = null
  /** Money: cash and a Suica-style IC card. */
  wallet = { cash: 30000, ic: 3000 }
  private ride: { car: AICar; kind: 'taxi' | 'bus'; meterM: number; slowS: number; last: Vector3; fare: number; bus?: BusRule; ticket?: number } | null = null
  private hailed: AICar | null = null
  destination: { lat: number; lon: number; label: string } | null = null
  private ferryTracer = new FerryTracer()
  private ferry: { route: FerryRoute; dest: string; pts: LL[]; cum: number[]; total: number; s: number; v: number; vmax: number; ship: FerryShip; head: number; arrived: boolean; t: number } | null = null
  avatar: Person | null = null
  private bento: string | null = null
  private bentoTimer = 0
  private avatarName = ''
  private dressing: Promise<void> | null = null
  private loggedTerrain = false
  private warmFrames = 0
  private dressTimer = 4
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
    this.nearPeople = new NearPeople(this.characters)
    this.pipeline = new RenderPipeline(canvas, this.world)
    initGltf(this.pipeline.renderer)
    // Start at the tier this device can hold at full frame rate.
    const device = deviceTier(this.pipeline.renderer.getContext())
    this.gpuName = device.gpu
    if (!this.explicitQuality) this.params.quality = device.tier
    this.governor = new FrameGovernor(this.explicitQuality ? this.params.quality : device.ceiling)
    this.terrain = new TerrainManager(this.world)
    this.plateau = new PlateauManager(this.world, this.pipeline.camera, this.pipeline.renderer)
    this.vector = new VectorManager(this.world, this.terrain, this.plateau)
    this.vector.lights = this.pipeline.lights
    this.colliders = new WorldColliders(this.physics)
    this.vehicles = new VehicleManager(this.physics, this.vector)
    this.traffic = new Traffic(this.physics, this.vector)
    this.input = new Input(canvas)
    this.touch = new TouchControls(ui, this.input)
    this.player = new Player(this.physics)
    this.rig = new CameraRig(this.pipeline.camera, this.physics)
    const scene = this.pipeline.scene
    this.forest = new ForestFill(this.vector.trees)
    scene.add(this.forest.root, this.fireworks.root)
    this.fireworks.onBoom = (d, big) => this.sound.boom(d, big)
    scene.add(this.terrain.root, this.plateau.root, this.vector.root, this.player.object, this.vehicles.root, this.traffic.root, this.crowd.root, this.weather.precip.mesh, this.placed.root, this.nearPeople.root)
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
      sound: (n) => this.sound.play(n),
      worldReadyAt: (p) => {
        const g = this.world.geodeticFromWorld(p)
        return this.terrain.isDetailedAt(g.lat, g.lon) && this.vector.readyNear(g.lat, g.lon, 400)
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
      ekiben: (name, price) => {
        if (this.bento) {
          this.hud.toast(`You already have a ${this.bento} for the journey.`)
          return false
        }
        if (!this.pay(price, 'ic')) return false
        this.bento = name
        this.bentoTimer = 0
        this.sound.play('ic')
        this.journal.discover('ekiben')
        this.hud.toast(`<b>${name}</b>, wrapped and tied with string. Save it for the train — eating on the platform is not the done thing.`, 6000)
        return true
      },
      close: () => this.stationPanel.hide(),
      here: () => {
        const g = this.world.geodeticFromWorld(this.player.feet)
        return { lat: g.lat, lon: g.lon }
      },
    })
    this.journal.onDiscover = (_id, d) => this.hud.showDiscovery(d)
    this.journal.today = () => {
      const j = this.clock.jst
      return `${j.year}-${String(j.month).padStart(2, '0')}-${String(j.day).padStart(2, '0')}`
    }
    this.hud.setTips([
      ...Object.values(DISCOVERIES).map((d) => ({ head: `${d.ja} ${d.en}`, text: d.text })),
      ...PREFECTURES.map((p) => ({ head: `${p.ja} ${p.en}`, text: p.fact })),
    ])
    this.activity = new ActivityPanel(ui, {
      wallet: () => this.wallet,
      pay: (yen, method) => {
        const ok = this.pay(yen, method)
        if (ok && ++this.purchases === 3) this.journal.discover('bins')
        return ok
      },
      addCash: (yen) => (this.wallet.cash += yen),
      toast: (html, ms) => this.hud.toast(html, ms),
      journal: this.journal,
      hour: () => this.clock.jst.hourFloat,
      temperature: () => this.weather.now.temp,
      raining: () => this.weather.now.rain > 0.2,
      passTime: (min) => this.clock.advance(min * 60),
      sleepUntilMorning: () => {
        const j = this.clock.jst
        const next = fromJst(j.year, j.month, j.day, 7, 0)
        this.clock.set(new Date(next.getTime() + (j.hourFloat >= 7 ? 86400e3 : 0)))
      },
      sound: (n) => this.sound.play(n),
      ferryDepartures: (spot) => this.ferryDepartures(spot.pos),
      flights: (spot) => {
        const g = this.world.geodeticFromWorld(spot.pos)
        const from = airportNear(g.lat, g.lon)
        if (!from) return []
        return destinations(from).map((b) => {
          const km = flightKm(from, b)
          const min = flightMinutes(km)
          return {
            label: b.ja,
            sub: `✈ ${b.code} ${b.en} · ${Math.round(km)} km · ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`,
            price: flightFare(km),
            board: () => void this.fly(from, b),
          }
        })
      },
      prefecture: () => {
        const code = this.address.last?.prefCode
        return PREFECTURES.find((x) => x.code === code) ?? null
      },
    })
    this.phone = new Phone(ui, {
      wallet: () => this.wallet,
      journal: this.journal,
      setHour: (h) => {
        const j = this.clock.jst
        this.clock.set(fromJst(j.year, j.month, j.day, Math.floor(h), Math.round((h % 1) * 60)))
        this.liveTime = false
      },
      setMonth: (m) => {
        const j = this.clock.jst
        this.clock.set(fromJst(j.year, m, Math.min(j.day, 28), j.hour, j.minute))
        this.liveTime = false
      },
      setLive: () => {
        this.clock.set(new Date())
        this.weather.preset = 'live'
        this.liveTime = true
      },
      setWeather: (w) => (this.weather.preset = w),
      setQuality: (q) => {
        this.params.quality = q
        this.applyQuality(q)
      },
      status: () => ({ hour: this.clock.jst.hourFloat, month: this.clock.jst.month, weather: this.weather.preset, quality: this.params.quality, live: this.liveTime }),
    })
    const startAudio = () => {
      this.sound.start()
      window.removeEventListener('pointerdown', startAudio)
      window.removeEventListener('keydown', startAudio)
    }
    window.addEventListener('pointerdown', startAudio)
    window.addEventListener('keydown', startAudio)
    this.placed.onColliders = (c) => {
      this.colliders.removePrefix('placed')
      if (c.length) this.colliders.addCylinders('placed', this.placed.root, c, 1500)
    }
    const probe = new Vector3()
    this.player.canEnter = (x, z) => {
      probe.set(x, this.player.feet.y, z)
      const g = this.world.geodeticFromWorld(probe)
      return !this.terrain.isSea(g.lat, g.lon)
    }
    this.forest.onColliders = (c) => {
      this.colliders.removePrefix('forest')
      if (c.length) this.colliders.addCylinders('forest', this.forest.root, c, 400)
    }
    this.placeScrambles()
    this.traffic.graph.allRed = (pos) =>
      this.crowd.scrambles.some((sc) => sc.walkTime() >= 0 && Math.hypot(pos.x - sc.center.x, pos.z - sc.center.z) < sc.radius + 18)
    this.wireColliders()
    this.world.onRebase((delta) => {
      this.placeScrambles()
      this.rail.snap.invalidate()
      this.crowd.rebase(delta)
      this.spots.invalidate()
      this.placed.invalidate()
      this.forest.invalidate()
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
      group.children.forEach((child, i) => {
        const m = child as Mesh
        if (!m.isMesh || (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return
        if (['buildings', 'roads', 'structures', 'roofs'].includes(m.name)) this.colliders.addMesh(`${key}:${m.name}:${i}`, m)
      })
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
    this.hud.setLoading(0.05, 'Opening the map of Japan…')
    this.applyQuality(p.quality)
    // Only what the first frame needs blocks play. The player's own model
    // starts downloading as soon as the manifest is in.
    const avatar = this.characters.init().then(() => this.dressAvatar())
    const mark = <T,>(n: string, q: Promise<T>) => q.then((v) => (console.info(`[load] ${n}`), v))
    // The sky precompute runs on the GPU while the map streams over the network.
    // (`?skylast` serialises them: software GPUs in CI stall image decoding
    // behind the precompute, which would hide the streaming time we measure.)
    const skyLast = new URLSearchParams(location.search).has('skylast')
    let sky = skyLast ? Promise.resolve() : mark('sky', this.pipeline.init())
    await Promise.all([mark('plateau', this.plateau.init()), mark('physics', this.physics.init())])
    this.hud.setLoading(0.2, 'Reading the terrain (国土地理院)…')
    this.terrain.prefetchChain(p.lat, p.lon)
    await this.terrain.prefetchAround(p.lat, p.lon, 300)
    console.info('[load] elevation')
    const ground = this.terrain.heightAt(p.lat, p.lon)
    const cam = this.pipeline.camera
    cam.position.copy(this.world.worldFromGeodetic(p.lat, p.lon, ground + Math.max(1.7, p.altitude)))
    this.rig.yaw = (-p.heading * Math.PI) / 180
    this.rig.pitch = (p.pitch * Math.PI) / 180
    cam.rotation.set(this.rig.pitch, this.rig.yaw, 0, 'YXZ')
    requestAnimationFrame(this.frame)

    await this.waitForWorld(p.lat, p.lon, 90_000, 0.25)
    this.hud.setLoading(0.95, 'Lighting the sky…')
    if (skyLast) sky = mark('sky', this.pipeline.init())
    await Promise.all([sky, mark('avatar', avatar)])
    if (p.mode === 'onfoot') await this.spawnPlayer(p.lat, p.lon)
    else this.mode = 'fly'
    console.info('[load] spawned')
    this.hud.setLoading(1, '')
    await this.warmUp()
    this.hud.hideLoading()
    this.updateHints()
    // Everything else streams in while the player is already walking.
    void this.crowd.init(Math.ceil(this.crowd.cap / 5)).catch((e) => console.warn('crowd unavailable', e))
    void this.placed.init().catch((e) => console.warn('props unavailable', e))
    void this.rail.load().catch((e) => console.warn('rail network unavailable', e))
    void this.address.load().catch((e) => console.warn('municipality table unavailable', e))
    void PopulationGrid.load()
      .then((g) => (this.population = g))
      .catch((e) => console.warn('population grid unavailable', e))
    if (this.bench) void this.runBench()
  }

  /** Draw a couple of frames under the veil so shaders are compiled before the reveal. */
  private warmUp(): Promise<void> {
    this.warmFrames = 2
    this.pipeline.snapExposure = true
    return new Promise((done) => {
      const check = () => (this.warmFrames > 0 ? requestAnimationFrame(check) : done())
      requestAnimationFrame(check)
    })
  }

  /** Ground under the spot at full detail and the streets within ~600 m:
   *  enough to stand in. Wider rings keep streaming after the veil lifts. */
  private async waitForWorld(lat: number, lon: number, limitMs: number, base: number): Promise<void> {
    const t0 = performance.now()
    const near = 600
    while (performance.now() - t0 < limitMs) {
      const terrainOk = this.terrain.isDetailedAt(lat, lon)
      const vectorOk = this.vector.readyNear(lat, lon, near)
      this.hud.setLoading(
        base + (terrainOk ? 0.35 : 0) + (vectorOk ? 0.3 : 0),
        !terrainOk ? 'Draping aerial photographs on the land…' : !vectorOk ? 'Laying streets, rail and buildings (OpenStreetMap)…' : 'Almost there…',
      )
      if (terrainOk && !this.loggedTerrain) (this.loggedTerrain = true), console.info('[load] terrain')
      if (terrainOk && vectorOk) return console.info(`[load] world ready (${this.pipeline.renderer.info.render.frame} frames)`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  /** ?bench: a turn on the spot at three kinds of place, then a report. */
  private async runBench(): Promise<void> {
    const b = this.bench!
    const r = this.pipeline.renderer
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms))
    r.info.autoReset = false
    for (const stop of BENCH_STOPS) {
      await this.travelTo(stop.lat, stop.lon, undefined, undefined, `Benchmark · ${stop.name}`)
      await wait(6000) // let streaming settle
      this.benchSpin = true
      b.begin()
      await wait(20000)
      b.end(stop.name)
      this.benchSpin = false
    }
    r.info.autoReset = true
    const gpu = this.gpuName || 'GPU unknown'
    const panel = document.createElement('div')
    panel.className = 'bench'
    panel.innerHTML = b.html(this.params.quality, gpu)
    this.hud.root.appendChild(panel)
    ;(window as unknown as { nihonBench: unknown }).nihonBench = { quality: this.params.quality, gpu, results: b.results }
    console.table(b.results)
  }

  /** Rendering + streaming budget per quality tier. */
  applyQuality(q: QualityTier): void {
    this.pipeline.setQuality(q)
    if (this.rail) this.rail.maxAmbient = { low: 2, medium: 3, high: 5, ultra: 7 }[q]
    const c = { low: [75, 70], medium: [100, 170], high: [120, 320], ultra: [150, 520] }[q]
    this.crowd.maxRadius = this.crowd.radius = c[0]
    if (this.nearPeople) this.nearPeople.max = { low: 2, medium: 4, high: 6, ultra: 10 }[q]
    this.crowd.cap = c[1]
    this.weather.budget = { low: 3000, medium: 6000, high: 10000, ultra: 16000 }[q]
    const t = {
      low: { far: 30_000, split: 1.3, near: 800, vfar: 1300, err: 48, pr: 500 },
      medium: { far: 45_000, split: 1.4, near: 1200, vfar: 2000, err: 32, pr: 800 },
      high: { far: 70_000, split: 1.45, near: 1500, vfar: 2600, err: 24, pr: 1100 },
      ultra: { far: 120_000, split: 1.8, near: 1800, vfar: 3200, err: 16, pr: 1600 },
    }[q]
    this.traffic.cap = { low: 50, medium: 90, high: 140, ultra: 180 }[q]
    this.plateau.radius = t.pr
    this.plateau.errorTarget = t.err
    this.terrain.settings.farRadius = t.far
    this.terrain.settings.splitFactor = t.split
    this.vector.nearRadius = t.near
    this.vector.farRadius = t.vfar
  }

  /** Points on streets and footpaths near `at`, nearest first. */
  private walkableNear(at: Vector3, maxDist = 200): Vector3[] {
    const out: { p: Vector3; d: number }[] = []
    const p = new Vector3()
    for (const t of this.vector.readyTiles) {
      t.group.updateWorldMatrix(true, false)
      for (const path of t.build.paths) {
        if (path.kind === 'rail' || path.bridge) continue
        for (let i = 0; i < path.pts.length; i += 3) {
          p.set(path.pts[i], path.pts[i + 1], path.pts[i + 2]).applyMatrix4(t.group.matrixWorld)
          const d = Math.hypot(p.x - at.x, p.z - at.z)
          if (d < maxDist) out.push({ p: p.clone(), d })
        }
      }
    }
    return out.sort((a, b) => a.d - b.d).map((o) => o.p)
  }

  /**
   * Nearest walkable point under open sky: OSM footpaths run through gates,
   * halls and station buildings, and nobody should start inside a wall.
   */
  private nearestWalkable(at: Vector3, maxDist = 200): Vector3 | null {
    const cands = this.walkableNear(at, maxDist)
    if (!cands.length) return null
    this.colliders.activateNow(at)
    this.physics.world.step()
    const up = new Vector3(0, 1, 0)
    let tried = 0
    for (const c of cands) {
      if (tried++ > 60) break
      const roof = this.physics.ray(c.clone().add(new Vector3(0, 0.6, 0)), up, 40)
      if (roof !== null) continue
      // Also keep a little elbow room around the spot.
      let tight = 0
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        const d = this.physics.ray(c.clone().add(new Vector3(0, 1.2, 0)), new Vector3(Math.cos(a), 0, Math.sin(a)), 1.2)
        if (d !== null) tight++
      }
      if (tight <= 2) return c
    }
    return cands[0]
  }

  private async spawnPlayer(lat: number, lon: number): Promise<void> {
    const ground = this.terrain.heightAt(lat, lon)
    let at = this.world.worldFromGeodetic(lat, lon, ground)
    this.pipeline.scene.updateMatrixWorld(true)
    // Dropped at sea (a map click offshore, the torii at Itsukushima): wade
    // ashore to the nearest path instead.
    at = this.nearestWalkable(at) ?? (this.terrain.isSea(lat, lon) ? this.nearestWalkable(at, 1500) : null) ?? at
    this.colliders.activateNow(at)
    // Land on the street surface (or bridge deck) right there.
    const top = this.physics.groundBelow(at.x, at.y + 3, at.z, 10)
    if (top !== null) at.y = top
    this.player.spawn(at.add(new Vector3(0, 0.05, 0)))
    this.faceOpenSpace(at)
    this.player.heading = this.rig.yaw
    await this.dressAvatar()
    this.player.enabled = true
    this.player.object.visible = true
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

  /**
   * Don't start the player nose-to-wall: if the requested heading is blocked
   * within a few metres, turn to the most open direction nearest to it.
   */
  /** Check in, fly, and walk out of the arrivals hall at the other end. */
  private async fly(from: Airport, to: Airport): Promise<void> {
    const min = flightMinutes(flightKm(from, to))
    this.journal.discover('flight')
    this.hud.toast(`Bag drop, a quick security check, and boarding at the gate with a QR code. ✈ ${from.code} → ${to.code}`, 6000)
    // Arrive at the airport ~40 min ahead; the flight itself takes `min`.
    this.clock.advance((min + 40) * 60)
    await this.travelTo(to.lat, to.lon, undefined, undefined, `✈ ${from.ja} → ${to.ja} · ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`)
    this.hud.toast(`Welcome to <b>${to.ja}</b> (${to.en}). Trains, buses and taxis leave from outside arrivals.`, 7000)
  }

  /** Departures from the ferry terminal at a world position, for the ticket window. */
  private async ferryDepartures(at: Vector3): Promise<Array<{ label: string; sub: string; price: number; board: () => void }>> {
    const g = this.world.geodeticFromWorld(at)
    const routes = await this.ferryTracer.departures(g.lat, g.lon)
    return Promise.all(
      routes.map(async (r) => {
        const end = r.pts[r.pts.length - 1]
        // The pier may sit just offshore: look a little way inland too.
        let a = await this.address.lookup(end[0], end[1])
        for (let k = 0; !a && k < 16; k++) {
          const ang = (k % 8) * (Math.PI / 4)
          const m = k < 8 ? 250 : 700
          a = await this.address.lookup(end[0] + (Math.cos(ang) * m) / 111132, end[1] + (Math.sin(ang) * m) / (111412 * Math.cos((end[0] * Math.PI) / 180)))
        }
        const dest = a ? `${a.city}${a.area ? ' ' + a.area : ''}` : `${end[0].toFixed(2)}°N ${end[1].toFixed(2)}°E`
        const min = Math.round((r.km * 1000) / ferrySpeed(r.km) / 60 + 4)
        const dur = min < 90 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
        return {
          label: `${dest} 行き`,
          sub: `${r.name || 'フェリー'}${r.nameEn && r.nameEn !== r.name ? ` · ${r.nameEn}` : ''} · ${r.km < 10 ? r.km.toFixed(1) : Math.round(r.km)} km · ${dur}`,
          price: ferryFare(r.km),
          board: () => this.boardFerry(r, dest),
        }
      }),
    )
  }

  private boardFerry(route: FerryRoute, dest: string): void {
    // Smooth the traced line (Chaikin) so the ship turns rather than pivots.
    let pts = route.pts
    for (let k = 0; k < 2; k++) {
      const out: LL[] = [pts[0]]
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
      }
      out.push(pts[pts.length - 1])
      pts = out
    }
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]))
    const ship = createFerry(route.km, route.pts[0][1])
    this.pipeline.scene.add(ship.group)
    if (this.avatar) {
      this.player.object.remove(this.avatar.object)
      ship.group.add(this.avatar.object)
      this.avatar.object.position.set(ship.deck.x, ship.deck.y, ship.deck.z)
      this.avatar.object.rotation.set(0, Math.PI / 2, 0) // looking out over the rail
      this.avatar.object.visible = true
    }
    this.player.enabled = false
    this.player.object.visible = false
    this.player.body.setEnabled(false)
    this.ferry = { route, dest, pts, cum, total: cum[cum.length - 1], s: 0, v: 0, vmax: ferrySpeed(route.km), ship, head: 0, arrived: false, t: 0 }
    this.mode = 'ferry'
    this.rig.mode = 'third'
    this.journal.discover('ferry')
    this.sound.play('chime')
    this.hud.toast(`乗船 — <b>${route.name || 'The ferry'}</b> for ${dest}. Shoes stay on; on long crossings, passengers stretch out on the carpeted 2等 floor.`, 7000)
    this.updateHints()
  }

  private ferryAt(f: NonNullable<Game['ferry']>, s: number): LL {
    const c = f.cum
    let lo = 0
    let hi = c.length - 1
    s = Math.max(0, Math.min(f.total, s))
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (c[m] <= s) lo = m
      else hi = m
    }
    const t = c[hi] > c[lo] ? (s - c[lo]) / (c[hi] - c[lo]) : 0
    const a = f.pts[lo]
    const b = f.pts[hi]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }

  private updateFerry(dt: number, input: import('../player/Input').Input): void {
    const f = this.ferry!
    f.t += dt
    const remain = f.total - f.s
    // Ease out of the berth, cruise, and slow right down into the far port.
    const acc = 0.22
    const vWant = f.arrived ? 0 : Math.min(f.vmax, Math.sqrt(2 * acc * Math.max(0, remain - 12)) + 0.3)
    f.v += Math.max(-acc * 2 * dt, Math.min(acc * dt, vWant - f.v))
    f.s = Math.min(f.total, f.s + f.v * dt)
    if (remain < 15 && f.v < 0.4) f.arrived = true
    const here = this.ferryAt(f, f.s)
    const ahead = this.ferryAt(f, f.s + 40)
    const behind = this.ferryAt(f, f.s - 40)
    const p = this.world.worldFromGeodetic(here[0], here[1], 0)
    const pa = this.world.worldFromGeodetic(ahead[0], ahead[1], 0)
    const pb = this.world.worldFromGeodetic(behind[0], behind[1], 0)
    const want = Math.atan2(pa.x - pb.x, pa.z - pb.z)
    if (f.t < 0.1) f.head = want
    let d = want - f.head
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    f.head += d * Math.min(1, dt * 0.8)
    // Swell: slow pitch and roll, more on small boats.
    const sw = f.ship.length < 50 ? 1 : f.ship.length < 100 ? 0.6 : 0.3
    const g = f.ship.group
    g.position.set(p.x, p.y + Math.sin(f.t * 0.9) * 0.12 * sw, p.z)
    g.rotation.order = 'YXZ'
    g.rotation.set(Math.sin(f.t * 0.7) * 0.012 * sw, f.head, Math.sin(f.t * 0.53 + 1) * 0.02 * sw)
    g.updateMatrixWorld(true)
    if (this.avatar) this.avatar.update(dt, 0)
    const deck = new Vector3(f.ship.deck.x, f.ship.deck.y + 1.55, f.ship.deck.z).applyMatrix4(g.matrixWorld)
    this.rig.update(dt, { pivot: deck, speed: f.v, stepHz: 0, distance: f.ship.length < 50 ? 7 : 11, shoulder: 0 })
    this.hud.setSpeed(null)
    const km = remain / 1000
    const left = km >= 1 ? `${km.toFixed(km < 10 ? 1 : 0)} km` : `${Math.round(remain)} m`
    const mins = Math.max(1, Math.round(remain / Math.max(f.v, f.vmax * 0.5) / 60))
    this.hud.setPrompt(
      f.arrived
        ? `<kbd>E</kbd>Disembark at <b>${f.dest}</b> <span style="opacity:.7">— hand in your ticket at the gangway</span>`
        : `⛴ <b>${f.route.name || 'Ferry'}</b> → ${f.dest} · ${left} · about ${mins} min${f.total > 1500 ? ' · <kbd>T</kbd>skip ahead' : ''}`,
    )
    if (input.hit('KeyE') && f.arrived) {
      void this.leaveFerry()
      return
    }
    if (input.hit('KeyT') && !f.arrived && f.total > 1500) {
      const end = f.pts[f.pts.length - 1]
      const name = f.route.name || 'Ferry'
      this.endFerry()
      void this.travelTo(end[0], end[1], undefined, undefined, `⛴ ${name} · arriving at ${f.dest}`)
      return
    }
    this.maybeRebase(p)
  }

  /** Remove the ship and put the avatar back on the player. */
  private endFerry(): void {
    const f = this.ferry
    if (!f) return
    if (this.avatar) {
      f.ship.group.remove(this.avatar.object)
      this.player.object.add(this.avatar.object)
      this.avatar.object.position.set(0, 0, 0)
      this.avatar.object.rotation.set(0, 0, 0)
    }
    this.pipeline.scene.remove(f.ship.group)
    f.ship.group.traverse((o) => (o as Mesh).geometry?.dispose())
    this.ferry = null
    this.hud.setPrompt(null)
  }

  private async leaveFerry(): Promise<void> {
    const end = this.ferry!.pts[this.ferry!.pts.length - 1]
    this.endFerry()
    this.player.object.visible = true
    await this.spawnPlayer(end[0], end[1])
    this.updateHints()
  }

  /** Fireworks festivals: an evening notice, then the show itself. */
  private updateFestivals(dt: number): void {
    const cam = this.pipeline.camera
    this.festTimer -= dt
    if (this.festTimer <= 0 && this.mode !== 'loading') {
      this.festTimer = 2
      const g = this.world.geodeticFromWorld(cam.position)
      const j = this.clock.jst
      const near = festivalsNear(g.lat, g.lon, j.year, j.month, j.day, j.weekday, j.hourFloat, 30, 4)
      const f = near[0] ?? null
      this.festNow = f && j.hourFloat >= f.from ? f : null
      if (f) {
        const key = `${f.ja}${j.year}-${j.month}-${j.day}`
        const km = Math.hypot((f.lat - g.lat) * 111.13, (f.lon - g.lon) * 111.41 * Math.cos((g.lat * Math.PI) / 180))
        if (!this.festNoticed.has(key)) {
          this.festNoticed.add(key)
          const hh = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
          this.hud.toast(`🎆 ${this.festNow ? 'Now' : 'Tonight'}: <b>${f.ja}</b> ${hh(f.from)}–${hh(f.to)}, ${km < 1 ? 'right here' : `${km.toFixed(km < 10 ? 1 : 0)} km away`}. ${f.blurb}`, 11000)
        }
        if (this.festNow && km < 15) this.journal.discover('hanabi')
      }
    }
    const f = this.festNow
    let origin: Vector3 | null = null
    if (f) {
      const h = this.terrain.heightAt(f.lat, f.lon)
      origin = this.world.worldFromGeodetic(f.lat, f.lon, Number.isFinite(h) ? Math.max(0, h) : 0)
    }
    this.fireworks.setScale(this.pipeline.renderer.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360)))
    this.fireworks.update(dt, f, origin, f ? f.to - this.clock.jst.hourFloat : 0, cam.position)
  }

  /** Fill the woods around the player at real forest density. */
  private updateForest(at: Vector3): void {
    const probe = new Vector3()
    this.forest.update(
      at,
      this.vector.readyTiles,
      (x, z) => {
        probe.set(x, at.y, z)
        const g = this.world.geodeticFromWorld(probe)
        const h = this.terrain.heightAt(g.lat, g.lon)
        return Number.isFinite(h) ? this.world.worldFromGeodetic(g.lat, g.lon, h).y : null
      },
      (x, y, z) => {
        const top = this.physics.groundBelow(x, y + 30, z, 60)
        return top !== null && top > y + 1.5
      },
    )
  }

  /** The tourist dresses for the weather too: a jacket and long sleeves
   *  below ~15°C, a T-shirt above ~18°C (in between, keep what you wear). */
  private dressAvatar(): Promise<void> {
    if (this.dressing) return this.dressing
    this.dressing = this.dressAvatarNow().finally(() => (this.dressing = null))
    return this.dressing
  }

  private async dressAvatarNow(): Promise<void> {
    if (!this.characters.manifest.length) return
    const base = this.params.character.replace(/_w$/, '')
    const winterName = `${base}_w`
    const hasWinter = this.characters.manifest.some((m) => m.name === winterName)
    const T = this.weather.now.temp
    const cur = this.avatarName
    let want = cur
    if (!hasWinter) want = base
    else if (!cur) want = T < 16.5 ? winterName : base
    else if (T < 15) want = winterName
    else if (T > 18) want = base
    if (want === this.avatarName && this.avatar) return
    try {
      const next = await this.characters.create(want)
      if (this.avatar) {
        next.object.visible = this.avatar.object.visible
        this.player.object.remove(this.avatar.object)
      }
      this.avatar = next
      this.avatarName = want
      this.player.object.add(next.object)
    } catch (e) {
      console.warn('avatar failed', want, e)
    }
  }

  private faceOpenSpace(at: Vector3): void {
    this.physics.world.step()
    const eye = at.clone().add(new Vector3(0, 1.6, 0))
    const free = (yaw: number) => this.physics.ray(eye, new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), 60) ?? 60
    if (free(this.rig.yaw) > 12) return
    let best = this.rig.yaw
    let score = -Infinity
    for (let i = 1; i < 24; i++) {
      const yaw = this.rig.yaw + (i * Math.PI * 2) / 24
      const d = free(yaw)
      const turn = Math.min(i, 24 - i) / 12
      const sc = Math.min(d, 40) - turn * 6
      if (sc > score) {
        score = sc
        best = yaw
      }
    }
    this.rig.yaw = best
  }

  private updateHints(): void {
    const v = this.rig.mode === 'first' ? '1st person' : '3rd person'
    this.hud.setHints(
      this.mode === 'fly'
        ? '<kbd>WASD</kbd>fly <kbd>Q/E</kbd>down/up <kbd>Shift</kbd>fast <kbd>G</kbd>land'
        : this.mode === 'ferry'
          ? `<kbd>T</kbd>skip ahead <kbd>V</kbd>${v} <kbd>E</kbd>disembark (in port)`
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
    const cpu0 = performance.now()
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
    if (input.hitAlways('Tab')) {
      this.phone.toggle()
      if (this.phone.open) document.exitPointerLock?.()
    }
    if (input.hitAlways('KeyP') && !this.stationPanel.open && !this.activity.open) document.body.classList.toggle('photo-mode')
    if (document.body.classList.contains('photo-mode') && input.hitAlways('Space')) this.snapPhoto()
    input.enabled = !this.map.open && !this.stationPanel.open && !this.activity.open && !this.phone.open && this.mode !== 'loading'
    if (input.hitAlways('Escape')) {
      this.stationPanel.hide()
      this.activity.hide()
      if (this.phone.open) this.phone.toggle()
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
        let busNote = ''
        if (!taxi) {
          const a = this.address.last
          const rule = busRule(a)
          busNote = rule.payment === 'flat-front' ? `¥${rule.fare} flat · front door, pay now` : rule.payment === 'flat-exit' ? `¥${rule.fare} flat · pay when you get off` : 'rear door · take a 整理券 or tap IC'
        }
        this.hud.setPrompt(taxi ? '<kbd>E</kbd>Get in the taxi <span style="opacity:.7">— the rear door opens by itself</span>' : `<kbd>E</kbd>Board the bus <span style="opacity:.7">${busNote}</span>`)
        if (input.hit('KeyE')) this.board(boardable)
      } else if (car) {
        this.hud.setPrompt(`<kbd>E</kbd>Drive the ${car.spec.label} <span style="opacity:.7">${car.spec.labelJa}</span>`)
        if (input.hit('KeyE')) this.enterVehicle(car)
      } else {
        this.stationTimer -= dt
        if (this.stationTimer <= 0) {
          this.stationTimer = 0.4
          const g = this.world.geodeticFromWorld(feet)
          this.nearStation = this.rail.stationNear(g.lat, g.lon)
          this.spots.update(this.vector.readyTiles)
          this.nearSpot = this.spots.nearest(feet)
        }
        const st = this.nearStation
        const spot = this.nearSpot
        // A spot right here (vending machine, shop door) wins over the station nearby.
        if (spot && (!st || spot.kind === 'vending' || Math.hypot(spot.pos.x - feet.x, spot.pos.z - feet.z) < 10)) {
          this.hud.setPrompt(spotPrompt(spot))
          if (input.hit('KeyE')) {
            document.exitPointerLock?.()
            this.activity.show(spot)
          }
        } else {
          this.hud.setPrompt(st ? `<kbd>E</kbd>Enter <b>${st.ja}駅</b> <span style="opacity:.75">${st.en ? st.en + ' Station' : ''} · ${this.stationModes(st)}</span>` : null)
          if (st && input.hit('KeyE')) {
            document.exitPointerLock?.()
            this.stationPanel.show(st)
            this.collectStationStamp(st)
          }
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
    } else if (this.mode === 'ferry' && this.ferry) {
      this.updateFerry(dt, input)
    } else if (this.mode === 'fly') {
      this.updateFly(dt)
      this.maybeRebase(cam.position)
    }

    if (this.mode === 'onfoot' || this.mode === 'driving' || this.mode === 'passenger' || this.mode === 'train' || this.mode === 'ferry') {
      const focus = this.mode === 'train' || this.mode === 'ferry' ? cam.position : this.mode === 'driving' && this.vehicles.current ? this.vehicles.current.position : this.ride ? this.ride.car.pos : this.player.feet
      this.traffic.playerPos = this.mode === 'onfoot' ? this.player.feet : null
      this.traffic.playerCar = this.mode === 'driving' && this.vehicles.current ? { pos: this.vehicles.current.position, length: this.vehicles.current.spec.length } : null
      this.traffic.camPos.copy(cam.position)
      cam.getWorldDirection(this.traffic.camDir)
      this.traffic.night = this.pipeline.night
      this.traffic.update(dt, focus, this.clock.jst.hourFloat)
      // Moving lights for the shader-lamp pool: your own headlights first.
      const dyn = this.pipeline.lights.dynamic
      dyn.length = 0
      const own = this.mode === 'driving' ? this.vehicles.current : null
      if (own) {
        const fwd = this.ownLamp.dir.set(0, 0, -1).applyQuaternion(own.quaternion)
        this.ownLamp.pos.copy(own.position).addScaledVector(fwd, own.spec.length / 2 + 0.3)
        this.ownLamp.pos.y += 0.75
        fwd.y -= 0.1
        fwd.normalize()
        dyn.push(this.ownLamp)
      }
      dyn.push(...this.traffic.headlamps)
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
      this.crowd.temperature = this.weather.now.temp
      if ((this.dressTimer -= dt) < 0) {
        this.dressTimer = 4
        void this.dressAvatar()
      }
    }
    this.updateFestivals(dt)
    this.pipeline.update(dt, focus)
    updateWater(this.elapsed)
    buildingUniforms.uNight.value = night
    buildingUniforms.uTime.value = this.elapsed
    // Dynamic resolution, then quality tier, to hold the display's refresh
    // rate (90 FPS on fast screens). An explicit ?quality= pins the tier.
    if (this.mode !== 'loading' && !this.hud.veiled && this.elapsed > 4 && !this.bench) {
      const step = this.governor.sample(realDt, this.params.quality)
      if (step?.scale !== undefined) this.pipeline.setRenderScale(step.scale)
      if (step?.tier && !this.explicitQuality) {
        const down = TIERS.indexOf(step.tier) < TIERS.indexOf(this.params.quality)
        this.params.quality = step.tier
        this.applyQuality(step.tier)
        if (down) this.hud.toast(`Graphics set to <b>${step.tier}</b> to keep the frame rate up (<kbd>Tab</kbd> → 設定 to change).`, 5000)
      }
    }
    this.placedTimer -= dt
    if (this.placedTimer <= 0 && this.mode !== 'loading') {
      this.placedTimer = 3
      this.placed.update(this.vector.readyTiles, focus)
    }
    this.forestTimer -= dt
    if (this.forestTimer <= 0 && this.mode !== 'loading' && this.mode !== 'train') {
      this.forestTimer = 0.5
      this.updateForest(focus)
    }
    this.updateDiscoveries(dt)
    this.updateSound(dt)
    if (this.liveTime && Math.abs(this.clock.date.getTime() - Date.now()) > 120_000 && this.mode !== 'train') this.liveTime = false
    if (this.benchSpin) this.rig.yaw += dt * ((Math.PI * 2) / 20)
    // Behind the opaque loading screen, drawing the world only steals time
    // from streaming it (warm-up frames compile shaders before the reveal).
    if (!this.hud.veiled || this.warmFrames > 0) {
      if (this.warmFrames > 0) this.warmFrames--
      const r0 = performance.now()
      this.pipeline.render(dt)
      this.cpuRender += (performance.now() - r0 - this.cpuRender) * 0.05
    }
    const used = performance.now() - cpu0
    this.cpuFrame += (used - this.cpuFrame) * 0.05
    this.cpuPeak = Math.max(this.cpuPeak * 0.995, used)
    if (this.bench) {
      const info = this.pipeline.renderer.info
      this.bench.sample(realDt, info.render.calls, info.render.triangles)
      info.reset()
    }
    this.updateHud(dt)
    input.endFrame()
  }

  private lookIdle = 0

  private collectStationStamp(st: Station): void {
    const net = this.rail.net!
    const line = net.lines[st.line]
    if (this.journal.stamp({ kind: 'eki', id: String(st.group), name: st.ja, sub: st.en || line.ja, color: line.color })) {
      this.journal.discover('ekistamp')
      this.hud.toast(`You press the <b>${st.ja}駅</b> stamp into your book. (<kbd>Tab</kbd> phone → スタンプ)`, 4500)
    }
  }

  /** Things you learn simply by being there at the right moment. */
  private updateDiscoveries(dt: number): void {
    this.discoverTimer -= dt
    if (this.discoverTimer > 0 || this.mode === 'loading') return
    this.discoverTimer = 1
    const J = this.journal
    const w = this.weather
    const j = this.clock.jst
    const here = this.mode === 'onfoot' ? this.player.feet : this.pipeline.camera.position
    if (this.mode === 'onfoot' && w.now.rain > 0.3) J.discover('umbrella')
    if (w.snowCover > 0.5) J.discover('snow')
    if ((w.now.wind > 15 && w.now.rain > 5) || w.preset === 'typhoon') J.discover('typhoon')
    if (j.month === 6 && w.now.rain > 0.3 && w.preset === 'live') J.discover('tsuyu')
    if (this.pipeline.night > 0.8 && this.pipeline.lights.urban > 0.4 && this.mode === 'onfoot') J.discover('night')
    if (seasonNow('bloom') > 0.5 && this.mode === 'onfoot') J.discover('sakura')
    if (seasonNow('autumn') > 0.5 && this.mode === 'onfoot') J.discover('koyo')
    if (this.mode === 'onfoot' && this.crowd.scrambles.some((s) => s.walkTime() >= 0 && Math.hypot(here.x - s.center.x, here.z - s.center.z) < 35)) J.discover('scramble')
    if (this.mode === 'train') {
      this.rideTime += 1
      if (this.rideTime > 45) J.discover('quiet')
      if (j.weekday > 0 && j.weekday < 6 && j.hourFloat > 7.3 && j.hourFloat < 9.5) J.discover('rush')
    }
    if (this.mode === 'driving') {
      J.discover('keepleft')
      if (this.vehicles.current?.spec.id.startsWith('kei')) J.discover('driving')
    }
  }

  private updateSound(dt: number): void {
    const here = this.mode === 'onfoot' ? this.player.feet : this.pipeline.camera.position
    let people = 0
    for (const p of this.crowd.peds) if (Math.abs(p.pos.x - here.x) < 40 && Math.abs(p.pos.z - here.z) < 40) people++
    const j = this.clock.jst
    const summer = j.month >= 7 && j.month <= 8 && j.hourFloat > 6 && j.hourFloat < 18.5 && this.weather.now.rain < 0.1
    const run = this.rail.run
    this.sound.update(dt, {
      urban: this.pipeline.lights.urban || 0.3,
      people,
      rain: this.weather.rainFactor,
      wind: this.weather.now.wind,
      cicadas: summer ? 1 - this.pipeline.lights.urban * 0.6 : 0,
      crossing: this.crowd.scrambles.some((s) => s.walkTime() >= 0 && Math.hypot(here.x - s.center.x, here.z - s.center.z) < 90),
      train: this.mode === 'train' && run ? run.v : -1,
      underground: !!run?.underground && this.mode === 'train',
      indoor: this.pipeline.indoor,
    })
  }

  /** Photo mode: save the current frame as a PNG. */
  private snapPhoto(): void {
    const c = this.pipeline.renderer.domElement
    const a = document.createElement('a')
    const j = this.clock.jst
    a.download = `nihon-${j.year}${String(j.month).padStart(2, '0')}${String(j.day).padStart(2, '0')}-${String(j.hour).padStart(2, '0')}${String(j.minute).padStart(2, '0')}.png`
    // The drawing buffer isn't preserved between frames (faster on most
    // GPUs): draw one now and read it back in the same task.
    this.pipeline.render(0)
    a.href = c.toDataURL('image/png')
    a.click()
    const f = document.createElement('div')
    f.className = 'flash go'
    this.ui.appendChild(f)
    requestAnimationFrame(() => {
      f.classList.remove('go')
      setTimeout(() => f.remove(), 600)
    })
  }

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
      // A fireworks night: the riverbanks fill from an hour or two before.
      const fest = festivalsNear(g.lat, g.lon, j.year, j.month, j.day, j.weekday, j.hourFloat, 2.5, 1.5)[0]
      if (fest) this.pedDensity = Math.min(400, this.pedDensity * 3 + 40)
    }
    this.crowd.player = this.mode === 'onfoot' && this.player.body ? this.player.feet : null
    this.crowd.update(dt, at, this.pedDensity)
    this.crowdTarget = this.crowd.target
    if (this.nearPeople.max > 0) this.nearPeople.update(dt, this.pipeline.camera.position, this.crowd.nearest(this.pipeline.camera.position, this.nearPeople.max + 2))
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
    this.rideTime = 0
    this.sound.play('ic')
    this.journal.discover('ic')
    this.journal.discover('train')
    if (route.legs.some((l) => l.line.kind === 'shinkansen')) this.journal.discover('shinkansen')
    if (route.legs.some((l) => l.line.kind === 'metro')) this.journal.discover('subway')
    setTimeout(() => this.journal.discover('melody'), 25000)
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
    // A long ride and a bento: open it once the train is under way.
    if (this.bento && this.rail.run?.state === 'run' && (this.bentoTimer += dt) > 20) {
      this.hud.toast(`いただきます — you untie the string and open your <b>${this.bento}</b>. On long-distance trains, eating at your seat is perfectly normal; take the box with you when you leave.`, 8000)
      this.bento = null
    }
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
  /** Debug: run the fireworks for a few seconds now and look toward them. */
  debugFireworks(seconds = 6): string {
    this.festTimer = 0
    this.updateFestivals(0)
    const f = this.festNow
    if (!f) return 'no festival'
    const cam = this.pipeline.camera
    const h = this.terrain.heightAt(f.lat, f.lon)
    const o = this.world.worldFromGeodetic(f.lat, f.lon, Number.isFinite(h) ? Math.max(0, h) : 0)
    for (let t = 0; t < seconds; t += 0.05) this.fireworks.update(0.05, f, o, f.to - this.clock.jst.hourFloat, cam.position)
    this.rig.yaw = Math.atan2(-(o.x - cam.position.x), -(o.z - cam.position.z))
    this.rig.pitch = 0.32
    return `${f.ja} ${Math.round(o.distanceTo(cam.position))} m`
  }

  /** Debug: board the i-th departure from the nearest ferry terminal. */
  async debugFerry(i = 0): Promise<string> {
    this.spots.update(this.vector.readyTiles)
    const here = this.player.feet
    const t = this.spots.spots.filter((s) => s.kind === 'ferry').sort((a, b) => a.pos.distanceTo(here) - b.pos.distanceTo(here))[0]
    if (!t) return 'no terminal'
    const deps = await this.ferryDepartures(t.pos)
    if (!deps[i]) return 'no departures'
    deps[i].board()
    return `${t.name}: ${deps.map((d) => d.label + ' ' + d.sub + ' ¥' + d.price).join(' | ')}`
  }

  /** Debug: jump the ferry to s metres from the far pier. */
  debugFerryNear(m = 120): void {
    const f = this.ferry
    if (!f) return
    f.s = Math.max(0, f.total - m)
    if (m <= 0) {
      f.v = 0
      f.arrived = true
    }
  }

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
    let bus: BusRule | undefined
    let ticket: number | undefined
    if (kind === 'bus') {
      const g = this.world.geodeticFromWorld(c.pos)
      bus = busRule(this.address.query(g.lat, g.lon))
      if (bus.payment === 'flat-front') {
        if (!this.pay(bus.fare, 'ic')) return
        this.hud.toast(`ピッ — ¥${bus.fare} from your IC card. ${bus.area} buses charge one flat fare: board at the front and pay as you get on (前乗り先払い).`, 7000)
      } else if (bus.payment === 'flat-exit') {
        this.hud.toast(`Board through the middle door. ${bus.area} buses are a flat <b>¥${bus.fare}</b>, paid at the front by the driver when you get off (後払い).`, 7000)
      } else {
        ticket = 1 + Math.floor(Math.random() * 7)
        this.hud.toast(`Board at the rear and tap your IC card — or take a numbered ticket, <b>整理券 ${ticket}</b>. The fare board above the driver shows what each number owes; pay at the front when you get off.`, 8000)
      }
    } else {
      c.vacant = false
      c.hailed = false
      this.hailed = null
      this.hud.toast(this.destination ? `「<b>${this.destination.label}</b>までお願いします」— Please take me to ${this.destination.label}.` : 'The driver asks 「どちらまで？」 (Where to?) — open the map (<kbd>M</kbd>) and choose <b>Set destination</b>.', 7000)
    }
    c.passengerAboard = true
    c.stopTimer = 0
    this.journal.discover(kind === 'taxi' ? 'taxi' : 'bus')
    if (kind === 'bus') this.journal.discover('ic')
    this.ride = { car: c, kind, meterM: 0, slowS: 0, last: c.pos.clone(), fare: kind === 'taxi' ? 500 : bus!.fare, bus, ticket }
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
      const rule = r.bus!
      r.meterM += moved
      if (rule.payment === 'distance') r.fare = distanceFare(r.meterM / 1000)
      // What the fare board (運賃表) above the driver shows for your ticket.
      const board =
        rule.payment === 'distance'
          ? `<span style="opacity:.75">運賃表 整理券</span> <b>${r.ticket}</b> → <b>¥${r.fare.toLocaleString()}</b> · `
          : rule.payment === 'flat-exit'
            ? `<span style="opacity:.75">運賃</span> <b>¥${r.fare}</b> · `
            : ''
      this.hud.setPrompt(
        board +
          (c.stopTimer > 0
            ? `<kbd>E</kbd>Get off here${rule.payment === 'flat-front' ? '' : ' and pay'} <span style="opacity:.7">次は… (next stop)</span>`
            : '<span style="opacity:.8">Riding the bus — press the stop button (<kbd>E</kbd>) to get off at the next stop</span>'),
      )
      if (input.hit('KeyE') && c.stopTimer > 0) {
        if (rule.payment !== 'flat-front') {
          if (!this.pay(r.fare, 'ic')) return
          this.hud.toast(`ピッ — paid <b>¥${r.fare.toLocaleString()}</b> at the front. 「ありがとうございました」`)
        }
        this.leaveRide()
      }
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
    this.terrain.prefetchChain(lat, lon)
    await this.terrain.prefetchAround(lat, lon, 300).catch(() => {})
    const ground = this.terrain.heightAt(lat, lon)
    const cam = this.pipeline.camera
    cam.position.copy(this.world.worldFromGeodetic(lat, lon, (Number.isNaN(ground) ? 0 : ground) + 1.7))
    if (heading !== undefined) this.rig.yaw = (-heading * Math.PI) / 180
    await this.waitForWorld(lat, lon, 60_000, 0.2)
    this.player.body?.setEnabled(true)
    await this.spawnPlayer(lat, lon)
    await this.warmUp()
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
    this.touch.update()
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
    const addr = this.mode === 'fly' ? null : this.address.query(g.lat, g.lon)
    if (addr && addr.prefCode !== this.currentPref) {
      const first = this.currentPref === 0
      this.currentPref = addr.prefCode
      const pref = PREFECTURES.find((x) => x.code === addr.prefCode)
      if (pref) {
        this.journal.visit(pref.ja)
        setTimeout(() => this.hud.showPrefecture(pref, this.journal.data.places.filter((pl) => PREFECTURES.some((x) => x.ja === pl)).length), first ? 6000 : 500)
      }
    }
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
    // The exact ward comes from GSI's reverse geocoder; give it a moment
    // rather than guessing from overlapping city boxes.
    const fresh = addr && this.address.query(g.lat, g.lon) === addr && Math.abs(this.address.lastLat - g.lat) + Math.abs(this.address.lastLon - g.lon) < 0.01
    if (!fresh && this.mode !== 'fly' && this.placeWaits++ < 4) return
    this.placeWaits = 0
    this.currentPlace = best.name
    const city = this.plateau.citiesAt(g.lat, g.lon)[0]
    this.hud.showPlace({
      kanji: best.name,
      reading: best.reading,
      romaji: best.romaji || best.nameEn,
      sub: fresh && addr ? `${addr.pref} ${addr.city}` : city?.pref,
    })
  }

  /** QA: what one frame costs (gate F budgets), measured over the next frame. */
  budget(): Promise<Record<string, number | string>> {
    const r = this.pipeline.renderer
    return new Promise((done) => {
      requestAnimationFrame(() => {
        r.info.autoReset = false
        r.info.reset()
        // Attribute every draw call of the next frame to what issued it.
        const by: Record<string, number> = {}
        const orig = r.renderBufferDirect
        r.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
          let top: Object3D = obj
          while (top.parent && top.parent.type !== 'Scene') top = top.parent
          const pass = (mat as { isMeshDepthMaterial?: boolean }).isMeshDepthMaterial || (mat as { isMeshDistanceMaterial?: boolean }).isMeshDistanceMaterial ? 'shadow' : obj.type === 'Mesh' && !top.parent ? 'post' : 'main'
          const k = `${pass}:${top.name || top.type}/${obj.name.replace(/[:\d].*$/, '') || obj.type}`
          by[k] = (by[k] ?? 0) + 1
          return orig.call(this, cam, scene, geo, mat, obj, group)
        }
        requestAnimationFrame(() => {
          r.renderBufferDirect = orig
          const { calls, triangles, lines } = r.info.render
          r.info.autoReset = true
          const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k, v]) => `${v} ${k}`).join(', ')
          let lights = 0
          let casters = 0
          let casterTris = 0
          this.pipeline.scene.traverseVisible((o) => {
            if ((o as Light).isLight && (o as Light).intensity > 0) lights++
            const m = o as Mesh
            if (m.isMesh && m.castShadow) {
              casters++
              const g = m.geometry
              const n = (g.index ? g.index.count : g.attributes.position.count) / 3
              casterTris += n * ((m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1)
            }
          })
          done({ calls, triangles, lines, programs: r.info.programs?.length ?? 0, textures: r.info.memory.textures, lights, casters, casterTris: Math.round(casterTris), quality: this.params.quality, scale: this.governor.scale, lamps: lampUniforms.uLampCount.value, top })
        })
      })
    })
  }

  /** QA: draws and triangles the main view would submit, by kind (frustum-tested). */
  debugDraws(): Record<string, string> {
    const cam = this.pipeline.camera
    cam.updateMatrixWorld()
    const fr = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
    const out: Record<string, [number, number]> = {}
    const sphere = new Sphere()
    this.pipeline.scene.traverseVisible((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      if (m.frustumCulled !== false) {
        const bs = (m as unknown as { boundingSphere?: Sphere | null }).boundingSphere ?? (m.geometry.boundingSphere || (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere))
        if (bs && !fr.intersectsSphere(sphere.copy(bs).applyMatrix4(m.matrixWorld))) return
      }
      const g = m.geometry
      const tris = ((g.index ? g.index.count : g.attributes.position.count) / 3) * ((m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1)
      let top: Object3D = m
      while (top.parent && top.parent !== this.pipeline.scene) top = top.parent
      const k = `${top.name || top.type}/${m.name.replace(/[:\d].*$/, '') || m.type}`
      const e = (out[k] ??= [0, 0])
      e[0] += Array.isArray(m.material) ? m.material.length : 1
      e[1] += tris
    })
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1][0] - a[1][0]).map(([k, [c, t]]) => [k, `${c} draws ${Math.round(t / 1000)}k`]))
  }

  /** Debug/test helper. */
  stats(): Record<string, number | string> {
    return {
      fps: Math.round(this.fps),
      gameTime: Math.round(this.elapsed * 10) / 10,
      cpuMs: Math.round(this.cpuFrame * 10) / 10,
      cpuRenderMs: Math.round(this.cpuRender * 10) / 10,
      cpuPeakMs: Math.round(this.cpuPeak * 10) / 10,
      mode: this.mode,
      terrainReady: this.terrain.readyCount,
      terrainVisible: this.terrain.visibleCount,
      pending: pendingRequests(),
      vectorTiles: this.vector.loadedCount,
      vectorPending: this.vector.pending,
      physics: this.physics.staticCount,
      settled: Number(this.mode !== 'loading' && this.elapsed > 8 && pendingRequests() === 0),
      peds: this.crowd.peds.length,
      cars: this.traffic.cars.length,
      carsNear: this.traffic.cars.filter((c) => c.pos.distanceTo(this.pipeline.camera.position) < 150).length,
      carModels: this.traffic.cars.filter((c) => c.model).length,
      carTarget: this.traffic.targetCount(),
      pedTarget: Math.round(this.crowdTarget),
      pedPerHa: Math.round(this.pedDensity * 10) / 10,
      forestTrees: this.forest.count,
    }
  }

  /** Debug: draw the pedestrian network (green foot, blue sidewalk, yellow road edge, red scramble). */
  /** Debug: what is under a screen point (normalised device coords)? */
  debugPickScreen(nx: number, ny: number): string[] {
    const rc = new Raycaster()
    rc.setFromCamera({ x: nx, y: ny } as never, this.pipeline.camera)
    const shown = (o: import('three').Object3D | null): boolean => !o || (o.visible && shown(o.parent))
    return rc.intersectObjects(this.pipeline.scene.children, true).filter((h) => shown(h.object)).slice(0, 6).map((h) => {
      const names: string[] = []
      for (let o: import('three').Object3D | null = h.object; o; o = o.parent) if (o.name) names.push(o.name)
      return `${h.distance.toFixed(1)}m ${names.join(' < ')}`
    })
  }

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
