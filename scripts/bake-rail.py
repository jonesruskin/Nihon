# Bake Japan's entire railway network into public/data/rail.json.
#
# Inputs (free / open data, downloaded beforehand):
#   MLIT 国土数値情報 N02 (railway sections + stations), UTF-8 GeoJSON
#     https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-23/N02-23_GML.zip
#   Wikidata station + line labels (English, kana readings, line colours)
#     via the SPARQL queries in scripts/README-data.md
#
# Usage: python3 -I scripts/bake-rail.py <N02 UTF-8 dir> <wd_stations.csv> <wd_lines.csv> public/data/rail.json
#
# Output: lines, stations, and station-to-station links along the real track
# geometry (simplified to ~2 m, delta-encoded 1e-5 degree integers).
import csv, heapq, json, math, re, sys
from collections import defaultdict

n02_dir, wd_st_path, wd_ln_path, out_path = sys.argv[1:5]
s12_path = sys.argv[5] if len(sys.argv) > 5 else None  # MLIT S12 passengers per station (optional)
rails = json.load(open(f'{n02_dir}/N02-23_RailroadSection.geojson', encoding='utf-8'))['features']
stations_raw = json.load(open(f'{n02_dir}/N02-23_Station.geojson', encoding='utf-8'))['features']

Q = 1e5  # quantisation: 1e-5 deg (~1 m)

METRO_OPS = {'東京地下鉄', '大阪市高速電気軌道', '名古屋市', '札幌市', '横浜市', '京都市', '神戸市', '仙台市', '福岡市'}
YOKOHAMA = {'1号線': 'ブルーライン', '3号線': 'ブルーライン', '4号線': 'グリーンライン'}


def clean_name(op, name):
    if op == '横浜市' and name in YOKOHAMA:
        return YOKOHAMA[name]
    m = re.match(r'^\d+号線[（(](.+)[)）]$', name)
    if m:
        return m.group(1)
    name = re.sub(r'^\d+号線', '', name)
    return name or name


def kind_of(p):
    t, cls, op, name = p['N02_001'], p['N02_002'], p['N02_004'], p['N02_003']
    if cls == '1':
        return 'shinkansen'
    if t in ('13',):
        return 'cable'
    if t in ('14', '15', '22'):
        return 'monorail'
    if t in ('16', '23', '24') and op != '札幌市':
        return 'agt'
    if op in METRO_OPS or (op == '東京都' and t == '12'):
        return 'metro'
    if t == '21':
        return 'tram'
    if cls == '2':
        return 'jr'
    return 'private'


# ---------------------------------------------------------------- Wikidata
def norm(s):
    return re.sub(r'[\s　・ー\-]', '', s or '')


wd_st = defaultdict(list)
for row in csv.DictReader(open(wd_st_path, encoding='utf-8')):
    ja = row['ja'] or ''
    m = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', row['coord'] or '')
    if not ja or not m:
        continue
    base = re.sub(r'(駅|停留場|停留所|電停)$', '', re.sub(r'[（(].*?[)）]', '', ja))
    en = re.sub(r'\s+(Station|Stop|Tram Stop|Stn\.?)$', '', re.sub(r'\s*\(.*?\)', '', row['en'] or ''))
    # Operator-prefixed labels ("Keikyu Corporation Shinagawa", "Tokyo Metro Ginza")
    en = re.sub(r'^(JR|Keikyu|Keio|Tokyu|Odakyu|Seibu|Tobu|Keisei|Hankyu|Hanshin|Kintetsu|Nankai|Keihan|Meitetsu|Sotetsu|Toei|Tokyo Metro|Osaka Metro|Kyoto Municipal Subway|Yokohama Municipal Subway|Fukuoka City Subway|Nagoya Municipal Subway|Sapporo Municipal Subway|Kobe Municipal Subway|Sendai Subway)( Corporation| Railway| Electric Railway| Railways| Line)?\s+', '', en)
    kana = re.sub(r'(えき|ていりゅうじょう|ていりゅうしょ)$', '', row['kana'] or '')
    wd_st[norm(base)].append((float(m.group(2)), float(m.group(1)), en, kana))

wd_ln = defaultdict(list)
for row in csv.DictReader(open(wd_ln_path, encoding='utf-8')):
    wd_ln[row['op'] or ''].append((row['ja'] or '', row['en'] or '', row['hex'] or ''))


