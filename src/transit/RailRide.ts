// Riding trains: from the ticket gate to the platform, aboard the train as
// it runs along the real line through the streamed world, announcements and
// the in-car LCD, transfers, skipping ahead, and stepping off with an IC
// card tap-out at the destination.
import { Group, Mesh, PointLight, SpotLight, Vector3, type Scene } from 'three'
import type { WorldFrame } from '../core/frame'
import type { TerrainManager } from '../world/terrain/TerrainManager'
import type { VectorManager } from '../world/vector/VectorManager'
import type { Hud } from '../ui/Hud'
import { fareFor, RailNetwork, type Leg, type Route, type Station } from './RailNetwork'
import { RailSnap } from './RailSnap'
import { TrainRun } from './TrainRun'
import { buildInterior } from './interior'
import { cutawayMaterial } from './trainModels'
import { buildStationHall, TunnelSleeve } from './underground'

export type RideView = 'seat' | 'cab' | 'outside'

export interface RideHost {
  world: WorldFrame
  terrain: TerrainManager
  vector: VectorManager
  scene: Scene
  hud: Hud
  ui: HTMLElement
  /** Advance the in-game clock (skipping ahead takes real travel time). */
  advanceClock: (seconds: number) => void
  payIC: (yen: number) => boolean
  /** Ride over: put the player on foot at this station. */
  finish: (station: Station) => void
  /** Show/hide a loading veil while the world streams in after a skip. */
  veil: (text: string | null) => void
  worldReadyAt: (p: Vector3) => boolean
  sound: (name: 'melody' | 'doors' | 'chime') => void
}

export class RailRide {
  net: RailNetwork | null = null
  readonly snap = new RailSnap()
  readonly root = new Group()
  route: Route | null = null
  legIndex = 0
  run: TrainRun | null = null
  view: RideView = 'seat'
  private interior: Group | null = null
  private rideCar = 1
  private lamps: PointLight[] = []
  private headlight = new SpotLight(0xfff4e0, 0, 160, 0.32, 0.55, 1.6)
  private skipRequest: 'next' | 'all' | null = null
  private tunnel = new TunnelSleeve()
  private halls = new Map<number, Group>()
  private lcd: HTMLDivElement
  private lcdLang = 0
  private lcdTimer = 0
  private skipping = false
  private travelled = 0 // metres ridden, for the tap-out fare
  private lastS = 0
  private announced = -1

  constructor(private host: RideHost) {
    host.scene.add(this.root)
    this.root.add(this.tunnel.mesh, this.tunnel.lamps)
    for (let i = 0; i < 3; i++) {
      const l = new PointLight(0xf2f5ff, 0, 9, 1.6)
      this.lamps.push(l)
      host.scene.add(l)
    }
    host.scene.add(this.headlight, this.headlight.target)
    this.lcd = document.createElement('div')
    this.lcd.className = 'lcd'
    host.ui.appendChild(this.lcd)
  }

  async load(): Promise<void> {
    this.net = await RailNetwork.load()
  }

  get active(): boolean {
    return this.run !== null
  }

  /** Station complexes within walking distance of a point. */
  stationNear(lat: number, lon: number, radius = 170): Station | null {
    if (!this.net) return null
    const hit = this.net.nearby(lat, lon, radius)[0]
    return hit ? hit.station : null
  }

  begin(route: Route): void {
    this.route = route
    this.legIndex = 0
    this.travelled = 0
    this.startLeg(route.legs[0])
  }

  private startLeg(leg: Leg): void {
    const net = this.net!
    this.disposeRun()
    const run = new TrainRun(net, leg.line, leg.links, leg.stations, this.host.world, this.host.terrain, this.snap)
    this.run = run
    this.lastS = run.s
    this.announced = -1
    this.root.add(run.group)
    // Ride in the second car (or the only one).
    this.rideCar = Math.min(run.cars.length - 1, run.cars.length > 2 ? 2 : 0)
    const car = run.cars[this.rideCar]
    const body = car.group.userData.body as Mesh
    body.material = cutawayMaterial(run.style)
    this.interior = buildInterior(run.style, car.length)
    car.group.children[0].add(this.interior)
    run.onArrive = (stop, i) => this.arrive(stop.station, i)
    run.onDepart = () => {
      this.host.sound('melody')
      setTimeout(() => this.host.sound('doors'), 2800)
      this.host.hud.toast('♪ <b>ドアが閉まります。</b> The doors are closing.', 2500)
    }
    run.update(0)
    const first = net.stations[leg.stations[0]]
    const last = net.stations[leg.stations[leg.stations.length - 1]]
    const kind = leg.line.kind === 'shinkansen' ? 'Shinkansen' : leg.line.kind === 'metro' ? 'subway' : 'train'
    this.host.hud.toast(
      `<b>${leg.line.ja}</b> ${leg.line.en ? `· ${leg.line.en}` : ''}<br>This ${kind} is bound for <b>${last.ja}</b> (${last.en || last.kana}). ${first.ja} → ${leg.stations.length - 1} stops.`,
      6000,
    )
    this.lcd.style.setProperty('--c', leg.line.color)
    this.lcd.classList.add('show')
  }

