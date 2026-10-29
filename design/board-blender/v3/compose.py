# v3: turn the one-scene renders into the web assets.
#   board-frame.png   the frame pass, finished exactly as v2 did (outer outline, inner panel shadow, clean corners); 9-slice
#   board-hanger.png  the bottom 600 px of the hanger pass: clamp, sleeve, rope, turnbuckle, rope
#   board-cable.png   the 600 px of rope directly above it in the same render, so it continues the hanger seamlessly
#                     and repeats (the rope's lay is 150 px and the light doesn't change along it)
#   board-glass.png   unchanged from v2 (the screen's reflection layer)
#   preview.png       the assembly pass on cream and on black
import shutil
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

D = "/Users/jeremiahsleman/dev/cc-app/design/board-blender/v3/"
V2 = "/Users/jeremiahsleman/dev/cc-app/design/board-blender/v2/"

def down(name, size):
    im = Image.open(D + f"raw/{name}.png").convert("RGBA")
    return im.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")

def rrmask(w, h, r, ss=4):
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), r * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)

# ---------------- frame (same finishing as v2/compose_preview.py)
W, H = 1200, 520
fr = down("frame", (W, H))
arr = np.array(fr).astype(np.float32)
outer = np.array(rrmask(W, H, 72)).astype(np.float32) / 255
arr[:, :, 3] *= outer
a8 = Image.fromarray(arr[:, :, 3].astype(np.uint8))
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

# ---------------- hanger + cable tile, cut from one render
hang = down("hanger", (96, 1200))
hang.crop((0, 600, 96, 1200)).save(D + "board-hanger.png")
tile = hang.crop((0, 0, 96, 600)); tile.save(D + "board-cable.png")
t = np.array(tile).astype(np.float32)
print("tile wrap error (mean |row0 - row600|, 0-255):", round(float(np.abs(t[:8] - np.array(hang).astype(np.float32)[600:608]).mean()), 2))

shutil.copy(V2 + "board-glass.png", D + "board-glass.png")

# ---------------- checks and preview
strip = Image.new("RGBA", (96 * 3 + 40, 1800), "#F7EEDF")
for i, bgc in enumerate(("#F7EEDF", "#0E0D0C", "#7a7a7a")):
    col = Image.new("RGBA", (96, 1800), bgc)
    col.alpha_composite(tile, (0, 0)); col.alpha_composite(tile, (0, 600)); col.alpha_composite(Image.open(D + "board-hanger.png"), (0, 1200))
    strip.alpha_composite(col, (8 + i * 108, 0))
strip.convert("RGB").save(D + "raw/test-hanger-strip.png")
asm = Image.open(D + "raw/assembly.png").convert("RGBA")
both = Image.new("RGB", (asm.width * 2, asm.height))
for i, bgc in enumerate(("#F7EEDF", "#0E0D0C")):
    c = Image.new("RGBA", asm.size, bgc); c.alpha_composite(asm); both.paste(c.convert("RGB"), (i * asm.width, 0))
both.save(D + "preview.png")
print("done")