def line_meta(op, raw, clean):
    best = None
    for ja, en, hexc in wd_ln.get(op, []):
        score = 0
        if ja == clean or ja == raw:
            score = 3
        elif ja.endswith(clean) and len(clean) >= 2:
            score = 2
        elif clean in ja and len(clean) >= 2:
            score = 1
        if score and hexc:
            score += 0.5
        if score and (best is None or score > best[0]):
            best = (score, en, hexc)
    if not best:
        return '', ''
    return best[1], ('#' + best[2].upper()) if re.fullmatch(r'[0-9A-Fa-f]{6}', best[2] or '') else ''


def haversine(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008 * math.asin(math.sqrt(min(1, h)))


# ---------------------------------------------------------------- lines
line_ids = {}
lines = []
line_feats = defaultdict(list)
for f in rails:
    p = f['properties']
    key = (p['N02_004'], p['N02_003'])
    if key not in line_ids:
        clean = clean_name(*key)
        en, color = line_meta(key[0], key[1], clean)
        line_ids[key] = len(lines)
        lines.append({'ja': clean, 'en': en, 'op': key[0], 'kind': kind_of(p), 'color': color})
    line_feats[line_ids[key]].append(f['geometry']['coordinates'])

# ---------------------------------------------------------------- stations
stations = []
seen_station = set()
for f in stations_raw:
    p = f['properties']
    key = (p['N02_004'], p['N02_003'])
    if key not in line_ids:
        continue
    cs = f['geometry']['coordinates']
    mid = cs[len(cs) // 2] if len(cs) % 2 else [(cs[len(cs) // 2 - 1][0] + cs[len(cs) // 2][0]) / 2, (cs[len(cs) // 2 - 1][1] + cs[len(cs) // 2][1]) / 2]
    lat, lon = mid[1], mid[0]
    name = p['N02_005']
    en, kana, bd = '', '', 3000
    # Nearest candidate within 1.5 km; among close ones prefer the plainest name.
    best = None
    for wlat, wlon, wen, wkana in wd_st.get(norm(re.sub(r'[（(].*?[)）]', '', name)), []):
        d = haversine((lat, lon), (wlat, wlon))
        if (wen or wkana) and d < 3000:
            score = d + len(wen) * 15 + (0 if wkana else 400)
            if best is None or score < best[0]:
                best = (score, wen, wkana)
    if best:
        en, kana = best[1], best[2]
    li = line_ids[key]
    # N02 splits some stations into several platform features: merge them.
    dup = next((s for s in stations if s['line'] == li and s['ja'] == name and haversine((s['lat'], s['lon']), (lat, lon)) < 1500), None) \
        if (li, name) in seen_station else None
    seen_station.add((li, name))
    if dup:
        dup['geom'] = dup['geom'] + cs
        continue
    stations.append({'ja': name, 'kana': kana, 'en': en, 'line': li, 'group': p['N02_005g'], 'lat': lat, 'lon': lon, 'geom': cs})

# ---------------------------------------------------------------- ridership
riders = {}
if s12_path:
    for f in json.load(open(s12_path, encoding='utf-8'))['features']:
        p = f['properties']
        # Daily passengers: the larger of 2019 (pre-pandemic) and 2022.
        vals = [p.get('S12_041') or 0, p.get('S12_053') or 0]
        key = (p['S12_002'], p['S12_003'], p['S12_001'])
        riders[key] = riders.get(key, 0) + max(vals)
raw_line = {v: k for k, v in line_ids.items()}
for st in stations:
    op, ln = raw_line[st['line']]
    st['riders'] = riders.get((op, ln, st['ja']), 0)

# ---------------------------------------------------------------- per-line graphs
def qk(c):
    return (round(c[1] * Q), round(c[0] * Q))


def simplify(pts, tol):
    # Douglas-Peucker on local metres.
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][0] / Q)
    xy = [((p[1] / Q) * 111320 * math.cos(lat0), (p[0] / Q) * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]; bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            d = abs((xy[i][0] - ax) * dy - (xy[i][1] - ay) * dx) / L
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi)); stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


links = []
paths = []
by_line = defaultdict(list)
for i, s in enumerate(stations):
    by_line[s['line']].append(i)

