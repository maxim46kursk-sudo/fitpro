#!/usr/bin/env python3
"""
gen_muscle_icons.py — красит анатомические картинки по группам мышц и режет на 8 кадров.

Вход:  front.png (вид спереди), back.png (вид сзади) — серые тела на чёрном фоне.
Выход: chest/shoulders/arms/abs/legs/back/glutes/cardio .png (подсветка + прозрачный фон)
        + contact_sheet.png (превью всех восьми)

Режимы:
  python gen_muscle_icons.py debug   -> рисует зоны подсветки поверх тела (front_debug.png, back_debug.png)
                                        чтобы проверить попадание по мышцам ДО финала.
  python gen_muscle_icons.py final   -> финальная покраска + нарезка + contact_sheet.png

Зависимость: Pillow  (pip install pillow)
Пути к входным файлам — константы FRONT/BACK ниже, поправь при необходимости.
"""

import sys, os
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageChops

# ---- входные файлы ----
FRONT = "front.png"
BACK  = "back.png"
OUTDIR = "out"

# ---- цвета подсветки ----
PURPLE = dict(dark=(58, 52, 138), light=(206, 202, 255), glow=(139, 136, 245))
RED    = dict(dark=(140, 28, 40), light=(255, 184, 194), glow=(255, 72, 92))

BG_THRESHOLD = 90   # пиксели ярче -> тело; темнее -> фон (прозрачность)
# У исходников фон не чёрный, а с градиентом: при пороге 38 он засчитывался
# как тело и bbox растягивался на весь кадр (front: (0,60,720,1280)).
# Плюс водяной знак «KLING AI» — чисто белый, лежит в правом нижнем углу и
# растягивал bbox при ЛЮБОМ пороге. Его вырезаем только на этапе поиска bbox.
WM_X, WM_Y = 0.82, 0.88   # доля кадра: всё правее и ниже — не тело
FEATHER = 0.055     # мягкость краёв подсветки (доля от высоты тела)

# ---- определения зон (координаты В ДОЛЯХ от bounding box тела) ----
# каждая зона = список эллипсов (cx, cy, rx, ry) в долях (0..1) внутри bbox тела.
# Доли выставлены по обмеру силуэта из этих самых front.png/back.png (ширина
# тела по строкам), а не на глаз. Ориентиры front: макс. ширина плеч fy 0.20-0.22,
# руки отделяются от торса с fy 0.28, талия fy 0.38, ноги расходятся с fy 0.58.
FRONT_REGIONS = {
    "chest":     [(0.436, 0.245, 0.084, 0.040), (0.578, 0.245, 0.084, 0.040)],
    "shoulders": [(0.228, 0.207, 0.052, 0.036), (0.772, 0.207, 0.052, 0.036)],
    "arms":      [(0.190, 0.340, 0.045, 0.042), (0.140, 0.430, 0.038, 0.036),
                  (0.812, 0.340, 0.045, 0.042), (0.868, 0.430, 0.038, 0.036)],
    "abs":       [(0.505, 0.372, 0.078, 0.068)],
    "legs":      [(0.378, 0.600, 0.075, 0.070), (0.634, 0.600, 0.075, 0.070)],
    "cardio":    [(0.525, 0.238, 0.058, 0.045)],   # область сердца (красный)
}
# Ориентиры back: талия fy 0.38, ягодичная складка появляется с fy 0.50.
BACK_REGIONS = {
    "back":      [(0.512, 0.265, 0.155, 0.118)],
    "glutes":    [(0.425, 0.500, 0.082, 0.050), (0.615, 0.500, 0.082, 0.050)],
}

FRONT_GROUPS = ["chest", "shoulders", "arms", "abs", "legs", "cardio"]
BACK_GROUPS  = ["back", "glutes"]
LABELS = {"chest":"Грудь","shoulders":"Плечи","arms":"Руки","abs":"Пресс",
          "legs":"Ноги","cardio":"Кардио","back":"Спина","glutes":"Ягодицы"}