  private disposeRun(): void {
    if (!this.run) return
    this.run.dispose()
    this.run = null
    this.interior = null
    this.tunnel.hide()
    for (const h of this.halls.values()) h.removeFromParent()
    this.halls.clear()
  }

  end(): void {
    this.disposeRun()
    this.route = null
    this.lcd.classList.remove('show')
    for (const l of this.lamps) l.intensity = 0
    this.headlight.intensity = 0
  }

  // ------------------------------------------------------------ ambient trains

  private ambient: TrainRun[] = []
  private ambientTimer = 0
  maxAmbient = 4

  /**
   * Trains running past on the lines around you, at a frequency that follows
   * the timetable rhythm: rush hours busy, none between ~1:00 and 5:00.
   */
  updateAmbient(dt: number, cam: Vector3, hour: number): void {
    const net = this.net
    if (!net) return
    this.snap.update(dt, this.host.vector.readyTiles)
    for (const r of [...this.ambient]) {
      r.update(dt)
      const p = r.cars[0].group.position
      if (r.state === 'arrived' || p.distanceTo(cam) > 4000) {
        r.dispose()
        this.ambient.splice(this.ambient.indexOf(r), 1)
      }
    }
    this.ambientTimer -= dt
    if (this.ambientTimer > 0) return
    this.ambientTimer = 2.5
    const tod = hour < 1 ? 0.3 : hour < 5 ? 0 : hour < 7 ? 0.6 : hour < 10 ? 1 : hour < 17 ? 0.75 : hour < 20 ? 1 : 0.6
    if (this.ambient.length >= Math.round(this.maxAmbient * tod)) return
    const g = this.host.world.geodeticFromWorld(cam)
    const near = net.nearby(g.lat, g.lon, 2600).filter((n) => {
      const k = net.lines[n.station.line].kind
      return n.d > 900 && k !== 'metro' && k !== 'cable' && k !== 'agt'
    })
    if (!near.length) return
    const start = near[Math.floor(Math.random() * near.length)].station
    const here = { lat: g.lat, lon: g.lon }
    const dist = (id: number) => {
      const s = net.stations[id]
      return Math.hypot((s.lat - here.lat) * 111000, (s.lon - here.lon) * 91000)
    }
    // Head toward the player, then carry on through.
    const stations = [start.id]
    const links: number[] = []
    let total = 0
    let passed = false
    while (links.length < 7 && total < 6000) {
      const cur = stations[stations.length - 1]
      const prev = stations.length > 1 ? stations[stations.length - 2] : -1
      const opts = net.stations[cur].links.filter((l) => net.links[l].line === start.line && net.other(l, cur) !== prev)
      if (!opts.length) break
      let pick = opts[0]
      if (!passed) {
        pick = opts.reduce((a, b) => (dist(net.other(a, cur)) < dist(net.other(b, cur)) ? a : b))
        if (dist(net.other(pick, cur)) > dist(cur)) passed = true
      } else pick = opts[Math.floor(Math.random() * opts.length)]
      links.push(pick)
      stations.push(net.other(pick, cur))
      total += net.links[pick].length
      if (passed && total > 3500) break
    }
    if (links.length < 2) return
    const run = new TrainRun(net, net.lines[start.line], links, stations, this.host.world, this.host.terrain, this.snap)
    run.dwell = Math.random() * 15
    run.update(0)
    this.root.add(run.group)
    this.ambient.push(run)
  }

  clearAmbient(): void {
    for (const r of this.ambient) r.dispose()
    this.ambient.length = 0
  }

  /** Programmatic skip (tests, UI buttons). */
  requestSkip(all: boolean): void {
    this.skipRequest = all ? 'all' : 'next'
  }

  private arrive(stationId: number, index: number): void {
    const run = this.run!
    const net = this.net!
    const st = net.stations[stationId]
    const last = index >= run.stops.length - 1
    const leg = this.route!.legs[this.legIndex]
    if (last && this.legIndex < this.route!.legs.length - 1) {
      const next = this.route!.legs[this.legIndex + 1]
      this.host.hud.toast(`<b>${st.ja}</b> — transfer to the <b style="color:${next.line.color}">${next.line.ja}</b> ${next.line.en ? `(${next.line.en})` : ''}. Follow the line-colour signs.`, 5000)
    } else if (last) {
      this.host.hud.toast(`<b>${st.ja}</b>、${st.ja}です。 This is <b>${st.en || st.ja}</b>, the last stop for you. <kbd>E</kbd> get off.`, 6000)
    } else if (leg.line.kind !== 'shinkansen') {
      this.host.hud.toast(`${st.ja}、${st.ja}。 <b>${st.en || st.ja}</b>.`, 2500)
    }
  }