for li, feats in line_feats.items():
    adj = defaultdict(dict)
    pos = {}
    for cs in feats:
        prev = None
        for c in cs:
            k = qk(c)
            pos[k] = (k[0] / Q, k[1] / Q)
            if prev is not None and prev != k:
                d = haversine(pos[prev], pos[k])
                adj[prev][k] = d
                adj[k][prev] = d
            prev = k
    # Heal small gaps between segment ends (data is split at municipality borders etc.)
    ends = [k for k, v in adj.items() if len(v) == 1]
    for i, a in enumerate(ends):
        for b in ends[i + 1:]:
            if b not in adj[a]:
                d = haversine(pos[a], pos[b])
                if d < 25:
                    adj[a][b] = d
                    adj[b][a] = d
    # Snap stations to their own line: every station vertex shared with the
    # track becomes a node of that station (stations share track vertices).
    st_node = {}
    nodes = list(adj.keys())
    for si in by_line.get(li, []):
        s = stations[si]
        hits = [qk(c) for c in s['geom'] if qk(c) in adj]
        if not hits:
            best, bd = None, 1e18
            for k in nodes:
                d = haversine((s['lat'], s['lon']), pos[k])
                if d < bd:
                    best, bd = k, d
            if best is not None and bd < 400:
                hits = [best]
        for k in hits:
            st_node.setdefault(k, si)
    node_st = st_node
    st_nodes = defaultdict(list)
    for k, si in st_node.items():
        st_nodes[si].append(k)
    # From each station, Dijkstra until other stations are hit (do not pass through them).
    seen_pairs = set()
    for si, srcs in st_nodes.items():
        dist = {k: 0.0 for k in srcs}
        prev = {}
        pq = [(0.0, k) for k in srcs]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18):
                continue
            if u in node_st and node_st[u] != si:
                sj = node_st[u]
                pair = (min(si, sj), max(si, sj))
                if pair not in seen_pairs:
                    seen_pairs.add(pair)
                    chain = [u]
                    while chain[-1] in prev:
                        chain.append(prev[chain[-1]])
                    chain.reverse()
                    if si > sj:
                        chain.reverse()
                    pts = simplify(chain, 2.0)
                    flat = []
                    px = py = 0
                    for k in pts:
                        flat += [k[0] - px, k[1] - py]
                        px, py = k
                    links.append([pair[0], pair[1], li, round(d), len(paths)])
                    paths.append(flat)
                continue
            if d > 250000:
                continue
            for v, w in adj[u].items():
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))

# Parallel tracks (freight lines, loops) create bypass links A-C next to A-B-C.
# Real trains on the line stop at B, so drop the bypass.
nbr = defaultdict(dict)
for l in links:
    nbr[(l[2], l[0])][l[1]] = l[3]
    nbr[(l[2], l[1])][l[0]] = l[3]
def bypass(l):
    a, c, li, d = l[0], l[1], l[2], l[3]
    for b, ab in nbr[(li, a)].items():
        bc = nbr[(li, b)].get(c)
        if b != c and bc is not None and ab + bc < d * 1.15:
            return True
    return False
links = [l for l in links if not bypass(l)]

# Drop stations that never got linked (data glitches), remap ids.
used = set()
for l in links:
    used.add(l[0]); used.add(l[1])
remap = {}
out_st = []
for i, s in enumerate(stations):
    if i in used:
        remap[i] = len(out_st)
        out_st.append([s['ja'], s['kana'], s['en'], s['line'], int(s['group']), round(s['lat'] * Q), round(s['lon'] * Q), s.get('riders', 0)])
out_links = [[remap[a], remap[b], li, d, pi] for a, b, li, d, pi in links]
out_lines = [[l['ja'], l['en'], l['op'], l['kind'], l['color']] for l in lines]

json.dump({
    'source': '国土数値情報 鉄道データ N02-23 / 駅別乗降客数 S12-23 (MLIT), Wikidata (CC0)',
    'lines': out_lines,
    'stations': out_st,
    'links': out_links,
    'paths': paths,
}, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

print('lines', len(out_lines), 'stations', len(out_st), '/', len(stations), 'links', len(out_links),
      'pts', sum(len(p) for p in paths) // 2,
      'en', sum(1 for s in out_st if s[2]), 'kana', sum(1 for s in out_st if s[1]),
      'colored', sum(1 for l in out_lines if l[4]), 'line_en', sum(1 for l in out_lines if l[1]),
      'riders', sum(1 for s in out_st if s[7]))