def body_bbox(img):
    g = img.convert("L")
    W, H = g.size

    # --- маска тела ---
    # Одним порогом её не получить: у front.png фон внизу разгорается до 74, а
    # тени между мышцами внутри торса падают до 16 — диапазоны пересекаются,
    # любой порог либо дырявит тело, либо цепляет фон. Поэтому два признака:
    #   1) текстура — тело нарисовано волокнами, фон гладкий (даже градиент);
    #      даёт монолитный силуэт без дыр, но раздутый блюром;
    #   2) яркость с низким порогом — возвращает резкий край.
    tex = (g.filter(ImageFilter.FIND_EDGES)
            .filter(ImageFilter.GaussianBlur(7))
            .point(lambda v: 255 if v > 6 else 0)
            .filter(ImageFilter.MaxFilter(9))
            .filter(ImageFilter.MinFilter(9)))
    # FIND_EDGES даёт ложный отклик по рамке кадра, а вотермарк «KLING AI» —
    # настоящая текстура, но не тело. Гасим и то, и другое: логотип иначе попал
    # бы в кадрирование final (правый нижний угол входит в crop).
    td = ImageDraw.Draw(tex)
    td.rectangle([0, 0, W - 1, H - 1], outline=0, width=12)
    td.rectangle([int(W * WM_X), int(H * WM_Y), W, H], fill=0)
    mask = ImageChops.multiply(tex, g.point(lambda v: 255 if v > 14 else 0))

    # Заделываем остаточные дыры: заливаем ФОН от четырёх углов, всё до чего
    # заливка не дошла — внутренность тела, её возвращаем в маску. Заливка идёт
    # значением 255 по подрезанному до 250 исходнику: floodfill сравнивает цвет
    # заливки с затравкой и молча выходит, если разница меньше thresh.
    holes = mask.point(lambda v: min(v, 250))
    for seed in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)]:
        ImageDraw.floodfill(holes, seed, 255, thresh=10)
    mask = holes.point(lambda v: 0 if v == 255 else 255)

    # Оставляем только связную область тела: мелкий мусор по краям кадра и
    # остаток логотипа иначе растягивают bbox и лезут в кадрирование.
    bb0 = mask.getbbox()
    seed = ((bb0[0] + bb0[2]) // 2, (bb0[1] + bb0[3]) // 2)   # таз — гарантированно внутри
    comp = mask.point(lambda v: min(v, 250))
    ImageDraw.floodfill(comp, seed, 255, thresh=0)   # маска бинарная — точное совпадение
    mask = comp.point(lambda v: 255 if v == 255 else 0)

    # --- bbox ---
    # Вотермарк «KLING AI» чисто белый и в маску попадает, растягивая bbox.
    # Вырезаем его ТОЛЬКО здесь: сама mask уходит в альфу и не должна страдать.
    probe = mask.copy()
    ImageDraw.Draw(probe).rectangle([int(W * WM_X), int(H * WM_Y), W, H], fill=0)
    return probe.getbbox(), mask


def abs_ellipses(region, bb):
    x0, y0, x1, y1 = bb
    W, H = x1 - x0, y1 - y0
    out = []
    for (cx, cy, rx, ry) in region:
        out.append((x0 + cx * W, y0 + cy * H, rx * W, ry * H))
    return out


def region_mask(size, ellipses, feather_px):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    for (cx, cy, rx, ry) in ellipses:
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    return m.filter(ImageFilter.GaussianBlur(feather_px))


def make_frame(img, bodymask, bb, ellipses, colors, feather_px, crop):
    size = img.size
    lum = img.convert("L")
    tint = ImageOps.colorize(lum, black=colors["dark"], white=colors["light"]).convert("RGB")
    rmask = ImageChops.multiply(region_mask(size, ellipses, feather_px), bodymask)
    comp = Image.composite(tint, img, rmask)
    # свечение (screen с чёрным фоном = только зона светится)
    halo = Image.new("RGB", size, (0, 0, 0))
    hd = ImageDraw.Draw(halo)
    for (cx, cy, rx, ry) in ellipses:
        hd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=colors["glow"])
    halo = halo.filter(ImageFilter.GaussianBlur(feather_px * 1.7))
    comp = ImageChops.screen(comp, halo)
    out = comp.convert("RGBA")
    out.putalpha(bodymask.filter(ImageFilter.GaussianBlur(1)))
    return out.crop(crop)


