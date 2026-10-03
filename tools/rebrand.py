# Redraws the two branded images:
#  - images/logo.png: "BAMBIPRO" in the original logo's beveled block style (colours sampled
#    from the real TagPro logo)
#  - images/KoalaBeast.png: the koala is replaced by a cartoon deer (text kept)
# Originals are kept as images/logo-original.png and images/KoalaBeast-original.png.
import os, shutil
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, 'public', 'images')
for name in ('logo.png', 'KoalaBeast.png'):
    orig = os.path.join(IMG, name.replace('.png', '-original.png'))
    if not os.path.exists(orig): shutil.copy(os.path.join(IMG, name), orig)

# ---------------------------------------------------------------- logo
FILL, HI_TOP, HI_LEFT, SH_RIGHT, SH_BOTTOM, OUTLINE = (120,) * 3, (171,) * 3, (146,) * 3, (83,) * 3, (52,) * 3, (35,) * 3
GLYPHS = {  # 3-column x 5-row block font matching the original's chunky letters (M uses 5 columns)
    'B': ['XXX.', 'X..X', 'XXX.', 'X..X', 'XXX.'],
    'A': ['XXX', 'X.X', 'XXX', 'X.X', 'X.X'],
    'M': ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X'],
    'I': ['XXX', '.X.', '.X.', '.X.', 'XXX'],
    'P': ['XXX', 'X.X', 'XXX', 'X..', 'X..'],
    'R': ['XXX', 'X.X', 'XX.', 'X.X', 'X.X'],
    'O': ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
}
COL, ROWS_H, GAP, BEVEL, H = 24, 97, 11, 6, 108
def glyph_mask(g):
    cols = len(g[0]); colw = {3: COL, 4: 19, 5: 19}[cols]
    w = cols * colw
    m = Image.new('L', (w, H), 0); d = ImageDraw.Draw(m)
    for r, row in enumerate(g):
        y0, y1 = round(r * ROWS_H / 5), round((r + 1) * ROWS_H / 5)
        for c, ch in enumerate(row):
            if ch == 'X': d.rectangle([c * colw, y0, (c + 1) * colw - 1, y1 - 1], fill=255)
    # B's right-hand bowls: round the notches into the original's squared look by filling the gaps
    return m
def shade(mask):
    w, h = mask.size; px = mask.load()
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0)); o = out.load()
    inside = lambda x, y: 0 <= x < w and 0 <= y < h and px[x, y] > 0
    for y in range(h):
        for x in range(w):
            if not inside(x, y): continue
            col = FILL
            for d in range(1, BEVEL + 1):
                if not inside(x, y + d): col = SH_BOTTOM if d > 2 else OUTLINE; break
                if not inside(x + d, y): col = SH_RIGHT; break
                if not inside(x, y - d): col = HI_TOP; break
                if not inside(x - d, y): col = HI_LEFT; break
            o[x, y] = col + (255,)
    return out
letters = [shade(glyph_mask(GLYPHS[ch])) for ch in 'BAMBIPRO']
W = sum(l.width for l in letters) + GAP * (len(letters) - 1)
logo = Image.new('RGBA', (W, H), (0, 0, 0, 0)); x = 0
for l in letters: logo.alpha_composite(l, (x, 0)); x += l.width + GAP
logo.save(os.path.join(IMG, 'logo.png'))

# ---------------------------------------------------------------- deer badge
orig = Image.open(os.path.join(IMG, 'KoalaBeast-original.png')).convert('RGBA')
S = 4                                  # draw at 4x, then scale down for smooth edges
art = Image.new('RGBA', (92 * S, 75 * S), (0, 0, 0, 0)); d = ImageDraw.Draw(art)
LINE, LW = (59, 46, 42, 255), 7
FUR, FUR_D, CREAM, PINK, HOOF = (183, 125, 74, 255), (150, 98, 56, 255), (246, 233, 210, 255), (233, 160, 160, 255), (70, 52, 44, 255)
def ell(box, fill): d.ellipse(box, fill=fill, outline=LINE, width=LW)
d.ellipse([60, 272, 260, 296], fill=(0, 0, 0, 40))                         # ground shadow
# antlers
for side in (-1, 1):
    bx = 160 + side * 40
    d.line([(bx, 70), (bx + side * 18, 22), (bx + side * 8, 0)], fill=FUR_D, width=13, joint='curve')
    d.line([(bx + side * 14, 34), (bx + side * 42, 20)], fill=FUR_D, width=11)
    d.line([(bx + side * 8, 52), (bx + side * 34, 50)], fill=FUR_D, width=10)
# legs + hooves
for lx in (112, 178):
    d.rounded_rectangle([lx, 236, lx + 34, 284], radius=10, fill=FUR, outline=LINE, width=LW)
    d.rounded_rectangle([lx, 266, lx + 34, 286], radius=8, fill=HOOF, outline=LINE, width=LW)
# body + belly + spots
ell([86, 150, 238, 266], FUR)
ell([122, 182, 202, 258], CREAM)
for sx, sy in ((104, 178), (96, 206), (220, 176), (226, 204)): d.ellipse([sx, sy, sx + 11, sy + 11], fill=CREAM)
# ears
for side in (-1, 1):
    cx = 160 + side * 78
    d.polygon([(160 + side * 40, 82), (cx + side * 12, 58), (cx + side * 18, 92), (160 + side * 46, 112)], fill=FUR, outline=LINE)
    d.polygon([(160 + side * 46, 86), (cx + side * 6, 70), (cx + side * 8, 90), (160 + side * 48, 104)], fill=PINK)
# head
ell([94, 50, 226, 172], FUR)
ell([126, 112, 194, 168], CREAM)                                          # muzzle
ell([146, 116, 174, 138], (40, 32, 30, 255))                              # nose
for ex in (124, 176):
    d.ellipse([ex, 88, ex + 20, 112], fill=(30, 24, 22, 255))
    d.ellipse([ex + 5, 92, ex + 11, 99], fill=(255, 255, 255, 255))
d.arc([146, 140, 174, 158], 20, 160, fill=LINE, width=5)                   # smile
# arm + axe (like the koala's)
d.line([(262, 196), (300, 92)], fill=(120, 74, 44, 255), width=12)        # handle
d.polygon([(286, 96), (338, 70), (352, 120), (300, 132)], fill=(205, 205, 210, 255), outline=LINE)
d.polygon([(338, 70), (352, 120), (344, 118), (332, 74)], fill=(214, 40, 40, 255))
ell([222, 176, 270, 214], FUR)                                            # hand gripping the handle
deer = art.resize((88, 72), Image.LANCZOS)
badge = orig.copy()
ImageDraw.Draw(badge).rectangle([0, 0, 87, 74], fill=(0, 0, 0, 0))       # clear the koala (text starts at x=88)
badge.alpha_composite(deer, (0, 2))
badge.save(os.path.join(IMG, 'KoalaBeast.png'))
print('logo', logo.size, '| badge', badge.size)
