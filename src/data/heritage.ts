// Historic townscapes (mostly 重要伝統的建造物群保存地区, Important Preservation
// Districts for Groups of Traditional Buildings): inside these, small
// buildings are drawn in the local vernacular instead of modern facades.

export type HeritageStyle = 'machiya' | 'gassho' | 'kayabuki' | 'ryukyu'

export interface HeritageZone {
  name: string
  lat: number
  lon: number
  radius: number // m
  style: HeritageStyle
}

export const HERITAGE: HeritageZone[] = [
  { name: '祇園・産寧坂', lat: 35.0003, lon: 135.778, radius: 900, style: 'machiya' },
  { name: '先斗町', lat: 35.0065, lon: 135.7705, radius: 260, style: 'machiya' },
  { name: '上七軒', lat: 35.0279, lon: 135.7425, radius: 300, style: 'machiya' },
  { name: '嵯峨鳥居本', lat: 35.0284, lon: 135.6681, radius: 400, style: 'machiya' },
  { name: '高山 三町', lat: 36.1405, lon: 137.2604, radius: 450, style: 'machiya' },
  { name: '金沢 ひがし茶屋街', lat: 36.5726, lon: 136.667, radius: 300, style: 'machiya' },
  { name: '川越 蔵造り', lat: 35.9213, lon: 139.4831, radius: 400, style: 'machiya' },
  { name: '倉敷 美観地区', lat: 34.5951, lon: 133.772, radius: 400, style: 'machiya' },
  { name: 'ならまち', lat: 34.677, lon: 135.829, radius: 450, style: 'machiya' },
  { name: '妻籠宿', lat: 35.5778, lon: 137.5958, radius: 400, style: 'machiya' },
  { name: '馬籠宿', lat: 35.5266, lon: 137.5655, radius: 300, style: 'machiya' },
  { name: '奈良井宿', lat: 35.9686, lon: 137.8114, radius: 500, style: 'machiya' },
  { name: '角館', lat: 39.5967, lon: 140.5617, radius: 400, style: 'machiya' },
  { name: '萩', lat: 34.4127, lon: 131.3925, radius: 400, style: 'machiya' },
  { name: '内子', lat: 33.537, lon: 132.6532, radius: 300, style: 'machiya' },
  { name: '知覧', lat: 31.373, lon: 130.438, radius: 300, style: 'machiya' },
  { name: '白川郷 荻町', lat: 36.257, lon: 136.906, radius: 750, style: 'gassho' },
  { name: '五箇山 相倉', lat: 36.4246, lon: 136.9313, radius: 260, style: 'gassho' },
  { name: '五箇山 菅沼', lat: 36.4141, lon: 136.8818, radius: 200, style: 'gassho' },
  { name: '大内宿', lat: 37.3337, lon: 139.8613, radius: 260, style: 'kayabuki' },
  { name: '美山 かやぶきの里', lat: 35.2879, lon: 135.6229, radius: 300, style: 'kayabuki' },
  { name: '竹富島', lat: 24.3326, lon: 124.088, radius: 700, style: 'ryukyu' },
]
