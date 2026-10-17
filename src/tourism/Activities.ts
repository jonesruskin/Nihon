// What a traveller can do at the places around them: buy from vending
// machines and konbini, eat (with the meal-ticket machine), worship at
// shrines and temples (purify, offer, bow-bow-clap-clap-bow, draw a
// fortune, receive a goshuin), soak in an onsen, check into a hotel.
import { Vector3, type Group } from 'three'
import type { Poi } from '../world/vector/build'
import type { Journal } from './Journal'

export type SpotKind = 'vending' | 'konbini' | 'ramen' | 'food' | 'cafe' | 'izakaya' | 'shrine' | 'temple' | 'hotel' | 'onsen'

export interface Spot {
  kind: SpotKind
  name: string
  nameEn: string
  pos: Vector3
}

export interface ActivityHost {
  wallet: () => { cash: number; ic: number }
  pay: (yen: number, method: 'cash' | 'ic') => boolean
  addCash: (yen: number) => void
  toast: (html: string, ms?: number) => void
  journal: Journal
  hour: () => number
  temperature: () => number
  raining: () => boolean
  passTime: (minutes: number) => void
  sleepUntilMorning: () => void
  sound: (name: 'ic' | 'can' | 'bell' | 'clap' | 'coin' | 'chime') => void
}

const KONBINI = /セブン|ファミリーマート|ファミマ|ローソン|ミニストップ|デイリー|セイコーマート|ポプラ|NewDays|ニューデイズ|7-Eleven|FamilyMart|Lawson/i

function classify(p: Poi): SpotKind | null {
  const n = p.name
  if (p.cls === 'shop' && p.sub === 'convenience') return 'konbini'
  if (KONBINI.test(n)) return 'konbini'
  if (p.cls === 'place_of_worship' || /神社|大社|神宮|稲荷|八幡|天満宮|宮$/.test(n)) {
    if (/寺|院|堂|観音|不動|大師/.test(n) && !/神社|神宮|大社/.test(n)) return 'temple'
    if (/神社|大社|神宮|稲荷|八幡|天満宮|宮|殿|社|鳥居/.test(n)) return 'shrine'
    return p.cls === 'place_of_worship' ? 'temple' : null
  }
  if (/温泉|の湯|湯屋|銭湯|スパ/.test(n) || p.sub === 'public_bath') return 'onsen'
  if (p.cls === 'lodging' || /ホテル|旅館|イン$|Hotel|Inn/.test(n)) return 'hotel'
  if (/ラーメン|らーめん|拉麺|麺|そば|うどん|牛丼|吉野家|松屋|すき家/.test(n)) return 'ramen'
  if (p.cls === 'bar' || p.cls === 'beer' || /居酒屋|酒場|焼鳥|やきとり/.test(n)) return 'izakaya'
  if (p.cls === 'cafe' || /珈琲|コーヒー|喫茶|カフェ|Cafe|Coffee|スターバックス|ドトール/.test(n)) return 'cafe'
  if (p.cls === 'restaurant' || p.cls === 'fast_food' || p.cls === 'ice_cream') return 'food'
  return null
}

/** Places to do things, from the loaded map tiles (refreshed as tiles stream). */
export class SpotIndex {
  spots: Spot[] = []
  private sig = ''

  update(tiles: Array<{ key: string; build: { pois: Poi[]; instances: Record<string, Float32Array> }; group: Group }>): void {
    const sig = tiles.map((t) => t.key).join('|')
    if (sig === this.sig) return
    this.sig = sig
    this.spots = []
    for (const t of tiles) {
      t.group.updateWorldMatrix(true, false)
      const m = t.group.matrixWorld
      for (const p of t.build.pois) {
        const kind = classify(p)
        if (!kind) continue
        this.spots.push({ kind, name: p.name, nameEn: p.nameEn, pos: new Vector3(p.x, p.y, p.z).applyMatrix4(m) })
      }
      const v = t.build.instances.vending
      if (v)
        for (let i = 0; i < v.length; i += 6)
          this.spots.push({ kind: 'vending', name: '自動販売機', nameEn: 'Vending machine', pos: new Vector3(v[i], v[i + 1], v[i + 2]).applyMatrix4(m) })
    }
  }

