// 駅弁: the boxed lunches sold at stations, each a little portrait of its
// region, bought on the platform and eaten on the train. Famous ones by
// station; any Shinkansen stop at least has a 幕の内 makunouchi.

export type Ekiben = [ja: string, en: string, price: number]

const BY_STATION: Record<string, Ekiben[]> = {
  東京: [['深川めし', 'Clams simmered with leeks over rice — old Edo fishermen’s food', 1250], ['牛肉弁当', 'Sliced beef on rice', 1500]],
  品川: [['深川めし', 'Clams simmered with leeks over rice', 1250]],
  横浜: [['シウマイ弁当', 'Kiyoken’s shumai bento, a Yokohama classic since 1954', 1000]],
  新横浜: [['シウマイ弁当', 'Kiyoken’s shumai bento', 1000]],
  小田原: [['鯛めし', 'Sea-bream flakes over rice', 1080]],
  横川: [['峠の釜めし', 'Kamameshi in a Mashiko clay pot you keep', 1300]],
  高崎: [['だるま弁当', 'Rice and mountain vegetables in a daruma-shaped box', 1200]],
  米沢: [['牛肉どまん中', 'Yonezawa beef over Yamagata rice', 1350]],
  仙台: [['牛たん弁当', 'Grilled beef tongue — pull the string and it heats itself', 1500]],
  新潟: [['えび千両ちらし', 'Seafood hidden under a sheet of rolled omelette', 1500]],
  富山: [['ますのすし', 'Pressed trout sushi in a bamboo-leaf ring', 1600]],
  金沢: [['加賀百万石弁当', 'Kaga-style dishes in a lacquered box', 1500]],
  長野: [['信州名物 牛めし', 'Shinshu beef rice', 1200]],
  静岡: [['東海道 鯛めし', 'Bream rice from the old Tokaido', 1100]],
  名古屋: [['ひつまぶし弁当', 'Eel over rice, Nagoya style', 1650], ['天むす', 'Tempura-shrimp rice balls', 800]],
  京都: [['京のおばんざい弁当', 'Kyoto home-style dishes', 1300]],
  新大阪: [['八角弁当', 'Osaka’s octagonal assorted bento', 1250]],
  岡山: [['桃太郎の祭ずし', 'Festival sushi in a peach-shaped box', 1250]],
  広島: [['しゃもじかきめし', 'Oyster rice in a rice-paddle box', 1300]],
  博多: [['かしわめし', 'Chicken and egg strips over chicken-stock rice', 900]],
  鹿児島中央: [['黒豚弁当', 'Kagoshima black-pork bento', 1300]],
  札幌: [['石狩鮭めし', 'Salmon and roe over rice', 1250]],
  森: [['いかめし', 'Squid stuffed with sticky rice', 980]],
  函館: [['かにめし', 'Hairy-crab flakes over rice', 1300]],
  新函館北斗: [['いかめし', 'Squid stuffed with sticky rice', 980]],
}

const MAKUNOUCHI: Ekiben = ['幕の内弁当', 'Makunouchi — a little of everything, made for theatre intervals', 1100]

/** What the station sells: its famous bento, or a makunouchi at long-distance stops. */
export function ekibenAt(stationJa: string, longDistance: boolean): Ekiben[] {
  const own = BY_STATION[stationJa.replace(/駅$/, '')]
  if (own) return own
  return longDistance ? [MAKUNOUCHI] : []
}
