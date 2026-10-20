// Minimal, diegetic-feeling HUD: loading veil, place card, clock, compass,
// context prompts and toasts. Plain DOM, styled in style.css.

export interface PlaceCard {
  kanji: string
  reading?: string
  romaji?: string
  meaning?: string
  sub?: string
}

export class Hud {
  readonly root: HTMLDivElement
  private loading: HTMLDivElement
  private loadingStatus: HTMLDivElement
  private loadingBar: HTMLDivElement
  private place: HTMLDivElement
  private clock: HTMLDivElement
  private compass: HTMLDivElement
  private prompt: HTMLDivElement
  private toasts: HTMLDivElement
  private hints: HTMLDivElement
  private debug: HTMLDivElement
  private speedo: HTMLDivElement
  private placeTimer = 0
  private tips: Array<{ head: string; text: string }> = []
  private tipTimer: ReturnType<typeof setInterval> | null = null

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'hud'
    parent.appendChild(this.root)
    this.root.innerHTML = `
      <div class="loading">
        <div class="loading-mark">日本</div>
        <div class="loading-title">NIHON</div>
        <div class="loading-sub">Japan, rebuilt from open data</div>
        <div class="loading-bar"><div></div></div>
        <div class="loading-status">Preparing…</div>
        <div class="loading-tip"></div>
        <div class="loading-credit">地理院タイル · PLATEAU · © OpenStreetMap contributors</div>
      </div>
      <div class="place"></div>
      <div class="clock"></div>
      <div class="compass"><div class="compass-strip"></div><div class="compass-needle"></div></div>
      <div class="prompt"></div>
      <div class="toasts"></div>
      <div class="hints"></div>
      <div class="debug"></div>
      <div class="speedo"><span class="speedo-v">0</span><span class="speedo-u">km/h</span></div>
      <div class="attrib">© OpenStreetMap contributors · 地理院タイル · PLATEAU · 国土数値情報 · Open-Meteo</div>`
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T
    this.loading = q('.loading')
    this.loadingStatus = q('.loading-status')
    this.loadingBar = q('.loading-bar > div')
    this.place = q('.place')
    this.clock = q('.clock')
    this.compass = q('.compass-strip')
    this.prompt = q('.prompt')
    this.toasts = q('.toasts')
    this.hints = q('.hints')
    this.debug = q('.debug')
    this.speedo = q('.speedo')
    // Compass strip: cardinal + intercardinal labels repeated.
    const labels = ['N 北', 'NE', 'E 東', 'SE', 'S 南', 'SW', 'W 西', 'NW']
    let html = ''
    for (let r = 0; r < 3; r++) for (let i = 0; i < 8; i++) html += `<span class="${labels[i].length > 2 ? 'major' : ''}">${labels[i]}</span>`
    this.compass.innerHTML = html
    if (new URLSearchParams(location.search).has('debug')) this.debug.style.display = 'block'
  }

  setLoading(progress: number, status: string): void {
    this.loadingBar.style.width = `${Math.round(Math.min(1, progress) * 100)}%`
    this.loadingStatus.textContent = status
  }

  /** The opaque loading screen is up: nothing behind it is visible. */
  get veiled(): boolean {
    return !this.loading.classList.contains('done')
  }

  hideLoading(): void {
    this.loading.classList.add('done')
    if (this.tipTimer) clearInterval(this.tipTimer)
    this.tipTimer = null
  }

  showLoading(status: string): void {
    this.loading.classList.remove('done')
    this.setLoading(0, status)
    this.startTips()
  }

  /** Things worth knowing (豆知識), shown one at a time while the world loads. */
  setTips(tips: Array<{ head: string; text: string }>): void {
    this.tips = tips
    this.startTips()
  }

  private startTips(): void {
    if (this.tipTimer || !this.tips.length || this.loading.classList.contains('done')) return
    const el = this.root.querySelector('.loading-tip') as HTMLDivElement
    const show = () => {
      const t = this.tips[Math.floor(Math.random() * this.tips.length)]
      el.classList.remove('show')
      setTimeout(() => {
        el.innerHTML = `<b>豆知識 · ${t.head}</b>${t.text}`
        el.classList.add('show')
      }, 400)
    }
    show()
    this.tipTimer = setInterval(show, 9000)
  }

  showPlace(card: PlaceCard): void {
    this.place.innerHTML = `
      ${card.reading ? `<div class="place-reading">${card.reading}</div>` : ''}
      <div class="place-kanji">${card.kanji}</div>
      ${card.romaji ? `<div class="place-romaji">${card.romaji}</div>` : ''}
      ${card.meaning ? `<div class="place-meaning">${card.meaning}</div>` : ''}
      ${card.sub ? `<div class="place-sub">${card.sub}</div>` : ''}`
    this.place.classList.remove('show')
    void this.place.offsetWidth
    this.place.classList.add('show')
    clearTimeout(this.placeTimer)
    this.placeTimer = window.setTimeout(() => this.place.classList.remove('show'), 6500)
  }

  setClock(text: string): void {
    if (this.clock.textContent !== text) this.clock.textContent = text
  }

  /** heading: radians, 0 = north, positive = towards west (three.js yaw). */
  setCompass(yaw: number): void {
    const deg = ((-yaw * 180) / Math.PI + 360) % 360
    // 8 labels per 360°, each label 60px wide -> 480px per turn
    const px = (deg / 360) * 480
    this.compass.style.transform = `translateX(${-px - 480 + 150}px)`
  }

  setPrompt(html: string | null): void {
    if (!html) {
      this.prompt.classList.remove('show')
      return
    }
    if (this.prompt.innerHTML !== html) this.prompt.innerHTML = html
    this.prompt.classList.add('show')
  }

  toast(html: string, ms = 4000): void {
    const el = document.createElement('div')
    el.className = 'toast'
    el.innerHTML = html
    this.toasts.appendChild(el)
    setTimeout(() => el.classList.add('show'), 30)
    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 600)
    }, ms)
  }

  /** Welcome to a new prefecture: name, capital, specialities, dialect, a fact. */
  showPrefecture(p: { ja: string; en: string; region: string; capital: string; pop: number; meibutsu: string; dialect: string; fact: string }, count: number): void {
    const el = document.createElement('div')
    el.className = 'pref-card'
    el.innerHTML = `<div class="pc-hello">ようこそ — Welcome to</div>
      <div class="pc-ja">${p.ja}</div><div class="pc-en">${p.en} · ${p.region} · ${count} / 47 visited</div>
      <dl><dt>県庁所在地</dt><dd>${p.capital} · ${p.pop >= 1 ? p.pop.toFixed(1) + 'M' : Math.round(p.pop * 1000) + 'k'} people</dd>
      <dt>名物</dt><dd>${p.meibutsu}</dd><dt>方言</dt><dd>${p.dialect}</dd></dl><p>${p.fact}</p>`
    this.root.appendChild(el)
    setTimeout(() => el.classList.add('show'), 40)
    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 900)
    }, 11000)
  }

  private discoveryQueue: { ja: string; en: string; text: string }[] = []
  private discoveryBusy = false

  /** A card for something new the traveller just learned (発見). */
  showDiscovery(d: { ja: string; en: string; text: string }): void {
    this.discoveryQueue.push(d)
    if (!this.discoveryBusy) this.nextDiscovery()
  }

  private nextDiscovery(): void {
    const d = this.discoveryQueue.shift()
    if (!d) {
      this.discoveryBusy = false
      return
    }
    this.discoveryBusy = true
    const el = document.createElement('div')
    el.className = 'discovery'
    el.innerHTML = `<div class="dc-tag">発見 DISCOVERY</div><div class="dc-ja">${d.ja}</div><div class="dc-en">${d.en}</div><p>${d.text}</p>`
    this.root.appendChild(el)
    setTimeout(() => el.classList.add('show'), 40)
    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => {
        el.remove()
        this.nextDiscovery()
      }, 700)
    }, 9000)
  }

  setHints(html: string): void {
    if (this.hints.innerHTML !== html) this.hints.innerHTML = html
  }

  setSpeed(kmh: number | null): void {
    if (kmh === null) {
      this.speedo.classList.remove('show')
      return
    }
    this.speedo.classList.add('show')
    const v = String(Math.round(kmh))
    const el = this.speedo.firstElementChild as HTMLElement
    if (el.textContent !== v) el.textContent = v
  }

  setDebug(text: string): void {
    if (this.debug.style.display === 'block') this.debug.textContent = text
  }
}
