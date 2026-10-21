"""Gate N: how readable is a night frame? Median luminance of the street part
of the frame (lower 55%, HUD excluded) and the share of near-black pixels.
Usage: python3 scripts/qa_lum.py shot.png [...]"""
import sys
from PIL import Image

for path in sys.argv[1:]:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    street = im.crop((0, int(h * 0.42), w, int(h * 0.88))).resize((320, 120))
    whole = im.crop((0, int(h * 0.06), w, int(h * 0.88))).resize((320, 180))
    def lum(img):
        px = list(img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata())
        return sorted((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 for r, g, b in px)
    s = lum(street)
    a = lum(whole)
    med = s[len(s) // 2]
    black = sum(1 for v in a if v < 0.02) / len(a)
    ok = med >= 0.06 and black < 0.25
    print(f"{'PASS' if ok else 'FAIL'} {path}: street median {med:.3f}, near-black {black * 100:.0f}%")
