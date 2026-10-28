# v2: downsample the raw Cycles renders, finish the frame (inner panel shadow, clean
# transparent corners), turn the Cycles glass reflection into a low-alpha layer,
# and build tile tests and previews.
import numpy as np
from PIL import Image, ImageFilter, ImageDraw, ImageFont, ImageChops
D = "/Users/jeremiahsleman/dev/cc-app/design/board-blender/v2/"

def down(name, size):
    im = Image.open(D + f"raw/{name}.png").convert("RGBA")
    return im.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")

def rrmask(w, h, r, ss=4):
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), r * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)

# ---------------- frame
W, H = 1200, 520
fr = down("frame", (W, H))
arr = np.array(fr).astype(np.float32)
outer = np.array(rrmask(W, H, 72)).astype(np.float32) / 255
arr[:, :, 3] *= outer                      # nothing outside the r=72 outline
a8 = Image.fromarray(arr[:, :, 3].astype(np.uint8))
# opening = transparent region connected to the centre (never the outside corners)
probe = a8.point(lambda v: 255 if v < 8 else 0)
ImageDraw.floodfill(probe, (W // 2, H // 2), 128, thresh=0)
hole = np.array(probe) == 128
src = Image.fromarray(((~hole) * 255).astype(np.uint8))
sh = src.transform(src.size, Image.AFFINE, (1, 0, -5, 0, 1, -8)).filter(ImageFilter.GaussianBlur(14))
amb = src.filter(ImageFilter.GaussianBlur(26))
sha = np.clip(np.array(sh).astype(np.float32) / 255 * 0.62 + np.array(amb).astype(np.float32) / 255 * 0.25, 0, 0.8) * hole
al = arr[:, :, 3] / 255
na = al + sha * (1 - al)
rgb = arr[:, :, :3] * al[..., None]
rgb = np.where(na[..., None] > 1e-6, rgb / np.maximum(na[..., None], 1e-6), 0)
res = np.dstack([np.clip(rgb, 0, 255), na * 255]).astype(np.uint8)
res[:, :, 3] = (res[:, :, 3] * outer).astype(np.uint8)
res[outer < 0.02] = 0
yy, xx = np.mgrid[0:H, 0:W]
for cxx, cyy, sx, sy in ((72, 72, -1, -1), (W - 73, 72, 1, -1), (72, H - 73, -1, 1), (W - 73, H - 73, 1, 1)):
    m = (sx * (xx - cxx) > 0) & (sy * (yy - cyy) > 0) & ((xx - cxx) ** 2 + (yy - cyy) ** 2 > 72.6 ** 2)
    res[m] = 0
frame = Image.fromarray(res, "RGBA"); frame.save(D + "board-frame.png")

rod = down("rod", (28, 600)); rod.save(D + "board-rod.png")
cable = down("cable", (28, 600)); cable.save(D + "board-rod-cable.png")
clamp = down("clamp", (90, 70)); clamp.save(D + "board-clamp.png")
bar = down("bar", (800, 40)); bar.save(D + "board-ceiling-bar.png")
tb = down("turnbuckle", (44, 170)); tb.save(D + "board-turnbuckle.png")

# ---------------- glass (Cycles reflection -> additive light as low alpha)
g = Image.open(D + "raw/glass.png").convert("RGBA")
ga = np.array(g).astype(np.float32) / 255
prem = ga[:, :, :3] * ga[:, :, 3:4]
L = prem.max(axis=2)
L = np.array(Image.fromarray(L).resize((W, H), Image.LANCZOS))
A = np.clip(L / max(L.max(), 1e-6), 0, 1) ** 1.1 * 0.16
glass = np.dstack([np.full((H, W), 255), np.full((H, W), 252), np.full((H, W), 246), A * 255]).astype(np.uint8)
Image.fromarray(glass, "RGBA").save(D + "board-glass.png")
glass = Image.open(D + "board-glass.png")

# ---------------- tests
def tile_v(img, name):
    t = Image.new("RGBA", (img.width * 3 + 40, img.height * 2), "#F7EEDF")
    for i in range(3):
        for j in range(2): t.alpha_composite(img, (i * (img.width + 12) + 8, j * img.height))
    t.convert("RGB").save(D + f"raw/{name}.png")
tile_v(rod, "test-rod-tile"); tile_v(cable, "test-cable-tile")
mid = bar.crop((100, 0, 700, 40)); bt = Image.new("RGBA", (1800, 40), "#F7EEDF")
for i in range(3): bt.alpha_composite(mid, (i * 600, 0))
bt.convert("RGB").save(D + "raw/test-bar-tile.png")
def nine(img, s, tw, th):
    w, h = img.size; o = Image.new("RGBA", (tw, th))
    xs = [0, s, w - s, w]; xt = [0, s, tw - s, tw]; ys = [0, s, h - s, h]; yt = [0, s, th - s, th]
    for i in range(3):
        for j in range(3):
            if i == 1 and j == 1: continue
            p = img.crop((xs[i], ys[j], xs[i + 1], ys[j + 1])).resize((xt[i + 1] - xt[i], yt[j + 1] - yt[j]), Image.BICUBIC)
            o.alpha_composite(p, (xt[i], yt[j]))
    return o
bg = Image.new("RGBA", (1700, 700), "#F7EEDF"); bg.alpha_composite(nine(frame, 88, 1700, 700)); bg.convert("RGB").save(D + "raw/test-frame-stretch.png")

# ---------------- previews
def dropshadow(img, dx, dy, blur, op):
    s = Image.new("RGBA", img.size, (0, 0, 0, 0)); s.putalpha(img.split()[3].filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * op)))
    o = Image.new("RGBA", img.size, (0, 0, 0, 0)); o.alpha_composite(s, (dx, dy)); return o