def padded_crop(bb, size, pad=0.05):
    x0, y0, x1, y1 = bb
    W, H = x1 - x0, y1 - y0
    px, py = int(W * pad), int(H * pad)
    return (max(0, x0 - px), max(0, y0 - py),
            min(size[0], x1 + px), min(size[1], y1 + py))


def run_debug():
    for path, regions in [(FRONT, FRONT_REGIONS), (BACK, BACK_REGIONS)]:
        img = Image.open(path).convert("RGB")
        bb, _ = body_bbox(img)
        print(f"{path}: bbox={bb}  {bb[2]-bb[0]}x{bb[3]-bb[1]}  (кадр {img.size[0]}x{img.size[1]})")
        overlay = img.copy().convert("RGBA")
        d = ImageDraw.Draw(overlay, "RGBA")
        for g, region in regions.items():
            col = (255, 80, 90, 110) if g == "cardio" else (150, 120, 255, 110)
            for (cx, cy, rx, ry) in abs_ellipses(region, bb):
                d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=col, outline=(255, 255, 255, 220), width=2)
                d.text((cx - 14, cy - 6), LABELS[g], fill=(255, 255, 255, 255))
        name = "front_debug.png" if path == FRONT else "back_debug.png"
        overlay.convert("RGB").save(os.path.join(OUTDIR, name))
        print("wrote", name)


def run_final():
    front = Image.open(FRONT).convert("RGB")
    back = Image.open(BACK).convert("RGB")
    fbb, fmask = body_bbox(front)
    bbb, bmask = body_bbox(back)
    fcrop = padded_crop(fbb, front.size)
    bcrop = padded_crop(bbb, back.size)
    ffeather = int((fbb[3] - fbb[1]) * FEATHER)
    bfeather = int((bbb[3] - bbb[1]) * FEATHER)

    frames = {}
    for g in FRONT_GROUPS:
        colors = RED if g == "cardio" else PURPLE
        el = abs_ellipses(FRONT_REGIONS[g], fbb)
        frames[g] = make_frame(front, fmask, fbb, el, colors, ffeather, fcrop)
    for g in BACK_GROUPS:
        el = abs_ellipses(BACK_REGIONS[g], bbb)
        frames[g] = make_frame(back, bmask, bbb, el, PURPLE, bfeather, bcrop)

    for g, im in frames.items():
        im.save(os.path.join(OUTDIR, g + ".png"))
        print("wrote", g + ".png", im.size)

    # contact sheet
    order = ["chest", "back", "legs", "glutes", "shoulders", "arms", "abs", "cardio"]
    cell = 220
    cols = 4
    rows = 2
    sheet = Image.new("RGB", (cols * cell, rows * cell + 30), (18, 18, 22))
    d = ImageDraw.Draw(sheet)
    for i, g in enumerate(order):
        im = frames[g].copy()
        im.thumbnail((cell - 24, cell - 40))
        cx = (i % cols) * cell + (cell - im.width) // 2
        cy = (i // cols) * cell + 10
        sheet.paste(im, (cx, cy), im)
        d.text(((i % cols) * cell + cell // 2 - 20, (i // cols) * cell + cell - 26), LABELS[g], fill=(220, 220, 230))
    sheet.save(os.path.join(OUTDIR, "contact_sheet.png"))
    print("wrote contact_sheet.png")


if __name__ == "__main__":
    os.makedirs(OUTDIR, exist_ok=True)
    mode = sys.argv[1] if len(sys.argv) > 1 else "debug"
    if mode == "debug":
        run_debug()
    elif mode == "final":
        run_final()
    else:
        print("usage: python gen_muscle_icons.py [debug|final]")
