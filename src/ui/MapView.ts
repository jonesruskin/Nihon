// Full-screen map of Japan (国土地理院 standard map tiles): pan, zoom,
// search places/addresses, travel anywhere, or set a destination for a
// taxi ride / route planning.
import { lonLatToTileXY, tileXToLon, tileYToLat } from '../core/tiles'
import { DESTINATIONS, type Destination } from '../data/places'

export interface MapCallbacks {
  travel: (lat: number, lon: number, heading?: number, dest?: Destination) => void
  setDestination: (lat: number, lon: number, label: string) => void
  playerPos: () => { lat: number; lon: number; heading: number }
}

const TILE = (z: number, x: number, y: number, style: string) =>
  `https://cyberjapandata.gsi.go.jp/xyz/${style}/${z}/${x}/${y}.${style === 'seamlessphoto' ? 'jpg' : 'png'}`

export class MapView {
  readonly el: HTMLDivElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private tiles = new Map<string, HTMLImageElement>()
  private centerX = 0 // tile-space at zoom 0..1 (mercator unit square)
  private centerY = 0
  zoom = 13
  open = false
  private style: 'std' | 'pale' | 'seamlessphoto' = 'std'
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
  private popup: HTMLDivElement
  private list: HTMLDivElement
  private raf = 0
  destination: { lat: number; lon: number; label: string } | null = null
  private pinch: { d: number; z: number } | null = null