  invalidate(): void {
    this.sig = ''
  }

  nearest(p: Vector3): Spot | null {
    let best: Spot | null = null
    let bd = Infinity
    for (const s of this.spots) {
      const reach = s.kind === 'vending' ? 2.2 : s.kind === 'shrine' || s.kind === 'temple' ? 40 : 16
      const d = Math.hypot(s.pos.x - p.x, s.pos.z - p.z)
      if (d < reach && Math.abs(s.pos.y - p.y) < 8 && d / reach < bd) {
        bd = d / reach
        best = s
      }
    }
    return best
  }
}

export function spotPrompt(s: Spot): string {
  const label: Record<SpotKind, string> = {
    vending: 'Buy a drink',
    konbini: 'Go into the konbini',
    ramen: 'Eat here (食券機)',
    food: 'Eat here',
    cafe: 'Have a coffee',
    izakaya: 'Drop into the izakaya',
    shrine: 'Visit the shrine',
    temple: 'Visit the temple',
    hotel: 'Check in',
    onsen: 'Soak in the onsen',
  }
  return `<kbd>E</kbd>${label[s.kind]} <span style="opacity:.75">${esc(s.name)}</span>`
}

// ------------------------------------------------------------ panel

interface Option {
  label: string
  sub?: string
  price?: number
  method?: 'cash' | 'ic'
  run: () => void | Option[] | string
}

export class ActivityPanel {
  readonly el: HTMLDivElement
  open = false
  private spot: Spot | null = null

  constructor(
    parent: HTMLElement,
    private host: ActivityHost,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'station activity'
    parent.appendChild(this.el)
    this.el.addEventListener('keydown', (e) => e.stopPropagation())
  }

  show(spot: Spot): void {
    this.spot = spot
    this.open = true
    this.el.classList.add('open')
    this.render(this.optionsFor(spot), this.intro(spot))
  }

  hide(): void {
    this.open = false
    this.el.classList.remove('open')
  }

  private render(options: Option[], text: string): void {
    const s = this.spot!
    const w = this.host.wallet()
    this.el.innerHTML = `<div class="st-card">
      <button class="st-close">×</button>
      <div class="act-head"><div class="act-name">${esc(s.name)}</div><div class="act-en">${esc(s.nameEn || kindName(s.kind))}</div></div>
      <div class="act-text">${text}</div>
      <div class="act-opts">${options
        .map((o, i) => `<button data-i="${i}"><b>${o.label}</b>${o.sub ? `<span>${o.sub}</span>` : ''}${o.price ? `<em>¥${o.price.toLocaleString()}</em>` : ''}</button>`)
        .join('')}</div>
      <div class="st-wallet">IC card <b>¥${w.ic.toLocaleString()}</b> · cash ¥${w.cash.toLocaleString()}</div>
    </div>`
    this.el.querySelector('.st-close')!.addEventListener('click', () => this.hide())
    this.el.querySelectorAll<HTMLButtonElement>('.act-opts button').forEach((b) =>
      b.addEventListener('click', () => {
        const o = options[Number(b.dataset.i)]
        if (o.price && !this.host.pay(o.price, o.method ?? 'cash')) return
        const r = o.run()
        if (Array.isArray(r)) this.render(r, '')
        else if (typeof r === 'string') this.render(this.optionsFor(s), r)
        else this.hide()
      }),
    )
  }

  private intro(s: Spot): string {
    const h = this.host.hour()
    switch (s.kind) {
      case 'vending':
        return this.host.temperature() < 18 ? 'Hot drinks have red <b>あったか〜い</b> labels, cold ones blue <b>つめた〜い</b>. Pay with coins or tap your IC card.' : 'Rows of cold drinks — <b>つめた〜い</b>. Tap your IC card on the reader.'
      case 'konbini':
        return '「いらっしゃいませ！」 — the staff greet you as the door chime plays.'
      case 'ramen':
        return 'A ticket machine (食券機) stands by the door. Buy your ticket, hand it over at the counter, and wait.'
      case 'food':
        return h < 11 ? 'They are just opening. A morning set (モーニング) is on the board.' : 'You are shown to a table with a cold glass of water and an oshibori towel.'
      case 'cafe':
        return 'Quiet jazz, the smell of pour-over coffee.'
      case 'izakaya':
        return h < 17 ? 'The noren curtain is not out yet — izakaya open in the evening.' : '「いらっしゃい！」 A small appetiser (お通し) arrives without asking: it is the table charge.'
      case 'shrine':
        return 'You pass under the <b>torii</b> — bowing slightly at the gate — and walk along the side of the path; the centre is for the gods.'
      case 'temple':
        return 'Incense smoke drifts from the great burner in front of the main hall.'
      case 'hotel':
        return 'The front desk greets you. Shoes off at the genkan if it is a ryokan.'
      case 'onsen':
        return 'Separate baths for men (男) and women (女) behind the noren curtains.'
    }
  }

