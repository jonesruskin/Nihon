// The traveller's notebook: discoveries (発見帳) that explain what you just
// experienced, the station stamps (駅スタンプ) and shrine seals (御朱印) you
// collect, fortunes drawn, places visited. Saved in this browser.

export interface Discovery {
  ja: string
  en: string
  text: string
}

export const DISCOVERIES: Record<string, Discovery> = {
  vending: { ja: '自動販売機', en: 'Vending machines', text: 'Japan has about 4 million vending machines — one for every 30 people. In winter many sell hot drinks: look for the red あったか〜い (warm) labels; blue つめた〜い means cold.' },
  konbini: { ja: 'コンビニ', en: 'Convenience stores', text: 'Some 56,000 konbini stay open 24 hours. Staff will ask 「温めますか？」 — shall I heat it? — for bento. You can pay bills, send parcels, print, and withdraw cash at the ATM.' },
  shokken: { ja: '食券機', en: 'Meal-ticket machines', text: 'Many ramen and gyūdon shops sell tickets from a machine by the door. Buy the ticket, hand it to the counter, and wait. Slurping noodles is perfectly polite.' },
  shrine: { ja: '神社', en: 'Shinto shrines', text: 'Pass through the torii (gate), rinse your hands at the 手水舎, toss a coin, ring the bell, then 二礼二拍手一礼: bow twice, clap twice, pray, bow once. Japan has over 80,000 shrines.' },
  temple: { ja: 'お寺', en: 'Buddhist temples', text: 'At temples you bow and pray quietly — no clapping. Wafting incense smoke over yourself is said to bring good health.' },
  omikuji: { ja: 'おみくじ', en: 'Fortune slips', text: 'From 大吉 (great blessing) to 凶 (curse). If your fortune is bad, tie it to the rack so the misfortune stays at the shrine.' },
  goshuin: { ja: '御朱印', en: 'Shrine seals', text: 'Priests or monks brush the name of the shrine or temple and press red seals into your 御朱印帳 book. It is a record of worship, not a souvenir stamp.' },
  ekistamp: { ja: '駅スタンプ', en: 'Station stamps', text: 'Most stations keep a rubber stamp with a local motif by the ticket gates. Collecting them is a beloved hobby — and a stamp rally.' },
  train: { ja: '電車', en: 'Riding the train', text: 'Trains leave to the second — average delay on the Shinkansen is under a minute. Keep calls off (マナーモード), queue at the floor markings, and let people off first.' },
  shinkansen: { ja: '新幹線', en: 'The Shinkansen', text: 'Since 1964 the bullet train has carried billions of passengers without a single passenger fatality from a derailment or collision. Nozomi trains reach 285 km/h; Hayabusa, 320.' },
  subway: { ja: '地下鉄', en: 'The subway', text: "Tokyo's subways carry ~8 million people a day. Lines have colours and letters (G = Ginza, M = Marunouchi) and stations have numbers, so G-09 is Ginza on the Ginza line." },
  ic: { ja: 'ICカード', en: 'IC cards', text: 'Suica, PASMO, ICOCA and friends work on trains, buses, vending machines and konbini nationwide. Tap — ピッ — and go.' },
  taxi: { ja: 'タクシー', en: 'Taxis', text: 'The rear left door opens and closes automatically — don’t touch it. A red 空車 sign means vacant. There is no tipping in Japan.' },
  bus: { ja: 'バス', en: 'Buses', text: 'In Tokyo you board at the front and pay a flat fare. In many other cities you board at the back, take a numbered ticket, and pay by distance when you get off.' },
  scramble: { ja: 'スクランブル交差点', en: 'Scramble crossings', text: "At Shibuya every car light turns red at once and up to 3,000 people cross in all directions — diagonals included. The crossing chimes are birdsong: ピヨピヨ and カッコー tell blind pedestrians which way is green." },
  keepleft: { ja: '左側通行', en: 'Keep left', text: 'Japan drives on the left, and people mostly walk on the left too — except on Osaka escalators, where you stand on the right.' },
  umbrella: { ja: '傘', en: 'Umbrellas', text: 'Japan uses ~120 million umbrellas a year, many of them clear vinyl ビニール傘 from konbini. Shops have umbrella stands or plastic sleeves at the door.' },
  snow: { ja: '雪国', en: 'Snow country', text: 'Siberian winds pick up moisture over the Sea of Japan and dump it on the western mountains — some towns get over 10 m of snow a season, among the snowiest inhabited places on Earth.' },
  sakura: { ja: '花見', en: 'Cherry blossom viewing', text: 'The cherry-blossom front (桜前線) moves north from Okinawa in January to Hokkaido in May. Blossoms last about a week; people picnic under them day and night.' },
  koyo: { ja: '紅葉', en: 'Autumn leaves', text: 'Autumn colour moves the other way, from Hokkaido in October down to Kyushu in December. Japanese maples (紅葉, momiji) turn crimson.' },
  night: { ja: '夜の街', en: 'The city at night', text: 'Neon kanban signs, glowing vending machines and late konbini make Japanese cities some of the safest places in the world to wander at night.' },
  omiyage: { ja: 'お土産', en: 'Omiyage', text: 'Travellers bring back the local speciality of wherever they went — individually wrapped so it can be shared at the office. Every prefecture is famous for something, and stations sell it boxed and ready.' },
  gamecenter: { ja: 'ゲームセンター', en: 'Game centres', text: 'Japan’s arcades survived the home-console age: crane games (UFOキャッチャー), rhythm games, mahjong machines and purikura photo booths fill multi-storey buildings near stations.' },
  karaoke: { ja: 'カラオケ', en: 'Karaoke', text: 'Invented in Kobe around 1971. In Japan you rent a private room by the hour with friends or colleagues — or alone (ヒトカラ) to practise.' },
  rush: { ja: '通勤ラッシュ', en: 'Rush hour', text: 'At 8:00 trains on the busiest lines run at up to 200% of capacity. Platform staff — 押し屋 — once helped push people aboard.' },
  tsuyu: { ja: '梅雨', en: 'Rainy season', text: 'From early June to mid-July a stationary front brings weeks of drizzle to everywhere but Hokkaido. Hydrangeas bloom; humidity soars.' },
  typhoon: { ja: '台風', en: 'Typhoons', text: 'Around 25 typhoons form each year; a few hit Japan, mostly between August and October. Trains stop, shutters close, and convenience stores sell out of bread.' },
  hotel: { ja: '旅館', en: 'Where to stay', text: 'From capsule hotels to ryokan inns with tatami rooms, futons, yukata robes and multi-course kaiseki dinners. Take your shoes off at the genkan.' },
  onsen: { ja: '温泉', en: 'Hot springs', text: 'Wash thoroughly at the taps before entering, keep your small towel out of the water, and soak quietly. Japan has around 3,000 onsen areas.' },
  driving: { ja: '軽自動車', en: 'Kei cars', text: 'Tiny kei cars (max 3.4 m long, 660 cc) are a third of new cars sold — cheaper tax and insurance, and they fit Japan’s narrow lanes.' },
  izakaya: { ja: '居酒屋', en: 'Izakaya', text: 'Japanese pubs serve small plates to share. A small appetiser — お通し — arrives unasked and is the cover charge. Say 乾杯! (kanpai) before drinking.' },
  cafe: { ja: '喫茶店', en: 'Kissaten coffee', text: 'Old-style kissaten serve slow pour-over coffee and a morning set of thick toast and egg. Many still allow you to stay for hours.' },
  bins: { ja: 'ゴミ', en: 'Where are the bins?', text: 'Public bins are rare. People carry rubbish home and sort it into burnable, plastics, cans and bottles. Konbini have bins for what you buy there.' },
  melody: { ja: '発車メロディ', en: 'Departure melodies', text: 'Many stations play their own short jingle before the doors close, often a local song — Takadanobaba plays Astro Boy, Ebisu the beer advert theme.' },
  quiet: { ja: '車内マナー', en: 'Quiet carriages', text: 'Talking on the phone in trains is frowned upon, and conversations are kept soft. Priority seats (優先席) are for elderly, disabled and pregnant passengers.' },
}