  /** IC fare for the distance actually ridden (charged when you tap out). */
  private fare(): number {
    const r = this.route
    if (!r) return 0
    const legs = r.legs.slice(0, this.legIndex + 1)
    const kind = legs.some((l) => l.line.kind === 'shinkansen') ? 'shinkansen' : legs[0].line.kind
    // Whole route fare if completed, else a distance pro-rata of the first operator.
    const done = this.legIndex === r.legs.length - 1 && this.run?.state === 'arrived'
    return done ? r.fare : fareFor(kind, this.travelled / 1000, legs[0].line.operator)
  }

  /** Per-frame. Returns camera targets for the host's rig. */
  update(dt: number, keys: { skip: boolean; skipAll: boolean; exit: boolean; view: boolean }): void {
    const run = this.run
    if (!run || !this.net) return
    this.snap.update(dt, this.host.vector.readyTiles)
    if (keys.view) this.view = this.view === 'seat' ? 'cab' : this.view === 'cab' ? 'outside' : 'seat'
    if (!this.skipping) run.update(dt)
    this.travelled += Math.max(0, run.s - this.lastS)
    this.lastS = run.s

    // Skip ahead: jump down the line and let the world stream in.
    if (this.skipRequest) {
      keys = { ...keys, skip: this.skipRequest === 'next', skipAll: this.skipRequest === 'all' }
      this.skipRequest = null
    }
    if ((keys.skip || keys.skipAll) && !this.skipping) {
      const target = keys.skipAll ? run.stops.length - 1 : run.nextStopIndex
      const before = run.s
      run.skipTo(target)
      const jumped = Math.max(0, run.s - before)
      this.travelled += jumped
      this.lastS = run.s
      this.host.advanceClock(jumped / (run.line.kind === 'shinkansen' ? 60 : 13))
      if (jumped > 1500) {
        this.skipping = true
        this.host.veil(`${run.line.ja} · ${this.net.stations[run.stops[target].station].ja}`)
      }
    }
    if (this.skipping) {
      run.place()
      const p = run.cars[0].group.position
      if (this.host.worldReadyAt(p)) {
        this.skipping = false
        this.snap.invalidate()
        this.host.veil(null)
      }
    }

    // Tunnel sleeve and underground station halls around the train.
    this.tunnel.update(dt, run.s - run.length - 80, run.s + 260, (s, pos, fwd) => {
      run.frameAtDistance(s, pos, fwd)
      return run.trackDepth(s)
    })
    const ns = run.nextStation
    const si = run.stops.indexOf(ns)
    if (run.underground && Math.abs(run.stopPos(si) - run.s) < 400 && !this.halls.has(si)) {
      const st = this.net.stations[ns.station]
      const hall = buildStationHall(st, run.line.color, run.style.width)
      const pos = new Vector3()
      const fwd = new Vector3()
      run.frameAtDistance(ns.s, pos, fwd)
      hall.position.copy(pos)
      hall.lookAt(pos.clone().add(fwd))
      this.root.add(hall)
      this.halls.set(si, hall)
    }

    // Cabin lights follow the car.
    const car = run.cars[this.rideCar]
    const lamps = (this.interior?.userData.lamps ?? []) as number[][]
    this.lamps.forEach((l, i) => {
      const a = lamps[i]
      if (!a) return
      l.position.set(a[0], a[1], a[2]).applyMatrix4(car.group.children[0].matrixWorld)
      l.intensity = 3.2
    })

    // Headlights on the leading car.
    {
      const hp = new Vector3()
      const hf = new Vector3()
      run.frameAt(0.3, hp, hf)
      this.headlight.position.copy(hp).setY(hp.y + 1.2)
      this.headlight.target.position.copy(hp).addScaledVector(hf, 40)
      this.headlight.target.updateMatrixWorld()
      this.headlight.intensity = 900
    }
    this.updateLcd(dt)
    if (keys.exit && run.state !== 'run') this.getOff()
    else if (run.state === 'arrived') {
      if (this.legIndex < this.route!.legs.length - 1) {
        this.legIndex++
        this.startLeg(this.route!.legs[this.legIndex])
      }
    }
  }