  private optionsFor(s: Spot): Option[] {
    const H = this.host
    const j = H.journal
    const hot = H.temperature() < 18
    switch (s.kind) {
      case 'vending': {
        j.discover('vending')
        const drinks = hot
          ? [['ホットコーヒー', 'Hot canned coffee', 140], ['ほうじ茶', 'Roasted green tea (hot)', 160], ['コーンスープ', 'Corn soup — shake the can!', 150], ['ミルクティー', 'Royal milk tea (hot)', 160]]
          : [['緑茶', 'Green tea', 160], ['スポーツドリンク', 'Isotonic drink', 160], ['アイスコーヒー', 'Black iced coffee', 140], ['天然水', 'Mineral water', 110], ['ラムネ', 'Ramune soda', 180]]
        return drinks.map(([ja, en, price]) => ({
          label: String(ja),
          sub: String(en),
          price: Number(price),
          method: 'ic' as const,
          run: () => {
            H.sound('ic')
            setTimeout(() => H.sound('can'), 350)
            H.toast(`ピッ… <b>ガコン</b> — ${ja} drops into the tray. ${hot ? 'Warm hands!' : 'Ice cold.'}`)
          },
        }))
      }
      case 'konbini': {
        j.discover('konbini')
        const opts: Option[] = [
          { label: 'おにぎり', sub: 'Rice ball — salmon, tuna-mayo or umeboshi', price: 160, method: 'ic', run: () => H.toast('Pull tab 1, then 2 and 3 — the nori stays crisp. 「袋はご利用ですか？」 Do you need a bag?') },
          { label: 'お弁当', sub: '「温めますか？」 — heated for you', price: 580, method: 'ic', run: () => (H.passTime(15), H.toast('The microwave pings. You eat at the eat-in counter by the window.')) },
          { label: 'からあげ', sub: 'Fried chicken from the hot case', price: 240, method: 'ic', run: () => H.toast('Crispy, hot, in a paper sleeve.') },
          { label: 'メロンパン', sub: 'Sweet melon bread', price: 150, method: 'ic', run: () => H.toast('No melon in it — the name comes from the cookie crust pattern.') },
        ]
        if (H.raining()) opts.unshift({ label: 'ビニール傘', sub: 'Clear vinyl umbrella', price: 700, method: 'ic', run: () => (H.journal.discover('umbrella'), H.toast('You buy the iconic clear umbrella. Leave it in the stand at the door of shops.')) })
        opts.push(
          { label: 'ICカード チャージ', sub: 'Top up ¥3,000 at the register', run: () => (H.pay(3000, 'cash') ? (H.wallet().ic += 3000, H.sound('ic'), 'Charged ¥3,000 onto your IC card.') : 'Not enough cash.') },
          { label: 'ATM', sub: 'Withdraw ¥10,000 (foreign cards OK)', run: () => (H.addCash(10000), 'The ATM counts out ten ¥1,000 notes.') },
        )
        return opts
      }
      case 'ramen':
        j.discover('shokken')
        return [
          { label: 'ラーメン', sub: 'Shoyu ramen', price: 900, run: () => (H.passTime(20), H.toast('The bowl arrives in minutes. Slurping cools the noodles — and shows you enjoy them. ごちそうさまでした!')) },
          { label: 'つけ麺', sub: 'Dipping noodles', price: 1000, run: () => (H.passTime(25), H.toast('Cold noodles, hot rich broth. Ask for スープ割り to thin the leftover broth and drink it.')) },
          { label: '牛丼', sub: 'Beef bowl with miso soup', price: 500, run: () => (H.passTime(12), H.toast('Fast, cheap and filling — a salaryman classic.')) },
        ]
      case 'food':
        return [
          { label: '定食', sub: 'Set meal: grilled fish, rice, miso, pickles', price: 1100, run: () => (H.passTime(35), H.toast('いただきます before, ごちそうさまでした after. Pay at the register by the door.')) },
          { label: 'カレーライス', sub: 'Japanese curry rice', price: 850, run: () => (H.passTime(25), H.toast('Sweeter and thicker than Indian curry — a national comfort food.')) },
          { label: '寿司 ランチ', sub: 'Sushi lunch set', price: 1800, run: () => (H.passTime(40), H.toast('Eat nigiri in one bite, fish-side down into the soy sauce. Hands are fine.')) },
        ]
      case 'cafe':
        j.discover('cafe')
        return [
          { label: 'ブレンドコーヒー', sub: 'House blend, pour-over', price: 550, run: () => (H.passTime(30), H.toast('Unhurried. Nobody rushes you here.')) },
          { label: 'モーニングセット', sub: 'Thick toast, boiled egg, coffee', price: 650, run: () => (H.passTime(30), H.toast(H.hour() < 11 ? 'The classic Nagoya-style morning set.' : 'They kindly make it even though it is past 11.')) },
        ]
      case 'izakaya':
        j.discover('izakaya')
        return [
          { label: '生ビール', sub: 'Draught beer — 乾杯!', price: 600, run: () => (H.passTime(30), H.toast('乾杯! Pour for others, never for yourself.')) },
          { label: '焼き鳥 盛り合わせ', sub: 'Assorted yakitori', price: 900, run: () => (H.passTime(40), H.toast('Salt (塩) or sauce (タレ)? The chef recommends salt.')) },
          { label: 'お会計', sub: 'The bill — with お通し table charge', price: 400, run: () => H.toast('Say 「お会計お願いします」 or cross your index fingers ✕. No tipping.') },
        ]
      case 'shrine':
        j.discover('shrine')
        return this.shrineSteps(s)
      case 'temple':
        j.discover('temple')
        return [
          { label: 'お線香', sub: 'Light incense and waft the smoke over you', price: 100, run: () => 'The smoke is said to heal whatever part of the body you waft it to.' },
          { label: 'お参り', sub: 'Offer a coin, bow, pray quietly (no clapping)', price: 5, run: () => (H.sound('coin'), H.sound('bell'), 'A deep bronze bell sounds. You put your hands together and bow.') },
          ...this.fortuneAndSeal(s),
        ]
      case 'hotel':
        j.discover('hotel')
        return [
          { label: 'ビジネスホテル', sub: 'Business hotel — sleep until morning', price: 8800, run: () => (H.sleepUntilMorning(), H.toast('Compact room, spotless bathroom, breakfast at 7. おはようございます!')) },
          { label: '旅館', sub: 'Ryokan with kaiseki dinner — sleep until morning', price: 22000, run: () => (H.sleepUntilMorning(), H.toast('Tatami, futon, yukata, a 12-course kaiseki dinner and a dawn bath. 最高!')) },
        ]
      case 'onsen':
        j.discover('onsen')
        return [
          { label: '入浴', sub: 'Wash first, then soak (40 minutes)', price: 800, run: () => (H.passTime(40), H.toast('Scrub at the taps, then slip into 42 °C water. Towels stay out of the bath. ああ…')) },
        ]
    }
  }