export interface Stamp {
  kind: 'eki' | 'goshuin'
  id: string
  name: string
  sub: string
  color: string
  date: string
}

interface SaveData {
  discoveries: Record<string, string>
  stamps: Stamp[]
  fortunes: string[]
  places: string[]
}

const KEY = 'nihon-journal-v1'

export class Journal {
  data: SaveData = { discoveries: {}, stamps: [], fortunes: [], places: [] }
  onDiscover: ((id: string, d: Discovery) => void) | null = null

  constructor() {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) }
    } catch {
      // private mode or blocked storage: keep an in-memory journal
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data))
    } catch {
      // ignore
    }
  }

  discover(id: string): boolean {
    const d = DISCOVERIES[id]
    if (!d || this.data.discoveries[id]) return false
    this.data.discoveries[id] = new Date().toISOString()
    this.save()
    this.onDiscover?.(id, d)
    return true
  }

  /** In-game date source (stamps are dated with the day you were there). */
  today: () => string = () => new Date().toISOString().slice(0, 10)

  stamp(s: Omit<Stamp, 'date'>): boolean {
    if (this.data.stamps.some((x) => x.kind === s.kind && x.id === s.id)) return false
    this.data.stamps.push({ ...s, date: this.today() })
    this.save()
    return true
  }

  fortune(f: string): void {
    this.data.fortunes.push(f)
    this.save()
  }

  visit(place: string): boolean {
    if (this.data.places.includes(place)) return false
    this.data.places.push(place)
    this.save()
    return true
  }
}
