// Station concourse UI: the 駅名標 (station name board) of the station you
// are at, the lines that serve it, a destination search across every station
// in Japan, the planned route with transfers, time and fare, and the IC-card
// ticket gate.
import type { RailNetwork, Route, Station } from '../transit/RailNetwork'
import { ekibenAt } from '../data/ekiben'

export interface StationPanelHooks {
  wallet: () => { cash: number; ic: number }
  charge: (yen: number) => boolean
  board: (route: Route) => void
  close: () => void
  here: () => { lat: number; lon: number }
  /** Buy a station bento (駅弁) to eat on the train. */
  ekiben: (name: string, price: number) => boolean
}

const POPULAR = ['東京', '新宿', '渋谷', '浅草', '上野', '秋葉原', '京都', '新大阪', '名古屋', '博多', '広島', '金沢', '仙台', '札幌', '奈良', '鎌倉']

export class StationPanel {
  readonly el: HTMLDivElement
  private station: Station | null = null
  private route: Route | null = null
  open = false

  constructor(
    parent: HTMLElement,
    private net: () => RailNetwork | null,
    private hooks: StationPanelHooks,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'station'
    parent.appendChild(this.el)
    this.el.addEventListener('keydown', (e) => e.stopPropagation())
    this.el.addEventListener('keyup', (e) => e.stopPropagation())
  }

  show(station: Station): void {
    this.station = station
    this.route = null
    this.open = true
    this.render()
    this.el.classList.add('open')
    setTimeout(() => (this.el.querySelector('.st-search') as HTMLInputElement | null)?.focus(), 50)
  }

  hide(): void {
    this.open = false
    this.el.classList.remove('open')
  }