  /** Shrine visit: purification, offering, 二礼二拍手一礼, fortune, seal. */
  private shrineSteps(s: Spot): Option[] {
    const H = this.host
    const seq: string[] = []
    const want = ['bow', 'bow', 'clap', 'clap', 'bow']
    const step = (a: 'bow' | 'clap'): Option[] | string => {
      seq.push(a)
      if (a === 'clap') H.sound('clap')
      const ok = seq.every((x, i) => x === want[i])
      if (!ok) {
        seq.length = 0
        return 'Not quite — at shrines it is <b>二礼二拍手一礼</b>: bow, bow, clap, clap, (pray), bow. Try again.'
      }
      if (seq.length === want.length) {
        seq.length = 0
        return '<b>Perfect.</b> 二礼二拍手一礼 — two bows, two claps, a silent prayer, one bow. The kami have heard you.'
      }
      return [prayBow, prayClap, ...rest]
    }
    const prayBow: Option = { label: '礼', sub: 'Bow deeply (90°)', run: () => step('bow') }
    const prayClap: Option = { label: '拍手', sub: 'Clap', run: () => step('clap') }
    const rest = this.fortuneAndSeal(s)
    return [
      { label: '手水舎', sub: 'Purify: left hand, right hand, mouth, handle', run: () => 'Ladle in the right hand, rinse the left; switch; pour into your cupped left hand to rinse your mouth; tip the ladle upright to wash its handle.' },
      { label: 'お賽銭', sub: 'Toss a ¥5 coin (ご縁 = good connections) and ring the bell', price: 5, run: () => (H.sound('coin'), H.sound('bell'), [prayBow, prayClap, ...rest]) },
      ...rest,
    ]
  }