  private getOff(): void {
    const run = this.run!
    const st = this.net!.stations[run.stops[run.at].station]
    const fare = this.fare()
    if (!this.host.payIC(fare)) return
    this.host.hud.toast(`ピッ — tapped out at <b>${st.ja}</b>. ¥${fare.toLocaleString()} from your IC card.`, 5000)
    this.end()
    this.host.finish(st)
  }

  /** Where the camera goes. */
  cameraTarget(): { pivot: Vector3; forward: Vector3; first: boolean; distance: number } | null {
    const run = this.run
    if (!run) return null
    const pos = new Vector3()
    const fwd = new Vector3()
    if (this.view === 'cab') {
      run.frameAt(run.style.nose > 3 ? run.style.nose * 0.55 : 1.4, pos, fwd)
      pos.y += run.style.floor + (run.style.kind === 'shinkansen' ? 1.05 : 1.35)
      return { pivot: pos, forward: fwd, first: true, distance: 0 }
    }
    if (this.view === 'outside') {
      run.frameAt(run.cars[0].length * 0.5, pos, fwd)
      pos.y += run.style.height + 1
      return { pivot: pos, forward: fwd, first: false, distance: 34 }
    }
    // Seated in the ride car, looking across at the opposite windows (or out of
    // the window for Shinkansen rows).
    const car = run.cars[this.rideCar]
    const inner = car.group.children[0]
    // Facing +z the car's left is +x: sit on the left bench looking across to
    // the right-hand windows, or in a Shinkansen E-seat by the window.
    const sk = run.style.kind === 'shinkansen'
    const local = sk ? new Vector3(1.07, run.style.floor + 1.12, 0.3) : new Vector3(1.0, run.style.floor + 1.1, 0.6)
    pos.copy(local).applyMatrix4(inner.matrixWorld)
    fwd.set(sk ? 0.5 : -1, 0, sk ? 0.85 : 0).normalize().transformDirection(inner.matrixWorld)
    return { pivot: pos, forward: fwd, first: true, distance: 0 }
  }

  private updateLcd(dt: number): void {
    const run = this.run!
    const net = this.net!
    this.lcdTimer += dt
    if (this.lcdTimer > 4) {
      this.lcdTimer = 0
      this.lcdLang = (this.lcdLang + 1) % 3
    }
    const dwelling = run.state !== 'run'
    const legStops = run.stops
    const ni = dwelling ? run.at : legStops.indexOf(run.nextStation)
    const next = net.stations[legStops[ni].station]
    const label = dwelling ? ['ただいま', 'Now stopping at', 'ただいま'][this.lcdLang] : ['次は', 'Next', 'つぎは'][this.lcdLang]
    const name = [next.ja, next.en || next.ja, next.kana || next.ja][this.lcdLang]
    const dest = net.stations[legStops[legStops.length - 1].station]
    const speed = Math.round(run.v * 3.6)
    const strip = legStops
      .slice(Math.max(0, ni - 2), ni + 5)
      .map((s) => {
        const idx = legStops.indexOf(s)
        const cls = idx < ni ? 'past' : idx === ni ? 'next' : ''
        return `<div class="${cls}">${net.stations[s.station].ja}${!s.stops ? '<small>通過</small>' : ''}</div>`
      })
      .join('')
    const html = `<div class="lcd-head"><b>${this.route!.legs[this.legIndex].line.ja}</b> ${dest.ja}行 <span>${speed} km/h</span></div>
      <div class="lcd-body"><div class="lcd-next">${label}</div><div class="lcd-name">${name}<small>${this.lcdLang === 1 ? next.ja : next.en}</small></div>
      <div class="lcd-door">${dwelling ? 'ドアが開きます<br>Doors open' : `${Math.max(0, Math.round((run.stopPos(ni) - run.s) / 100) / 10)} km`}</div></div>
      <div class="lcd-strip">${strip}</div>`
    if (this.lcd.innerHTML !== html) this.lcd.innerHTML = html
    // Announcement as the train approaches the next stop.
    if (!dwelling && ni !== this.announced && run.stopPos(ni) - run.s < 900 && legStops[ni].stops) {
      this.announced = ni
      this.host.sound('chime')
      const transfer = net
        .complex(next.id)
        .filter((c) => c.line !== run.line.id)
        .map((c) => net.lines[c.line].ja)
      const uniq = [...new Set(transfer)].slice(0, 4)
      this.host.hud.toast(
        `次は <b>${next.ja}</b>、${next.ja}。 The next station is <b>${next.en || next.ja}</b>.` +
          (uniq.length ? `<br><span style="opacity:.8">Transfer: ${uniq.join('・')}</span>` : '') +
          `<br><span style="opacity:.7">The doors on the left side will open.</span>`,
        6000,
      )
    }
  }
}
