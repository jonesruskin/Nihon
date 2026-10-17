// The traveller's smartphone (Tab): wallet, discovery journal, stamp book,
// and settings for time, season, weather and graphics.
import { DISCOVERIES, type Journal } from '../tourism/Journal'
import type { WeatherPreset } from '../weather/WeatherSystem'

export interface PhoneHooks {
  wallet: () => { cash: number; ic: number }
  journal: Journal
  setHour: (h: number) => void
  setMonth: (m: number) => void
  setLive: () => void
  setWeather: (w: WeatherPreset) => void
  setQuality: (q: 'low' | 'medium' | 'high' | 'ultra') => void
  status: () => { hour: number; month: number; weather: WeatherPreset; quality: string; live: boolean }
}

type Tab = 'wallet' | 'journal' | 'stamps' | 'settings' | 'credits'

export class Phone {
  readonly el: HTMLDivElement
  open = false
  private tab: Tab = 'journal'

  constructor(
    parent: HTMLElement,
    private hooks: PhoneHooks,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'phone'
    parent.appendChild(this.el)
    this.el.addEventListener('keydown', (e) => e.stopPropagation())
  }

  toggle(): void {
    this.open = !this.open
    this.el.classList.toggle('open', this.open)
    if (this.open) this.render()
  }

  show(tab: Tab): void {
    this.tab = tab
    if (!this.open) this.toggle()
    else this.render()
  }

  private render(): void {
    const tabs: [Tab, string][] = [
      ['wallet', '財布'],
      ['journal', '発見帳'],
      ['stamps', 'スタンプ'],
      ['settings', '設定'],
    ]
    this.el.innerHTML = `<div class="ph-body">
      <div class="ph-notch"></div>
      <div class="ph-screen">${this.screen()}</div>
      <div class="ph-tabs">${tabs.map(([t, l]) => `<button data-t="${t}" class="${t === this.tab ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>`
    this.el.querySelectorAll<HTMLButtonElement>('.ph-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.t as Tab
        this.render()
      }),
    )
    this.bind()
  }

  private screen(): string {
    const j = this.hooks.journal.data
    switch (this.tab) {
      case 'wallet': {
        const w = this.hooks.wallet()
        return `<h3>財布 <span>Wallet</span></h3>
          <div class="ph-card ic"><div>IC CARD</div><b>¥${w.ic.toLocaleString()}</b><small>Tap at gates, buses, vending machines and konbini. Charge at station machines or konbini.</small></div>
          <div class="ph-card cash"><div>現金 CASH</div><b>¥${w.cash.toLocaleString()}</b><small>Japan still loves cash: small shops, shrines and temples often take nothing else. Withdraw at konbini ATMs.</small></div>
          <p class="ph-note">Fortunes drawn: ${j.fortunes.length ? j.fortunes.slice(-4).reverse().join(' · ') : '—'}</p>`
      }
      case 'journal': {
        const ids = Object.keys(DISCOVERIES)
        const got = ids.filter((i) => j.discoveries[i])
        return `<h3>発見帳 <span>${got.length} / ${ids.length} discoveries</span></h3>
          <div class="ph-list">${ids
            .map((i) => {
              const d = DISCOVERIES[i]
              return j.discoveries[i]
                ? `<details><summary><b>${d.ja}</b> ${d.en}</summary><p>${d.text}</p></details>`
                : `<div class="locked">？？？ <span>Keep exploring</span></div>`
            })
            .join('')}</div>`
      }
      case 'stamps': {
        const eki = j.stamps.filter((s) => s.kind === 'eki')
        const seals = j.stamps.filter((s) => s.kind === 'goshuin')
        const prefs = j.places.filter((p) => /[都道府県]$/.test(p)).length
        return `<h3>スタンプ帳 <span>${eki.length} stations · ${seals.length} seals · ${prefs}/47 prefectures</span></h3>
          <div class="ph-stamps">${eki.map((s) => ekiStamp(s.name, s.sub, s.color, s.date)).join('') || '<p class="ph-note">Visit a station to collect its 駅スタンプ.</p>'}</div>
          <h4>御朱印帳</h4>
          <div class="ph-stamps">${seals.map((s) => goshuin(s.name, s.sub, s.date)).join('') || '<p class="ph-note">Ask for a 御朱印 at a shrine or temple office.</p>'}</div>`
      }
      case 'settings': {
        const st = this.hooks.status()
        const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
        const weathers: [WeatherPreset, string][] = [
          ['live', '実際 Real'],
          ['clear', '快晴 Clear'],
          ['cloudy', '曇り Cloudy'],
          ['rain', '雨 Rain'],
          ['storm', '雷雨 Storm'],
          ['snow', '雪 Snow'],
          ['fog', '霧 Fog'],
          ['typhoon', '台風 Typhoon'],
        ]
        return `<h3>設定 <span>Settings</span></h3>
          <label>Time of day <b class="ph-hour">${fmtHour(st.hour)}</b><input type="range" min="0" max="23.75" step="0.25" value="${st.hour}" class="ph-time"></label>
          <label>Season (month)<div class="ph-chips">${months.map((m, i) => `<button data-m="${i + 1}" class="${st.month === i + 1 ? 'on' : ''}">${m}</button>`).join('')}</div></label>
          <label>Weather<div class="ph-chips">${weathers.map(([w, l]) => `<button data-w="${w}" class="${st.weather === w ? 'on' : ''}">${l}</button>`).join('')}</div></label>
          <button class="ph-live ${st.live ? 'on' : ''}">⟲ Japan right now — real time and live weather</button>
          <label>Graphics<div class="ph-chips">${['low', 'medium', 'high', 'ultra'].map((q) => `<button data-q="${q}" class="${st.quality === q ? 'on' : ''}">${q}</button>`).join('')}</div></label>
          <p class="ph-note">Keys: WASD walk · Shift run · E use · V camera · M map · Tab phone · P photo mode · H hail taxi</p>
          <button class="ph-live ph-credits">Credits &amp; open data licences</button>`
      }
      case 'credits': {
        return `<h3>Credits <span>open data &amp; free assets</span></h3>
          <div class="ph-cred">
          <p><b>Map data</b> © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap / OpenMapTiles.</p>
          <p><b>Aerial photos, elevation, base maps</b> 国土地理院 Geospatial Information Authority of Japan (地理院タイル); elevation fill from Mapzen Terrarium (AWS Open Data).</p>
          <p><b>3D city models</b> Project PLATEAU, 国土交通省 MLIT (CC BY 4.0-compatible open data).</p>
          <p><b>Railways &amp; ridership</b> 国土数値情報 N02 鉄道 / S12 駅別乗降客数, 国土交通省 MLIT.</p>
          <p><b>Station &amp; line names</b> Wikidata (CC0).</p>
          <p><b>Population</b> Kontur Population dataset (CC BY 4.0).</p>
          <p><b>Weather</b> Open-Meteo.com (CC BY 4.0); climate normals after 気象庁 JMA.</p>
          <p><b>Sky &amp; clouds</b> @takram/three-atmosphere and three-clouds (MIT), Bruneton precomputed scattering.</p>
          <p><b>People</b> MakeHuman / MPFB2 (CC0), motion capture from Carnegie Mellon University Graphics Lab (free for any use).</p>
          <p><b>Engine</b> three.js, postprocessing, 3d-tiles-renderer, Rapier physics.</p>
          <p><b>3D models (CC BY 4.0)</b></p><div class="ph-models">Loading…</div>
          </div>`
      }
    }
  }

  private bind(): void {
    const time = this.el.querySelector<HTMLInputElement>('.ph-time')
    time?.addEventListener('input', () => {
      this.hooks.setHour(Number(time.value))
      const h = this.el.querySelector('.ph-hour')
      if (h) h.textContent = fmtHour(Number(time.value))
    })
    this.el.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => b.addEventListener('click', () => (this.hooks.setMonth(Number(b.dataset.m)), this.render())))
    this.el.querySelectorAll<HTMLButtonElement>('[data-w]').forEach((b) => b.addEventListener('click', () => (this.hooks.setWeather(b.dataset.w as WeatherPreset), this.render())))
    this.el.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.addEventListener('click', () => (this.hooks.setQuality(b.dataset.q as 'low'), this.render())))
    this.el.querySelector('.ph-live:not(.ph-credits)')?.addEventListener('click', () => (this.hooks.setLive(), this.render()))
    this.el.querySelector('.ph-credits')?.addEventListener('click', () => {
      this.tab = 'credits'
      this.render()
    })
    const models = this.el.querySelector('.ph-models')
    if (models)
      fetch(`${import.meta.env.BASE_URL}models/objs/CREDITS.json`)
        .then((r) => r.json())
        .then((list: { title: string; author: string; url: string; license: string }[]) => {
          models.innerHTML = list.map((m) => `<div>“${esc(m.title)}” by ${esc(m.author)} — <a href="${esc(m.url)}" target="_blank" rel="noopener">source</a> (${esc(m.license)})</div>`).join('')
        })
        .catch(() => (models.textContent = 'See public/models/objs/CREDITS.json'))
  }
}