  private fortuneAndSeal(s: Spot): Option[] {
    const H = this.host
    return [
      {
        label: 'おみくじ',
        sub: 'Shake the box, draw a numbered stick, get your fortune',
        price: 200,
        run: () => {
          H.journal.discover('omikuji')
          const f = drawFortune()
          H.journal.fortune(`${f.rank} · ${s.name}`)
          return `<div class="omikuji"><div class="om-rank">${f.rank}</div><div class="om-en">${f.en}</div>${f.lines.map((l) => `<div>${l}</div>`).join('')}</div>${f.bad ? '<p>Tie it to the rack (おみくじ掛け) to leave the bad luck here.</p>' : '<p>Keep it in your wallet for luck.</p>'}`
        },
      },
      {
        label: '御朱印',
        sub: 'A brushed seal in your goshuin book',
        price: 500,
        run: () => {
          H.journal.discover('goshuin')
          const added = H.journal.stamp({ kind: 'goshuin', id: s.name, name: s.name, sub: s.kind === 'shrine' ? '奉拝' : '参拝', color: '#c0272d' })
          return added ? `The ${s.kind === 'shrine' ? 'priest' : 'monk'} brushes <b>${esc(s.name)}</b> and today’s date, and presses the red seal. Added to your stamp book.` : 'You already have this seal in your book.'
        },
      },
    ]
  }
}

function drawFortune(): { rank: string; en: string; bad: boolean; lines: string[] } {
  const ranks: [string, string, number][] = [
    ['大吉', 'Great blessing', 0.16],
    ['中吉', 'Middle blessing', 0.2],
    ['小吉', 'Small blessing', 0.15],
    ['吉', 'Blessing', 0.22],
    ['末吉', 'Future blessing', 0.12],
    ['凶', 'Curse', 0.13],
    ['大凶', 'Great curse', 0.02],
  ]
  let r = Math.random()
  let pick = ranks[0]
  for (const k of ranks) {
    if (r < k[2]) {
      pick = k
      break
    }
    r -= k[2]
  }
  const good = !pick[0].includes('凶')
  const pool = (g: string[], b: string[]) => (good ? g : b)[Math.floor(Math.random() * 3)]
  return {
    rank: pick[0],
    en: pick[1],
    bad: !good,
    lines: [
      `願望 Wishes — ${pool(['will come true', 'come true with patience', 'are answered unexpectedly'], ['are delayed', 'need more effort', 'should be humbler'])}`,
      `旅行 Travel — ${pool(['go east, good things await', 'a fine time for a journey', 'an encounter changes your plans'], ['take care with belongings', 'avoid long journeys for now', 'check timetables twice'])}`,
      `失物 Lost items — ${pool(['will be found nearby', 'turn up when you stop looking', 'someone will return it'], ['hard to find', 'look low and in the north', 'may be gone'])}`,
    ],
  }
}

function kindName(k: SpotKind): string {
  return { vending: 'Vending machine', konbini: 'Convenience store', ramen: 'Noodle shop', food: 'Restaurant', cafe: 'Café', izakaya: 'Izakaya', shrine: 'Shinto shrine', temple: 'Buddhist temple', hotel: 'Hotel', onsen: 'Hot spring' }[k]
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
