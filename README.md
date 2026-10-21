# 日本 NIHON — all of Japan, rebuilt from open data

Walk, drive and ride the trains through **the whole of Japan** — every street, rice field, mountain,
station and shrine — in your browser. Nothing is hand-modelled per place: the world is streamed and
built on the fly from free government and community data. It looks the way it does because it *is*
the real place: real aerial photographs on real terrain, real 3D city models, the real railway network,
real population and station ridership driving the crowds, and the real weather right now.

> Fully free and open: no paid services, no API keys, no logins.

## What you can do

- **Explore anywhere** — start at the Shibuya Scramble, fast-travel from the map (<kbd>M</kbd>) to
  60+ curated places or anywhere you click, in first or third person (<kbd>V</kbd>).
- **Drive** Japanese cars — kei cars, kei trucks, taxis, sedans, light trucks, buses — with
  raycast-vehicle physics, on the left, among AI traffic that stops at signals.
- **Ride every railway in Japan** — enter any of ~10,000 stations (<kbd>E</kbd>), search a destination,
  get a route with transfers, times and real fares, tap your IC card and ride: commuter EMUs with
  line-colour liveries, Tokyo Metro, the N700 / E5 / E7 Shinkansen, trams. Sit on the bench and watch
  the city go by, take the driver's-cab view, or skip ahead (<kbd>T</kbd>). Subways run in tunnels with
  station halls; trains run on the real track geometry, on viaducts and under catenary.
- **Ferries** — walk into a ferry terminal (フェリーのりば), read the departures and buy a ticket: routes
  are traced from OpenStreetMap across the sea to the far port (the ten-minute JR hop to Miyajima, the
  Kerama islands from Naha, the 740 km overnight boat from Ōarai to Tomakomai). Stand on deck as the
  coast slides by, or skip ahead (<kbd>T</kbd>) on long voyages.
- **Domestic flights** — check in at any of 31 airports and fly the real network (hubs to everywhere,
  island hops via Naha and Kagoshima, no planes where the Shinkansen is quicker); the clock moves on by
  the block time and you walk out of arrivals at the other end.
- **Taxis and buses** — hail a taxi (<kbd>H</kbd>), pick a destination on the map, watch the Tokyo meter.
  Buses follow the local rules: a flat fare paid at the front as you board in Tokyo, Yokohama,
  Kawasaki and Nagoya; flat fares paid on the way out in Kyoto and Osaka; and everywhere else the
  rural system — board at the rear, take a numbered ticket (整理券), read your fare off the board.
- **Crowds that match reality** — pedestrians at the true local density for the hour (packed Shibuya
  at 18:00, a handful in a mountain village), walking the real sidewalks and keeping left. At
  Shibuya the cars all stop and people flood the Scramble in every direction. Everyone, you
  included, dresses for the actual temperature: T-shirts and white shirts in August, jackets and
  long sleeves in January.
- **Weather and seasons** — live weather at your spot (or the recorded weather for any past date):
  clouds, rain with wet streets and umbrellas, snow that settles, fog, typhoons; the sakura front in
  spring and autumn colours in November, by latitude and altitude. Fireworks festivals (花火大会)
  fire on their real nights — Sumidagawa, Nagaoka, Ōmagari, the Tenjin Matsuri, Lake Tōya every
  summer evening — with chrysanthemum shells, willows and star mines, crowds on the riverbanks, and
  the boom arriving after the flash at the speed of sound. Woods are filled in at true
  forest density around you — cedar plantations on the mountains, broadleaf groves in the lowlands.
- **Be a tourist** — vending machines (hot drinks in winter), konbini, ramen with ticket machines,
  izakaya, kissaten, station bento (駅弁) to eat on the train, souvenir shops selling each prefecture’s 名物, game centres, karaoke, shrines
  (purify, 二礼二拍手一礼, omikuji, goshuin), temples, onsen, hotels and ryokan. Collect station
  stamps and shrine seals; fill your discovery journal (発見帳) with 35 cultural notes that unlock as you experience them.
- **Phone** (<kbd>Tab</kbd>) — wallet, journal, stamp book, and settings for time of day, season,
  weather and graphics. **Photo mode** (<kbd>P</kbd>, <kbd>Space</kbd> to save).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm test           # unit tests (rail routing, fares, crowd density, vector tiles)
