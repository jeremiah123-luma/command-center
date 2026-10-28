# Downsample raw Cycles renders, add inner panel shadow + glass layer, build previews.
import numpy as np
from PIL import Image, ImageFilter, ImageDraw, ImageFont
D = "/Users/jeremiahsleman/dev/cc-app/design/board-blender/"

def down(name, size):
    im = Image.open(D + f"raw/{name}.png").convert("RGBA")
    return im.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")

# ---- frame: add soft inner shadow on the panel side (transparent centre stays transparent elsewhere)
fr = down("frame", (1200, 520))
a = np.array(fr)[:, :, 3].astype(np.float32) / 255
solid = Image.fromarray((a * 255).astype(np.uint8))
# opening mask = region not covered by frame, inside the rounded interior
hole = np.array(solid.filter(ImageFilter.MinFilter(1))) < 8
sh_src = Image.fromarray(((~hole) * 255).astype(np.uint8))
sh = sh_src.transform(sh_src.size, Image.AFFINE, (1, 0, -5, 0, 1, -8)).filter(ImageFilter.GaussianBlur(14))
amb = sh_src.filter(ImageFilter.GaussianBlur(26))
sha = np.clip(np.array(sh).astype(np.float32) / 255 * 0.62 + np.array(amb).astype(np.float32) / 255 * 0.25, 0, 0.8) * hole
out = np.array(fr).astype(np.float32)
alpha = out[:, :, 3] / 255
# composite shadow (black) beneath frame
na = alpha + sha * (1 - alpha)
rgb = out[:, :, :3] * alpha[..., None]  # premult (black shadow adds nothing)
rgb = np.where(na[..., None] > 0, rgb / np.maximum(na[..., None], 1e-6), 0)
res = np.dstack([np.clip(rgb, 0, 255), na * 255]).astype(np.uint8)
frame = Image.fromarray(res, "RGBA"); frame.save(D + "board-frame.png")

rod = down("rod", (28, 600)); rod.save(D + "board-rod.png")
clamp = down("clamp", (90, 70)); clamp.save(D + "board-clamp.png")
bar = down("bar", (800, 40)); bar.save(D + "board-bar.png") if False else None
bar.save(D + "board-ceiling-bar.png")

# ---- glass: diagonal soft highlight, very subtle
W, H = 1200, 520
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
t = (xx * 0.62 + yy * 1.0)            # diagonal coordinate
def band(c, w): return np.exp(-((t - c) / w) ** 2)
g = 0.075 * band(520, 150) + 0.045 * band(880, 40) + 0.025 * band(780, 18)
g += 0.05 * np.clip(1 - yy / 120, 0, 1) ** 2          # top-edge sheen
sheen = np.clip(g, 0, 0.14)
alpha = (sheen * 255).astype(np.uint8)
glass = np.dstack([np.full((H, W), 255, np.uint8), np.full((H, W), 252, np.uint8), np.full((H, W), 246, np.uint8), alpha])
Image.fromarray(glass, "RGBA").save(D + "board-glass.png")
glass = Image.open(D + "board-glass.png")

# ---- tiling tests
rt = Image.new("RGBA", (28 * 3 + 20, 600 * 2), "#F7EEDF")
for i in range(3):
    for j in range(2): rt.alpha_composite(rod, (i * 38 + 5, j * 600))
rt.convert("RGB").save(D + "raw/test-rod-tile.png")
mid = bar.crop((100, 0, 700, 40)); bt = Image.new("RGBA", (1800, 40), "#F7EEDF")
for i in range(3): bt.alpha_composite(mid, (i * 600, 0))
bt.convert("RGB").save(D + "raw/test-bar-tile.png")
# frame stretch test: 9-slice at 1700x700
def nine(img, s, tw, th):
    w, h = img.size; o = Image.new("RGBA", (tw, th))
    xs = [0, s, w - s, w]; xt = [0, s, tw - s, tw]; ys = [0, s, h - s, h]; yt = [0, s, th - s, th]
    for i in range(3):
        for j in range(3):
            if i == 1 and j == 1: continue
            p = img.crop((xs[i], ys[j], xs[i + 1], ys[j + 1])).resize((xt[i + 1] - xt[i], yt[j + 1] - yt[j]), Image.BICUBIC)
            o.alpha_composite(p, (xt[i], yt[j]))
    return o
bg = Image.new("RGBA", (1700, 700), "#0E0D0C"); bg.alpha_composite(nine(frame, 88, 1700, 700)); bg.convert("RGB").save(D + "raw/test-frame-stretch.png")

# ---- preview assembly (2x px)
def board(bgc):
    CW, CH = 1500, 1130
    c = Image.new("RGBA", (CW, CH), bgc)
    bx, by = (CW - 1200) // 2, 330
    parts = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    # panel
    panel = Image.new("RGBA", (1200, 520), "#0a0a09")
    d = ImageDraw.Draw(panel)
    try: f = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 30)
    except Exception: f = ImageFont.load_default()
    rows = ["TIME   FLIGHT   DESTINATION      GATE   STATUS", "07:45  CC 101   MORNING BRIEF    A1     ON TIME", "09:10  CC 214   DEEP WORK        B4     BOARDING", "13:30  CC 330   LUNCH            C2     DELAYED", "16:00  CC 418   REVIEW           A3     ON TIME"]
    for i, r in enumerate(rows): d.text((120, 90 + i * 66), r, fill="#F2A62C" if i else "#8a6a2c", font=f)
    m = Image.new("L", (1200, 520), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, 1199, 519), 72, fill=255); panel.putalpha(m)
    parts.alpha_composite(panel, (bx, by))
    parts.alpha_composite(frame, (bx, by))
    parts.alpha_composite(glass, (bx, by))
    rx = (bx + 130, bx + 1200 - 130 - 28)
    bar_y = 40; bx2 = (CW - 800) // 2
    for x in rx:
        cx = x + 14 - 45
        top = bar_y + 36; bot = by - 40
        for y in range(top, bot, 600):
            seg = rod.crop((0, 0, 28, min(600, bot - y)))
            parts.alpha_composite(seg, (x, y))
        parts.alpha_composite(clamp, (cx, by - 40))
    parts.alpha_composite(bar, (bx2, bar_y))
    al = parts.split()[3]
    sh = Image.new("RGBA", (CW, CH), (0, 0, 0, 0)); sh.putalpha(al.filter(ImageFilter.GaussianBlur(18)).point(lambda v: int(v * 0.5)))
    c.alpha_composite(sh, (10, 24)); c.alpha_composite(parts)
    return c
cream, black = board("#F7EEDF"), board("#0E0D0C")
cream.convert("RGB").save(D + "preview-cream.png"); black.convert("RGB").save(D + "preview-black.png")
both = Image.new("RGB", (3000, 1130)); both.paste(cream.convert("RGB"), (0, 0)); both.paste(black.convert("RGB"), (1500, 0))
both.save(D + "preview.png")