  private render(): void {
    const net = this.net()
    const s = this.station
    if (!net || !s) return
    const complex = net.complex(s.id)
    const line = net.lines[s.line]
    // Neighbours along this platform's line for the name board arrows.
    const nb = s.links.map((l) => net.stations[net.other(l, s.id)])
    const left = nb[0]
    const right = nb[1]
    const lines = [...new Map(complex.map((c) => [c.line, net.lines[c.line]])).values()]
    const w = this.hooks.wallet()
    this.el.innerHTML = `
      <div class="st-card">
        <button class="st-close" title="Leave the station">×</button>
        <div class="st-board">
          <div class="st-kana">${esc(s.kana || '')}</div>
          <div class="st-kanji">${esc(s.ja)}</div>
          <div class="st-romaji">${esc(s.en || '')}</div>
          <div class="st-bar" style="background:${line.color}">
            <span>${left ? `← ${esc(left.ja)}` : ''}</span>
            <span>${right ? `${esc(right.ja)} →` : ''}</span>
          </div>
        </div>
        <div class="st-lines">${lines
          .map((l) => `<span class="st-line" style="--c:${l.color}"><i></i>${esc(l.ja)}<em>${esc(l.en || l.operator)}</em></span>`)
          .join('')}</div>
        <div class="st-wallet">IC card <b>¥${w.ic.toLocaleString()}</b> · cash ¥${w.cash.toLocaleString()}
          <span class="st-charge">Charge: <button data-y="1000">¥1,000</button><button data-y="3000">¥3,000</button><button data-y="5000">¥5,000</button></span></div>
        ${(() => {
          const bento = ekibenAt(s.ja, lines.some((l) => l.kind === 'shinkansen'))
          return bento.length
            ? `<div class="st-ekiben"><span>駅弁 <em>station bento</em></span>${bento
                .map((b, i) => `<button data-e="${i}" title="${esc(b[1])}"><b>${esc(b[0])}</b> ¥${b[2].toLocaleString()}</button>`)
                .join('')}</div>`
            : ''
        })()}
        <input class="st-search" placeholder="Where to? 駅名 / station (e.g. Kyoto, 浅草, しぶや)" autocomplete="off" />
        <div class="st-results"></div>
        <div class="st-popular">${POPULAR.filter((p) => p !== s.ja)
          .map((p) => `<button data-q="${p}">${p}</button>`)
          .join('')}</div>
        <div class="st-route"></div>
      </div>`
    this.el.querySelector('.st-close')!.addEventListener('click', () => this.hooks.close())
    const input = this.el.querySelector('.st-search') as HTMLInputElement
    input.addEventListener('input', () => this.results(input.value))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hooks.close()
      if (e.key === 'Enter') (this.el.querySelector('.st-results button') as HTMLButtonElement | null)?.click()
    })
    this.el.querySelectorAll<HTMLButtonElement>('.st-popular button').forEach((b) =>
      b.addEventListener('click', () => {
        const hit = net.search(b.dataset.q!, 1)[0]
        if (hit) this.plan(hit)
      }),
    )
    this.el.querySelectorAll<HTMLButtonElement>('.st-ekiben button').forEach((b) =>
      b.addEventListener('click', () => {
        const e = ekibenAt(s.ja, lines.some((l) => l.kind === 'shinkansen'))[Number(b.dataset.e)]
        if (e && this.hooks.ekiben(e[0], e[2])) {
          const r = this.route
          this.render()
          if (r) this.showRoute(r)
        }
      }),
    )
    this.el.querySelectorAll<HTMLButtonElement>('.st-charge button').forEach((b) =>
      b.addEventListener('click', () => {
        if (this.hooks.charge(Number(b.dataset.y))) {
          const r = this.route
          this.render()
          if (r) this.showRoute(r)
        }
      }),
    )
  }

  private results(q: string): void {
    const net = this.net()
    const box = this.el.querySelector('.st-results') as HTMLDivElement
    if (!net || !q.trim()) {
      box.innerHTML = ''
      return
    }
    const hits = net.search(q.trim(), 8, this.hooks.here())
    box.innerHTML = hits
      .map((h, i) => {
        const l = net.lines[h.line]
        return `<button data-i="${i}"><b>${esc(h.ja)}</b> <span>${esc(h.en)} · ${esc(l.ja)} ${esc(l.operator)}</span></button>`
      })
      .join('')
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => this.plan(hits[Number(b.dataset.i)])))
  }

  private plan(dest: Station): void {
    const net = this.net()
    if (!net || !this.station) return
    ;(this.el.querySelector('.st-results') as HTMLDivElement).innerHTML = ''
    const r = net.route(this.station.id, dest.id)
    const box = this.el.querySelector('.st-route') as HTMLDivElement
    if (!r || !r.legs.length) {
      box.innerHTML = `<div class="st-none">No rail connection from here to ${esc(dest.ja)} — try a ferry, bus or plane in a later update.</div>`
      return
    }
    this.showRoute(r)
  }

  private showRoute(r: Route): void {
    const net = this.net()!
    this.route = r
    const box = this.el.querySelector('.st-route') as HTMLDivElement
    const first = net.stations[r.legs[0].stations[0]]
    const lastLeg = r.legs[r.legs.length - 1]
    const last = net.stations[lastLeg.stations[lastLeg.stations.length - 1]]
    const mins = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`)
    const w = this.hooks.wallet()
    const short = w.ic < r.fare
    box.innerHTML = `
      <div class="st-sum"><b>${esc(first.ja)} → ${esc(last.ja)}</b> <span>${mins(r.time)} · ¥${r.fare.toLocaleString()} · ${r.transfers ? `${r.transfers} transfer${r.transfers > 1 ? 's' : ''}` : 'direct'}</span></div>
      <ol class="st-legs">${r.legs
        .map((l) => {
          const a = net.stations[l.stations[0]]
          const b = net.stations[l.stations[l.stations.length - 1]]
          const stops = l.stations.length - 1
          const kind = l.line.kind === 'shinkansen' ? 'Shinkansen' : l.line.kind === 'metro' ? 'Subway' : l.line.kind === 'tram' ? 'Tram' : 'Train'
          return `<li style="--c:${l.line.color}"><i></i><div><b>${esc(l.line.ja)}</b> <span>${esc(l.line.en || kind)}</span><br>
            ${esc(a.ja)} → ${esc(b.ja)} <span>${stops} stop${stops > 1 ? 's' : ''} · ${mins(l.time)}${l.fare ? ` · ¥${l.fare.toLocaleString()}` : ''}</span></div></li>`
        })
        .join('')}</ol>
      <div class="st-go">
        <button class="st-board-btn" ${short ? 'disabled' : ''}>${short ? 'Charge your IC card first' : `<span>ピッ</span> Tap IC card &amp; go to the platform`}</button>
      </div>
      <div class="st-tip">${tip(r)}</div>`
    box.querySelector('.st-board-btn')?.addEventListener('click', () => this.hooks.board(r))
  }
}

function tip(r: Route): string {
  const k = r.legs.map((l) => l.line.kind)
  if (k.includes('shinkansen')) return 'Shinkansen tickets include a limited-express surcharge. Queue at the painted car-number markers on the platform; the train stops exactly there.'
  if (k.includes('metro')) return 'Tokyo-area subways run every 2–5 minutes. Stand on the left of escalators in Tokyo (on the right in Osaka). Keep your voice low and phone on silent (マナーモード) inside the train.'
  if (k.includes('tram')) return 'On most trams you board at the back and pay a flat fare when you get off at the front.'
  return 'Trains in Japan leave to the second. Let passengers off first, then board; priority seats (優先席) are for elderly, pregnant and disabled passengers.'
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