  constructor(
    parent: HTMLElement,
    private cb: MapCallbacks,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'map'
    this.el.innerHTML = `
      <canvas class="map-canvas"></canvas>
      <div class="map-top">
        <input class="map-search" placeholder="Search places in Japan — 浅草, Fushimi Inari, 札幌…" />
        <div class="map-styles"><button data-s="std" class="on">地図</button><button data-s="pale">淡色</button><button data-s="seamlessphoto">写真</button></div>
        <button class="map-close" title="Close (M)">✕</button>
      </div>
      <div class="map-results"></div>
      <div class="map-list"></div>
      <div class="map-popup"></div>
      <div class="map-credit">地理院タイル (国土地理院)</div>`
    parent.appendChild(this.el)
    this.canvas = this.el.querySelector('canvas')!
    this.ctx = this.canvas.getContext('2d')!
    this.popup = this.el.querySelector('.map-popup')!
    this.list = this.el.querySelector('.map-list')!
    this.buildList()
    this.el.querySelector('.map-close')!.addEventListener('click', () => this.toggle(false))
    this.el.querySelectorAll<HTMLButtonElement>('.map-styles button').forEach((b) =>
      b.addEventListener('click', () => {
        this.style = b.dataset.s as typeof this.style
        this.el.querySelectorAll('.map-styles button').forEach((x) => x.classList.toggle('on', x === b))
        this.tiles.clear()
      }),
    )
    const search = this.el.querySelector<HTMLInputElement>('.map-search')!
    let timer = 0
    search.addEventListener('input', () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => void this.search(search.value), 280)
    })
    search.addEventListener('keydown', (e) => e.stopPropagation())
    const c = this.canvas
    c.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.centerX, cy: this.centerY, moved: false }
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || this.pinch) return
      const s = 256 * 2 ** this.zoom
      const dx = e.clientX - this.drag.x
      const dy = e.clientY - this.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true
      this.centerX = this.drag.cx - dx / s
      this.centerY = this.drag.cy - dy / s
    })
    c.addEventListener('pointerup', (e) => {
      if (this.drag && !this.drag.moved) this.clickAt(e.clientX, e.clientY)
      this.drag = null
    })
    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.zoomAt(e.clientX, e.clientY, this.zoom - Math.sign(e.deltaY) * 0.5)
    })
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) this.pinch = { d: this.touchDist(e), z: this.zoom }
    })
    c.addEventListener('touchmove', (e) => {
      if (this.pinch && e.touches.length === 2) {
        const r = this.touchDist(e) / this.pinch.d
        this.zoom = Math.max(5, Math.min(18, this.pinch.z + Math.log2(r)))
      }
    })
    c.addEventListener('touchend', () => (this.pinch = null))
    window.addEventListener('resize', () => this.resize())
    this.resize()
  }

  private touchDist(e: TouchEvent): number {
    return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = window.innerWidth * dpr
    this.canvas.height = window.innerHeight * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open
    this.el.classList.toggle('open', this.open)
    if (this.open) {
      const p = this.cb.playerPos()
      this.centerOn(p.lat, p.lon, Math.max(this.zoom, 12))
      cancelAnimationFrame(this.raf)
      const loop = () => {
        if (!this.open) return
        this.draw()
        this.raf = requestAnimationFrame(loop)
      }
      loop()
    } else this.popup.classList.remove('show')
  }

  centerOn(lat: number, lon: number, zoom = this.zoom): void {
    const t = lonLatToTileXY(lon, lat, 0)
    this.centerX = t.x
    this.centerY = t.y
    this.zoom = zoom
  }

  private zoomAt(px: number, py: number, z: number): void {
    z = Math.max(5, Math.min(18, z))
    const s0 = 256 * 2 ** this.zoom
    const wx = this.centerX + (px - window.innerWidth / 2) / s0
    const wy = this.centerY + (py - window.innerHeight / 2) / s0
    this.zoom = z
    const s1 = 256 * 2 ** z
    this.centerX = wx - (px - window.innerWidth / 2) / s1
    this.centerY = wy - (py - window.innerHeight / 2) / s1
  }

  private toScreen(lat: number, lon: number): [number, number] {
    const t = lonLatToTileXY(lon, lat, 0)
    const s = 256 * 2 ** this.zoom
    return [(t.x - this.centerX) * s + window.innerWidth / 2, (t.y - this.centerY) * s + window.innerHeight / 2]
  }

  private toGeo(px: number, py: number): { lat: number; lon: number } {
    const s = 256 * 2 ** this.zoom
    const x = this.centerX + (px - window.innerWidth / 2) / s
    const y = this.centerY + (py - window.innerHeight / 2) / s
    return { lon: tileXToLon(x, 0), lat: tileYToLat(y, 0) }
  }

  private draw(): void {
    const ctx = this.ctx
    const W = window.innerWidth
    const H = window.innerHeight
    ctx.fillStyle = '#d7e4ea'
    ctx.fillRect(0, 0, W, H)
    const z = Math.min(18, Math.max(2, Math.round(this.zoom)))
    const scale = 2 ** (this.zoom - z)
    const n = 2 ** z
    const s = 256 * scale
    const cx = this.centerX * n
    const cy = this.centerY * n
    const x0 = Math.floor(cx - W / 2 / s)
    const x1 = Math.floor(cx + W / 2 / s)
    const y0 = Math.floor(cy - H / 2 / s)
    const y1 = Math.floor(cy + H / 2 / s)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= n) continue
        const xx = ((x % n) + n) % n
        const key = `${this.style}/${z}/${xx}/${y}`
        let img = this.tiles.get(key)
        if (!img) {
          img = new Image()
          img.crossOrigin = 'anonymous'
          img.src = TILE(z, xx, y, this.style)
          this.tiles.set(key, img)
          if (this.tiles.size > 600) this.tiles.delete(this.tiles.keys().next().value!)
        }
        if (img.complete && img.naturalWidth) ctx.drawImage(img, (x - cx) * s + W / 2, (y - cy) * s + H / 2, s + 0.5, s + 0.5)
      }
    // Destination pins
    ctx.font = '500 12px "Noto Sans JP", sans-serif'
    for (const d of DESTINATIONS) {
      const [px, py] = this.toScreen(d.lat, d.lon)
      if (px < -50 || py < -50 || px > W + 50 || py > H + 50) continue
      ctx.fillStyle = '#d23c2a'
      ctx.beginPath()
      ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      if (this.zoom >= 7) {
        ctx.fillStyle = 'rgba(255,255,255,.9)'
        const label = this.zoom >= 10 ? d.kanji : d.en
        const w = ctx.measureText(label).width
        ctx.fillRect(px + 8, py - 9, w + 8, 18)
        ctx.fillStyle = '#222'
        ctx.fillText(label, px + 12, py + 4)
      }
    }
    if (this.destination) {
      const [px, py] = this.toScreen(this.destination.lat, this.destination.lon)
      ctx.fillStyle = '#1f6fd2'
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.arc(px, py - 14, 8, Math.PI * 0.8, Math.PI * 0.2)
      ctx.closePath()
      ctx.fill()
    }
    // Player arrow
    const me = this.cb.playerPos()
    const [mx, my] = this.toScreen(me.lat, me.lon)
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(me.heading)
    ctx.fillStyle = '#d23c2a'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(0, -11)
    ctx.lineTo(8, 9)
    ctx.lineTo(0, 4)
    ctx.lineTo(-8, 9)
    ctx.closePath()
    ctx.stroke()
    ctx.fill()
    ctx.restore()
  }

  private clickAt(px: number, py: number): void {
    // Pin hit-test first.
    for (const d of DESTINATIONS) {
      const [x, y] = this.toScreen(d.lat, d.lon)
      if (Math.hypot(x - px, y - py) < 10) return this.showPopup(px, py, d.lat, d.lon, d)
    }
    const g = this.toGeo(px, py)
    this.showPopup(px, py, g.lat, g.lon)
  }

  private showPopup(px: number, py: number, lat: number, lon: number, d?: Destination): void {
    const me = this.cb.playerPos()
    const km = haversineKm(me.lat, me.lon, lat, lon)
    this.popup.innerHTML = `
      ${d ? `<div class="pp-reading">${d.reading}</div><div class="pp-title">${d.kanji}</div><div class="pp-en">${d.en} · ${d.pref}</div>${d.meaning ? `<div class="pp-meaning">${d.meaning}</div>` : ''}<p>${d.blurb}</p>` : `<div class="pp-title">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>`}
      <div class="pp-km">${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`} from you</div>
      <div class="pp-actions">
        <button class="pp-travel">Travel here</button>
        <button class="pp-dest">Set destination</button>
      </div>`
    this.popup.style.left = `${Math.min(window.innerWidth - 300, Math.max(10, px + 12))}px`
    this.popup.style.top = `${Math.min(window.innerHeight - 260, Math.max(60, py - 20))}px`
    this.popup.classList.add('show')
    this.popup.querySelector('.pp-travel')!.addEventListener('click', () => {
      this.toggle(false)
      this.cb.travel(lat, lon, d?.heading, d)
    })
    this.popup.querySelector('.pp-dest')!.addEventListener('click', () => {
      this.destination = { lat, lon, label: d?.kanji ?? 'Destination' }
      this.cb.setDestination(lat, lon, d?.kanji ?? 'Destination')
      this.popup.classList.remove('show')
    })
  }

  private buildList(): void {
    const regions = [...new Set(DESTINATIONS.map((d) => d.region))]
    this.list.innerHTML =
      `<div class="ml-title">Where to? <span>行き先</span></div>` +
      regions
        .map(
          (r) =>
            `<div class="ml-region">${r}</div>` +
            DESTINATIONS.filter((d) => d.region === r)
              .map((d) => `<button class="ml-item" data-id="${d.id}"><span class="ml-k">${d.kanji}</span><span class="ml-e">${d.en}</span></button>`)
              .join(''),
        )
        .join('')
    this.list.querySelectorAll<HTMLButtonElement>('.ml-item').forEach((b) =>
      b.addEventListener('click', () => {
        const d = DESTINATIONS.find((x) => x.id === b.dataset.id)!
        this.centerOn(d.lat, d.lon, 15)
        const [px, py] = this.toScreen(d.lat, d.lon)
        this.showPopup(px, py, d.lat, d.lon, d)
      }),
    )
  }

  private async search(q: string): Promise<void> {
    const box = this.el.querySelector<HTMLDivElement>('.map-results')!
    q = q.trim()
    if (!q) {
      box.innerHTML = ''
      return
    }
    const ql = q.toLowerCase()
    const local = DESTINATIONS.filter((d) => [d.kanji, d.reading, d.romaji, d.en, d.pref].some((s) => s.toLowerCase().includes(ql))).slice(0, 6)
    let remote: Array<{ title: string; lat: number; lon: number }> = []
    try {
      const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`)
      const j = (await r.json()) as Array<{ geometry: { coordinates: [number, number] }; properties: { title: string } }>
      remote = j.slice(0, 8).map((f) => ({ title: f.properties.title, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
    } catch {
      /* offline */
    }
    box.innerHTML =
      local.map((d) => `<button data-lat="${d.lat}" data-lon="${d.lon}" data-id="${d.id}">★ ${d.kanji} <span>${d.en}</span></button>`).join('') +
      remote.map((r) => `<button data-lat="${r.lat}" data-lon="${r.lon}">${r.title}</button>`).join('')
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        const lat = Number(b.dataset.lat)
        const lon = Number(b.dataset.lon)
        this.centerOn(lat, lon, 16)
        box.innerHTML = ''
        const [px, py] = this.toScreen(lat, lon)
        this.showPopup(px, py, lat, lon, DESTINATIONS.find((d) => d.id === b.dataset.id))
      }),
    )
  }
}

function haversineKm(a: number, b: number, c: number, d: number): number {
  const R = 6371
  const dLat = ((c - a) * Math.PI) / 180
  const dLon = ((d - b) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a * Math.PI) / 180) * Math.cos((c * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
