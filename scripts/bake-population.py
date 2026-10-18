# Bake Kontur Population (CC BY 4.0, H3 res-8 hexagons) for Japan into a
# sparse 0.01-degree grid: public/data/population.bin
#   u32 count, then count x (u16 row, u16 col, u16 people) sorted by (row, col)
#   row = floor((lat - 20) * 100), col = floor((lon - 122) * 100)
# Usage: python3 -I scripts/bake-population.py kontur_population_JP.gpkg public/data/population.bin
import math, sqlite3, struct, sys
from collections import defaultdict

src, dst = sys.argv[1:3]
db = sqlite3.connect(src)
cells = defaultdict(float)


def wkb_centroid(blob):
    # GeoPackage header: 'GP', version, flags, srs_id, envelope
    flags = blob[3]
    env = (flags >> 1) & 0x07
    env_len = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]
    off = 8 + env_len
    if env_len >= 32:
        minx, maxx, miny, maxy = struct.unpack_from('<dddd' if flags & 1 else '>dddd', blob, 8)
        return (minx + maxx) / 2, (miny + maxy) / 2
    le = blob[off] == 1
    fmt = '<' if le else '>'
    gtype, nrings = struct.unpack_from(fmt + 'II', blob, off + 1)
    npts, = struct.unpack_from(fmt + 'I', blob, off + 9)
    xs = ys = 0.0
    for i in range(npts):
        x, y = struct.unpack_from(fmt + 'dd', blob, off + 13 + i * 16)
        xs += x
        ys += y
    return xs / npts, ys / npts


R = 6378137.0
n = 0
for geom, pop in db.execute('select geom, population from population'):
    x, y = wkb_centroid(geom)
    # EPSG:3857 -> WGS84
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    if not (20 <= lat < 46 and 122 <= lon < 154):
        continue
    cells[(int((lat - 20) * 100), int((lon - 122) * 100))] += pop
    n += 1

items = sorted((k, min(65535, round(v))) for k, v in cells.items() if v >= 1)
with open(dst, 'wb') as f:
    f.write(struct.pack('<I', len(items)))
    for (r, c), p in items:
        f.write(struct.pack('<HHH', r, c, p))
total = sum(p for _, p in items)
print('hexes', n, 'cells', len(items), 'people', total, 'max', max(p for _, p in items))