def board(bgc, use_cable):
    CW, CH = 1500, 1130
    c = Image.new("RGBA", (CW, CH), bgc)
    bx, by = (CW - 1200) // 2, 330
    parts = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    panel = Image.new("RGBA", (1200, 520), "#0a0a09")
    d = ImageDraw.Draw(panel)
    try: f = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 30)
    except Exception: f = ImageFont.load_default()
    rows = ["TIME   FLIGHT   DESTINATION      GATE   STATUS", "07:45  CC 101   MORNING BRIEF    A1     ON TIME", "09:10  CC 214   DEEP WORK        B4     BOARDING", "13:30  CC 330   LUNCH            C2     DELAYED", "16:00  CC 418   REVIEW           A3     ON TIME"]
    for i, r in enumerate(rows): d.text((120, 90 + i * 66), r, fill="#F2A62C" if i else "#8a6a2c", font=f)
    panel.putalpha(rrmask(1200, 520, 72))
    parts.alpha_composite(panel, (bx, by)); parts.alpha_composite(frame, (bx, by)); gp = glass.copy(); gp.putalpha(ImageChops.multiply(glass.split()[3], Image.fromarray((hole * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1)))); parts.alpha_composite(gp, (bx, by))
    wire = cable if use_cable else rod
    bar_y = 40; bx2 = (CW - 800) // 2
    for x in (bx + 130, bx + 1200 - 130 - 28):
        top = bar_y + 36; bot = by - 40
        for y in range(top, bot, 600):
            parts.alpha_composite(wire.crop((0, 0, 28, min(600, bot - y))), (x, y))
        if use_cable:
            ty = top + (bot - top) // 2 - 85
            parts.alpha_composite(tb, (x + 14 - 22, ty))
        cx = x + 14 - 45
        csh = dropshadow(clamp, 3, 5, 3, 0.55)
        layer = Image.new("RGBA", (CW, CH), (0, 0, 0, 0)); layer.alpha_composite(csh, (cx, by - 40)); 
        # clamp shadow only lands on the frame (clip to frame alpha)
        fa = Image.new("L", (CW, CH), 0); fa.paste(frame.split()[3], (bx, by))
        la = ImageChops.multiply(layer.split()[3], fa); layer.putalpha(la)
        parts.alpha_composite(layer)
        parts.alpha_composite(clamp, (cx, by - 40))
    parts.alpha_composite(bar, (bx2, bar_y))
    c.alpha_composite(dropshadow(parts, 10, 24, 18, 0.5)); c.alpha_composite(parts)
    return c
for tag, uc in (("", False), ("-cable", True)):
    cream, black = board("#F7EEDF", uc), board("#0E0D0C", uc)
    cream.convert("RGB").save(D + f"preview{tag}-cream.png"); black.convert("RGB").save(D + f"preview{tag}-black.png")
    both = Image.new("RGB", (3000, 1130)); both.paste(cream.convert("RGB"), (0, 0)); both.paste(black.convert("RGB"), (1500, 0))
    both.save(D + f"preview{tag}.png")