```

URL parameters: `?lat=35.0&lon=135.77&heading=90` start position · `t=2026-04-01T09:00:00+09:00` or
`t=19:30` time · `weather=rain|snow|fog|storm|typhoon|clear|cloudy` · `quality=low|medium|high|ultra` ·
`mode=fly` · `debug`.

### Controls

| Key | Action |
| --- | --- |
| WASD / mouse | walk, look (click to capture the mouse) |
| Shift / Shift+X | run / sprint |
| E | use: stations, shops, shrines, vending machines, cars, taxis |
| V | first / third person (in trains: seat / cab / outside) |
| M | map and fast travel |
| Tab | phone |
| H | hail a taxi |
| T / Shift+T | (on a train) skip to the next station / to your destination |
| P / Space | photo mode / save photo |
| F / G | fly / land |

On phones and tablets: drag anywhere on the left half to walk (or drive), drag on the right half to
look, and use the on-screen buttons for use, jump, run, view, skip, taxi, map and phone.

### Benchmark

Open the game with `?bench` (optionally `&quality=high`) to run a fixed test: it visits Shibuya, Gion
and the Iya valley, turns a full circle at each and shows frame-time percentiles (p50/p95/p99), draw
calls and triangles per frame. `JSON.stringify(nihonBench)` in the console copies the numbers.

## How it works

| Layer | Source | Notes |
| --- | --- | --- |
| Terrain | GSI elevation tiles (dem5a/dem_png), Terrarium fill | quadtree, exact surface sampler shared with physics |
| Ground texture | GSI seamless aerial photos | real imagery of all of Japan |
| Buildings | PLATEAU 3D Tiles (MLIT), OSM elsewhere | procedural facade shader by usage: offices, マンション, 雑居ビル signage, houses with kawara roofs, temples |
| Streets | OpenFreeMap vector tiles (OSM) | Japanese road markings, kerbs, tactile paving, poles and wires, lamps, vending machines, platforms, catenary |
| Railways | MLIT 国土数値情報 N02 + Wikidata | 597 lines, 10k stations, routing, fares; S12 ridership |
| Population | Kontur Population | 1 km grid, 123 M people |
| Weather | Open-Meteo, JMA normals | live / historical / climate |
| Sky | @takram/three-atmosphere + three-clouds | physically based sky, sun, moon, volumetric clouds |
| People | MakeHuman (CC0) + CMU mocap | full skinned avatar; crowds as GPU vertex-animation instances |

Code map: `src/core` (geodesy, floating origin, tiles), `src/render` (pipeline, materials, night
lights), `src/world` (terrain, PLATEAU, vector tiles, props), `src/physics`, `src/player`,
`src/vehicles` (driving, road graph, traffic), `src/transit` (rail network, trains, rides, tunnels),
`src/people` (characters, crowds, density, scramble), `src/weather`, `src/tourism`, `src/audio`, `src/ui`.

### Rebuilding the baked data

```bash
# Railways: MLIT N02 (UTF-8 GeoJSON) + Wikidata labels + S12 ridership
python3 -I scripts/bake-rail.py N02-23/UTF-8 wd_stations.csv wd_lines.csv public/data/rail.json S12-23_NumberOfPassengers.geojson
# Population: Kontur gpkg
python3 -I scripts/bake-population.py kontur_population_JP.gpkg public/data/population.bin
# PLATEAU city index
node scripts/bake-plateau.mjs
# Characters and crowd LODs (Blender 4.2 + MPFB2), masters in assets-src/
blender -b --python scripts/blender/make_humans.py -- --out assets-src/models/people --mocap <cmu-bvh-dir> [--only a,b]
blender -b --python scripts/blender/make_crowd.py -- assets-src/models/people public/models/crowd [a,b]
# Shipped models: KTX2 textures + Draco geometry from the masters (needs KTX-Software's toktx)
node scripts/optimize-assets.mjs [filter]
```

Characters are retargeted from CMU motion capture relative to each skeleton's rest pose, with eight
different walkers assigned by archetype and a real standing idle. `scripts/blender/pose_sheet.py`
renders a front/side contact sheet of any GLB's clips and prints posture measurements (shoulder drop,
head pitch, trunk lean, step width) used as the gate for re-bakes.

### Quality checks

```bash
npx vite build && npx vite preview --port 4173 &
node scripts/qa.mjs            # 12 scenes → screenshots/qa/report.html (night readability, traffic, people, frame budget)
node scripts/qa-load.mjs       # bytes, requests and seconds to play on an emulated 20 Mbps link
node scripts/qa-profile.mjs    # main-thread CPU profile of steady play
node scripts/e2e.mjs           # gameplay scenarios (dev server)
```

The Wikidata CSVs come from two SPARQL queries (stations: `wdt:P31/wdt:P279* wd:Q55488` in Japan with
ja/en labels, kana `P1814` and coordinates; lines: `wd:Q728937` with `P465` colours and operator).

## Deploying

`.github/workflows/pages.yml` builds and deploys to GitHub Pages on pushes to `main`. Enable it once in
the repository settings: *Settings → Pages → Build and deployment → Source: GitHub Actions*.

## Credits and licences

Map data © OpenStreetMap contributors (ODbL), tiles via OpenFreeMap / OpenMapTiles · 地理院タイル,
国土地理院 · Project PLATEAU, 国土交通省 · 国土数値情報 (N02 鉄道, S12 駅別乗降客数), 国土交通省 ·
Wikidata (CC0) · Kontur Population (CC BY 4.0) · Open-Meteo (CC BY 4.0) · climate normals after 気象庁 ·
MakeHuman / MPFB2 (CC0) · CMU Graphics Lab Motion Capture Database · three.js, postprocessing,
@takram/three-geospatial, 3d-tiles-renderer, Rapier. 3D models under CC BY 4.0 are listed with
authors and sources in `public/models/objs/CREDITS.json` and in-game (Phone → Settings → Credits).
Vehicles and trains are generic and unbranded.
