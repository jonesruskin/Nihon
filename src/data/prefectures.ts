// The 47 prefectures (都道府県): capital, population (2020 census, rounded),
// local specialities (名物), a phrase of the local dialect, and one fact.

export interface Prefecture {
  code: number
  ja: string
  en: string
  region: string
  capital: string
  pop: number // millions
  meibutsu: string
  dialect: string
  fact: string
}

export const PREFECTURES: Prefecture[] = [
  { code: 1, ja: '北海道', en: 'Hokkaido', region: '北海道', capital: '札幌', pop: 5.2, meibutsu: 'ジンギスカン grilled mutton · 海鮮丼 seafood bowls · 白い恋人', dialect: '「なまらうまい！」 — really delicious!', fact: 'Covers over a fifth of Japan’s land with only 4% of its people, and has no rainy season.' },
  { code: 2, ja: '青森県', en: 'Aomori', region: '東北', capital: '青森', pop: 1.24, meibutsu: 'りんご apples (Japan’s top grower) · 大間のマグロ tuna · せんべい汁', dialect: '「どさ？」「ゆさ。」 — Where to? To the bath.', fact: 'Every August giant illuminated paper floats parade through the Nebuta festival.' },
  { code: 3, ja: '岩手県', en: 'Iwate', region: '東北', capital: '盛岡', pop: 1.21, meibutsu: 'わんこそば bite-size soba · 盛岡冷麺 · 南部鉄器 iron kettles', dialect: '「じぇじぇじぇ！」 — whoa! (Kitasanriku)', fact: 'The largest prefecture on Honshu; Hiraizumi’s Golden Hall glitters with gold leaf.' },
  { code: 4, ja: '宮城県', en: 'Miyagi', region: '東北', capital: '仙台', pop: 2.3, meibutsu: '牛タン grilled beef tongue · ずんだ餅 edamame mochi · 笹かまぼこ', dialect: '「いぎなりうめぇ」 — seriously tasty', fact: 'Matsushima Bay, with its 260 pine-clad islets, is one of the Three Views of Japan.' },
  { code: 5, ja: '秋田県', en: 'Akita', region: '東北', capital: '秋田', pop: 0.96, meibutsu: 'きりたんぽ grilled rice sticks · 稲庭うどん · 秋田犬 Akita dogs', dialect: '「んだんだ」 — yes, exactly', fact: 'On New Year’s Eve, Namahage demons in straw capes visit homes to scold lazy children.' },
  { code: 6, ja: '山形県', en: 'Yamagata', region: '東北', capital: '山形', pop: 1.07, meibutsu: 'さくらんぼ cherries (three quarters of Japan’s) · 芋煮 · 米沢牛', dialect: '「めんごい」 — cute', fact: 'In winter the trees of Zao freeze into ‘snow monsters’ (樹氷).' },
  { code: 7, ja: '福島県', en: 'Fukushima', region: '東北', capital: '福島', pop: 1.83, meibutsu: '喜多方ラーメン · 桃 peaches · 赤べこ red cow toys', dialect: '「〜だべ」 — …right?', fact: 'Ouchi-juku keeps an Edo-period post town of thatched houses.' },
  { code: 8, ja: '茨城県', en: 'Ibaraki', region: '関東', capital: '水戸', pop: 2.87, meibutsu: '納豆 natto (Mito) · メロン melons · あんこう鍋 monkfish hotpot', dialect: '「いじやける」 — it’s annoying', fact: 'Kairakuen in Mito, one of the Three Great Gardens, blooms with 3,000 plum trees.' },
  { code: 9, ja: '栃木県', en: 'Tochigi', region: '関東', capital: '宇都宮', pop: 1.93, meibutsu: '宇都宮餃子 gyoza · とちおとめ strawberries · 湯波 yuba', dialect: '「だいじ？」 — are you OK?', fact: 'Nikko’s Toshogu is the lavish mausoleum of shogun Tokugawa Ieyasu.' },
  { code: 10, ja: '群馬県', en: 'Gunma', region: '関東', capital: '前橋', pop: 1.94, meibutsu: 'こんにゃく konjac (over 90%) · 焼きまんじゅう · 下仁田ねぎ', dialect: '「〜だんべ」 — …isn’t it', fact: 'Kusatsu Onsen has the largest natural hot-spring flow in Japan.' },
  { code: 11, ja: '埼玉県', en: 'Saitama', region: '関東', capital: 'さいたま', pop: 7.34, meibutsu: '草加せんべい rice crackers · 深谷ねぎ leeks · 狭山茶', dialect: 'Mostly standard Japanese — Tokyo’s commuter belt', fact: 'Kawagoe, ‘Little Edo’, keeps rows of black clay-walled kura warehouses.' },
  { code: 12, ja: '千葉県', en: 'Chiba', region: '関東', capital: '千葉', pop: 6.28, meibutsu: '落花生 peanuts · 太巻き祭りずし · びわ loquats', dialect: '「〜だっぺ」 — …right', fact: 'Narita Airport and Tokyo Disney Resort are both in Chiba.' },
  { code: 13, ja: '東京都', en: 'Tokyo', region: '関東', capital: '東京 (新宿)', pop: 14.0, meibutsu: '江戸前寿司 · もんじゃ焼き · 人形焼', dialect: '江戸っ子: 「てやんでえ！」 — nonsense!', fact: 'The world’s largest metropolitan area, home to about 37 million people.' },
  { code: 14, ja: '神奈川県', en: 'Kanagawa', region: '関東', capital: '横浜', pop: 9.24, meibutsu: '横浜中華街 Chinatown · シウマイ · しらす丼', dialect: '「〜じゃん」 — …isn’t it (born in Yokohama)', fact: 'Kamakura’s Great Buddha has sat outdoors since a tsunami swept its hall away in 1498.' },
  { code: 15, ja: '新潟県', en: 'Niigata', region: '中部', capital: '新潟', pop: 2.2, meibutsu: 'コシヒカリ rice · 日本酒 sake · へぎそば', dialect: '「うまいこて」 — so good', fact: 'Kawabata’s ‘Snow Country’ opens as a train leaves a tunnel into Niigata’s snow.' },
  { code: 16, ja: '富山県', en: 'Toyama', region: '中部', capital: '富山', pop: 1.03, meibutsu: 'ます寿司 trout sushi · ホタルイカ firefly squid · 白えび', dialect: '「きときと」 — super fresh', fact: 'In spring the Tateyama Kurobe Alpine Route runs between snow walls up to 20 m high.' },
  { code: 17, ja: '石川県', en: 'Ishikawa', region: '中部', capital: '金沢', pop: 1.13, meibutsu: '金箔 gold leaf (99% of Japan’s) · 加賀料理 · のどぐろ', dialect: '「来てくだしまっし」 — please come', fact: 'Kenrokuen in Kanazawa is one of the Three Great Gardens of Japan.' },
  { code: 18, ja: '福井県', en: 'Fukui', region: '中部', capital: '福井', pop: 0.77, meibutsu: '越前ガニ snow crab · ソースカツ丼 · 眼鏡 eyeglass frames', dialect: '「おぞい」 — shabby', fact: 'Over 90% of Japan’s eyeglass frames are made here — and it is rich in dinosaur fossils.' },
  { code: 19, ja: '山梨県', en: 'Yamanashi', region: '中部', capital: '甲府', pop: 0.81, meibutsu: 'ほうとう noodle stew · ぶどう & ワイン · 信玄餅', dialect: '「〜ずら」 — …I suppose', fact: 'The Fuji Five Lakes lie on Mt Fuji’s northern side.' },
  { code: 20, ja: '長野県', en: 'Nagano', region: '中部', capital: '長野', pop: 2.05, meibutsu: '信州そば soba · おやき · りんご', dialect: '「ずくがない」 — no get-up-and-go', fact: 'Snow monkeys bathe in the hot springs of Jigokudani; host of the 1998 Winter Olympics.' },
  { code: 21, ja: '岐阜県', en: 'Gifu', region: '中部', capital: '岐阜', pop: 1.98, meibutsu: '飛騨牛 Hida beef · 朴葉味噌 · 鵜飼 cormorant fishing', dialect: '「えらい」 — I’m tired', fact: 'Shirakawa-go’s gassho houses are thatched at 60° so the heavy snow slides off.' },
  { code: 22, ja: '静岡県', en: 'Shizuoka', region: '中部', capital: '静岡', pop: 3.63, meibutsu: 'お茶 green tea (about 40%) · うなぎ eel · 静岡おでん', dialect: '「〜だら」 — …isn’t it', fact: 'Mt Fuji’s southern slopes, and the bullet train’s famous view of it.' },
  { code: 23, ja: '愛知県', en: 'Aichi', region: '中部', capital: '名古屋', pop: 7.54, meibutsu: '味噌カツ · ひつまぶし eel over rice · 手羽先', dialect: '名古屋弁: 「でらうまい」 — damn tasty', fact: 'Toyota City is the heart of Japan’s car industry.' },
  { code: 24, ja: '三重県', en: 'Mie', region: '近畿', capital: '津', pop: 1.77, meibutsu: '松阪牛 Matsusaka beef · 伊勢海老 lobster · 赤福', dialect: '「〜やに」 — …you know', fact: 'Ise Jingu’s shrines are rebuilt every 20 years, as they have been since the 7th century.' },
  { code: 25, ja: '滋賀県', en: 'Shiga', region: '近畿', capital: '大津', pop: 1.41, meibutsu: '近江牛 · 鮒寿司 fermented carp · 信楽焼 tanuki', dialect: '「〜はる」 — gentle honorific', fact: 'Lake Biwa, Japan’s largest lake, covers about a sixth of the prefecture.' },
  { code: 26, ja: '京都府', en: 'Kyoto', region: '近畿', capital: '京都', pop: 2.58, meibutsu: '宇治抹茶 matcha · 八ツ橋 · 湯豆腐 · 京料理', dialect: '京ことば: 「おおきに」 — thank you', fact: 'Japan’s capital for over a thousand years (794–1869), with 17 UNESCO sites.' },
  { code: 27, ja: '大阪府', en: 'Osaka', region: '近畿', capital: '大阪', pop: 8.84, meibutsu: 'たこ焼き · お好み焼き · 串カツ', dialect: '「なんでやねん！」 — why on earth?!', fact: '‘Japan’s kitchen’: the local motto 食い倒れ means eating until you drop.' },
  { code: 28, ja: '兵庫県', en: 'Hyogo', region: '近畿', capital: '神戸', pop: 5.47, meibutsu: '神戸牛 Kobe beef · 明石焼 · 灘の酒 sake', dialect: '「何しとう？」 — what are you up to?', fact: 'Himeji Castle, the White Heron, has stood since 1609.' },
  { code: 29, ja: '奈良県', en: 'Nara', region: '近畿', capital: '奈良', pop: 1.32, meibutsu: '柿の葉寿司 · 奈良漬 · 葛 kudzu sweets', dialect: '「〜やんか」 — …you know', fact: 'Some 1,300 sacred deer roam Nara Park — and bow for crackers.' },
  { code: 30, ja: '和歌山県', en: 'Wakayama', region: '近畿', capital: '和歌山', pop: 0.92, meibutsu: '梅干し pickled plums · みかん · 和歌山ラーメン', dialect: '「ほんま？」 — really?', fact: 'Koyasan’s temples and the Kumano Kodo pilgrim trails are UNESCO World Heritage.' },
  { code: 31, ja: '鳥取県', en: 'Tottori', region: '中国', capital: '鳥取', pop: 0.55, meibutsu: '二十世紀梨 pears · 松葉ガニ crab · らっきょう', dialect: '「〜だけぇ」 — because…', fact: 'Japan’s least populous prefecture, with sand dunes stretching 16 km along the coast.' },
  { code: 32, ja: '島根県', en: 'Shimane', region: '中国', capital: '松江', pop: 0.67, meibutsu: '出雲そば · しじみ clams · のどぐろ', dialect: 'Izumo’s ‘zuzu-ben’, famously hard to follow', fact: 'In October every god in Japan gathers at Izumo Taisha — so there the month is 神在月.' },
  { code: 33, ja: '岡山県', en: 'Okayama', region: '中国', capital: '岡山', pop: 1.89, meibutsu: 'きびだんご · 白桃 white peaches · マスカット', dialect: '「でーれー」 — super', fact: 'Home of Momotaro, the Peach Boy, and the canals of Kurashiki.' },
  { code: 34, ja: '広島県', en: 'Hiroshima', region: '中国', capital: '広島', pop: 2.8, meibutsu: 'お好み焼き (layered with noodles) · 牡蠣 oysters · もみじ饅頭', dialect: '「〜じゃけぇ」 — because…', fact: 'Itsukushima Shrine’s great torii seems to float on the sea at high tide.' },
  { code: 35, ja: '山口県', en: 'Yamaguchi', region: '中国', capital: '山口', pop: 1.34, meibutsu: 'ふぐ pufferfish · 瓦そば · 外郎', dialect: '「〜ちょる」 — is doing', fact: 'Kintaikyo, a five-arched wooden bridge, was first built in 1673.' },
  { code: 36, ja: '徳島県', en: 'Tokushima', region: '四国', capital: '徳島', pop: 0.72, meibutsu: 'すだち · 鳴門金時 sweet potato · 徳島ラーメン', dialect: '「〜じょ」 — …you see', fact: 'Awa Odori: ‘fools who dance and fools who watch — if you’re a fool anyway, dance!’' },
  { code: 37, ja: '香川県', en: 'Kagawa', region: '四国', capital: '高松', pop: 0.95, meibutsu: '讃岐うどん · 骨付鳥 · 和三盆', dialect: '「せないかん」 — gotta do it', fact: 'Japan’s smallest prefecture calls itself the ‘Udon Prefecture’.' },
  { code: 38, ja: '愛媛県', en: 'Ehime', region: '四国', capital: '松山', pop: 1.33, meibutsu: 'みかん · 鯛めし sea bream rice · じゃこ天', dialect: '「〜ぞなもし」 — old Matsuyama politeness', fact: 'Dogo Onsen is said to be Japan’s oldest hot spring, some 3,000 years old.' },
  { code: 39, ja: '高知県', en: 'Kochi', region: '四国', capital: '高知', pop: 0.69, meibutsu: 'カツオのたたき seared bonito · ゆず · 芋けんぴ', dialect: '土佐弁: 「〜ぜよ」 — …I tell you', fact: 'Birthplace of Sakamoto Ryoma, hero of the Meiji Restoration.' },
  { code: 40, ja: '福岡県', en: 'Fukuoka', region: '九州', capital: '福岡', pop: 5.14, meibutsu: '博多ラーメン tonkotsu · 明太子 · もつ鍋', dialect: '博多弁: 「すいとうよ」 — I like you', fact: 'At night yatai street stalls line the river in Nakasu.' },
  { code: 41, ja: '佐賀県', en: 'Saga', region: '九州', capital: '佐賀', pop: 0.81, meibutsu: '有田焼 porcelain · 呼子のイカ squid · 佐賀牛', dialect: '「がばい」 — very', fact: 'Arita has fired porcelain since 1616, when Japan’s first kaolin was found here.' },
  { code: 42, ja: '長崎県', en: 'Nagasaki', region: '九州', capital: '長崎', pop: 1.31, meibutsu: 'ちゃんぽん · カステラ · 皿うどん', dialect: '「よかよ」 — that’s fine', fact: 'Dejima was Japan’s only window on Europe for two centuries.' },
  { code: 43, ja: '熊本県', en: 'Kumamoto', region: '九州', capital: '熊本', pop: 1.74, meibutsu: '馬刺し horse sashimi · 熊本ラーメン · からし蓮根', dialect: '「あとぜき」 — close the door behind you', fact: 'Mt Aso’s caldera is one of the largest in the world; Kumamon is its bear.' },
  { code: 44, ja: '大分県', en: 'Oita', region: '九州', capital: '大分', pop: 1.12, meibutsu: 'とり天 chicken tempura · 関サバ mackerel · かぼす', dialect: '「〜ちゃ」 — …you know', fact: 'More hot springs than anywhere in Japan — Beppu and Yufuin.' },
  { code: 45, ja: '宮崎県', en: 'Miyazaki', region: '九州', capital: '宮崎', pop: 1.07, meibutsu: 'チキン南蛮 · マンゴー · 宮崎牛', dialect: '「てげうまい」 — really tasty', fact: 'Takachiho Gorge is the stage of Japan’s founding myths.' },
  { code: 46, ja: '鹿児島県', en: 'Kagoshima', region: '九州', capital: '鹿児島', pop: 1.59, meibutsu: '黒豚 black pork · 芋焼酎 sweet-potato shochu · 白熊 shaved ice', dialect: '薩摩弁: 「〜でごわす」 — it is so', fact: 'Sakurajima, an active volcano across the bay, regularly dusts the city with ash.' },
  { code: 47, ja: '沖縄県', en: 'Okinawa', region: '沖縄', capital: '那覇', pop: 1.47, meibutsu: 'ゴーヤーチャンプルー · 沖縄そば · 泡盛 · サーターアンダギー', dialect: 'うちなーぐち: 「めんそーれ」 — welcome · 「なんくるないさ」 — it’ll work out', fact: 'The Ryukyu Kingdom was independent until 1879; Okinawans are among the longest-lived people on Earth.' },
]
