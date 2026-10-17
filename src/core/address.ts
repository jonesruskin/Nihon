// Where am I? GSI's reverse geocoder (free, CORS) gives the municipality
// code and the neighbourhood (町丁目) for any point in Japan; the baked
// GSI municipality table names the city and prefecture.

export interface Address {
  prefCode: number
  pref: string
  city: string
  area: string
}

export class AddressLookup {
  private muni: Record<string, [number, string, string]> | null = null
  private cache = new Map<string, Address | null>()
  private inflight = false
  last: Address | null = null

  async load(): Promise<void> {
    this.muni = await (await fetch(`${import.meta.env.BASE_URL}data/muni.json`)).json()
  }

  /** Non-blocking: returns the last known address and refreshes in the background. */
  query(lat: number, lon: number): Address | null {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`
    if (this.cache.has(key)) return (this.last = this.cache.get(key) ?? this.last)
    if (!this.inflight && this.muni) {
      this.inflight = true
      fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`)
        .then((r) => r.json())
        .then((j) => {
          const code = String(parseInt(j?.results?.muniCd ?? '', 10))
          const m = this.muni![code]
          const a: Address | null = m ? { prefCode: m[0], pref: m[1], city: m[2], area: String(j.results.lv01Nm ?? '').replace('－', '') } : null
          this.cache.set(key, a)
          if (a) this.last = a
        })
        .catch(() => this.cache.set(key, null))
        .finally(() => (this.inflight = false))
    }
    return this.last
  }
}