function fmtHour(h: number): string {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** A round station stamp in the line colour. */
function ekiStamp(name: string, sub: string, color: string, date: string): string {
  const big = name.length > 4 ? 15 : 20
  return `<figure class="stamp"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="none" stroke="${color}" stroke-width="4"/>
    <circle cx="50" cy="50" r="38" fill="none" stroke="${color}" stroke-width="1.5"/>
    <text x="50" y="47" text-anchor="middle" font-size="${big}" font-weight="700" fill="${color}">${esc(name)}</text>
    <text x="50" y="64" text-anchor="middle" font-size="8" fill="${color}">${esc(sub)}</text>
    <text x="50" y="77" text-anchor="middle" font-size="7" fill="${color}">${date}</text></svg><figcaption>${esc(name)}駅</figcaption></figure>`
}

/** A goshuin: vertical brushed name with red seals. */
function goshuin(name: string, sub: string, date: string): string {
  const chars = [...name].slice(0, 7)
  return `<figure class="stamp seal"><svg viewBox="0 0 60 100"><rect x="2" y="2" width="56" height="96" fill="#fbf8f0" stroke="#d8d0c0"/>
    <text x="48" y="16" font-size="7" fill="#333" writing-mode="tb">${esc(sub)}</text>
    <rect x="17" y="30" width="26" height="26" fill="none" stroke="#c0272d" stroke-width="2.5" opacity=".85"/>
    <rect x="21" y="34" width="18" height="18" fill="#c0272d" opacity=".35"/>
    ${chars.map((c, i) => `<text x="30" y="${24 + i * 10.5}" text-anchor="middle" font-size="10" font-family="'Noto Serif JP',serif" fill="#111">${esc(c)}</text>`).join('')}
    <text x="10" y="94" font-size="5" fill="#333">${date}</text></svg><figcaption>${esc(name)}</figcaption></figure>`
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
