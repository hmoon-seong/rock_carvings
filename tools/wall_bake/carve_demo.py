"""Feasibility check: carve an image into the baked wall, the way the web app will.

Takes the painted figures of one drawing page as the "user drawing", turns them into a pecked
carve height layer at 1 mm/px, and lights base + detail + carve with the lighting contract
(shading.shade, n_carve). Uses the baked intermediates in data/bake/.

  python3 carve_demo.py            -> data/bake/carve_demo.png
"""
from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, map_coordinates, zoom

import shading as sh
from ply import REPO, load_config
from register_drawings import page_layers


def bilinear(arr, ys, xs, mode="nearest"):
    return np.stack([map_coordinates(arr[..., c], [ys, xs], order=1, mode=mode) for c in range(arr.shape[-1])], -1)


def carve_layer(mask, mm_per_px, cc, rng):
    """Pecked carving: soft-edged depression plus dense overlapping peck craters. Height in mm (<= 0)."""
    m = mask.astype(np.float64)
    h = -cc["depth_mm"] * gaussian_filter(m, cc["edge_mm"] / mm_per_px)
    H, W = m.shape
    ys, xs = np.nonzero(m)
    n = int(len(ys) * mm_per_px ** 2 * cc["pecks_per_mm2"])
    pick = rng.integers(0, len(ys), n)
    yy, xx = np.mgrid[0:H, 0:W]
    pecks = np.zeros_like(h)
    for y, x, r, d in zip(ys[pick], xs[pick], rng.uniform(*cc["peck_radius_mm"], n) / mm_per_px,
                          rng.uniform(*cc["peck_depth_mm"], n)):
        y0, y1, x0, x1 = int(max(y - r - 1, 0)), int(min(y + r + 2, H)), int(max(x - r - 1, 0)), int(min(x + r + 2, W))
        q = ((yy[y0:y1, x0:x1] - y) ** 2 + (xx[y0:y1, x0:x1] - x) ** 2) / r ** 2
        pecks[y0:y1, x0:x1] = np.minimum(pecks[y0:y1, x0:x1], np.where(q < 1, -d * (1 - q), 0.0))
    return h + pecks


def normals_from_height(h, mm_per_px):
    dx = np.gradient(h, mm_per_px, axis=1)
    drow = np.gradient(h, mm_per_px, axis=0)
    n = np.stack([-dx, drow, np.ones_like(h)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def main():
    cfg = load_config()
    cc = cfg["carve_demo"]
    out = REPO / cfg["paths"]["bake_dir"]
    grid = json.loads((out / "grid.json").read_text())
    gpx = grid["mm_per_px"]
    rng = np.random.default_rng(cfg["seed"] + 21)

    base_n = np.load(out / "normal.npy").astype(np.float64)
    albedo = np.load(out / "albedo_lin.npy").astype(np.float64)
    ao = np.load(out / "ao.npy").astype(np.float64)
    look = json.loads((out / "look.json").read_text())
    det = sh.decode_normal(np.asarray(Image.open(out / "detail_normal.webp").convert("RGB")))
    tile_mm = look["detail"]["tile_mm"]

    # render window: one grid cell, centered on the chosen wall point, at render mm/px
    rpx = cc["render_mm_per_px"]
    size = int(cc["cell_mm"] / rpx)
    cx, cy = cc["center_grid_px"]
    y_mm = cy * gpx + (np.arange(size) - size / 2) * rpx
    x_mm = cx * gpx + (np.arange(size) - size / 2) * rpx
    YY, XX = np.meshgrid(y_mm, x_mm, indexing="ij")
    nb = bilinear(base_n, YY / gpx, XX / gpx)
    nb /= np.linalg.norm(nb, axis=-1, keepdims=True)
    alb = bilinear(albedo, YY / gpx, XX / gpx)
    a = map_coordinates(ao, [YY / gpx, XX / gpx], order=1)
    dN = det.shape[0]
    nd = bilinear(det, (YY / tile_mm * dN) % dN, (XX / tile_mm * dN) % dN, mode="grid-wrap")

    # the "user drawing": figures from one drawing page, scaled so the page spans one cell
    _, _, brown, purple = page_layers(REPO / cfg["paths"]["drawings"] / f"drawings_Page_{cc['page']:02d}.jpg",
                                      cfg["register"])
    fig = (brown | purple).astype(np.float64)
    fig = zoom(fig, (size / fig.shape[0], size / fig.shape[1]), order=1) > 0.5
    fig = fig[:size, :size]
    fig = np.pad(fig, ((0, size - fig.shape[0]), (0, size - fig.shape[1])))
    photo = Image.open(REPO / cfg["paths"]["photos"] / f"original_Page_{cc['page']:02d}.jpg").convert("RGB")
    d = sh.DEFAULT_LIGHTING
    tw = 360
    variants = cc["variants"]
    sheet = Image.new("RGB", (10 + 4 * (tw + 10), 10 + len(variants) * (tw + 28)), (250, 249, 246))
    dr = ImageDraw.Draw(sheet)
    for vi, v in enumerate(variants):
        vc = {**cc, **v}
        hc = carve_layer(fig, rpx, vc, np.random.default_rng(cfg["seed"] + 21))
        ncarve = normals_from_height(hc, rpx)
        carved = gaussian_filter(fig.astype(np.float64), vc["edge_mm"] / rpx)
        lab = sh.linear_to_lab(alb)
        lab[..., 0] += vc["carve_dL"] * carved
        alb_c = sh.lab_to_linear(lab)
        nbv = nb.copy()
        nbv[..., :2] *= vc["base_normal_scale"]
        nbv /= np.linalg.norm(nbv, axis=-1, keepdims=True)
        y = 10 + vi * (tw + 28)
        label = ", ".join(f"{k}={v[k]}" for k in v)
        dr.text((10, y), f"variant {chr(65 + vi)}: {label}", fill=(20, 20, 20))
        for ci, (title, az, el) in enumerate((("photo light", d["photo_azimuth_deg"], d["photo_elevation_deg"]),
                                              ("raking 15° left", 270.0, 15.0), ("raking 15° top", 0.0, 15.0))):
            img = sh.shade(nbv, alb_c, a, sh.light_dir(az, el), n_detail=nd,
                           detail_strength=vc["detail_strength"], n_carve=ncarve)
            im = Image.fromarray(sh.to_u8(sh.linear_to_srgb(img)))
            if vi == len(variants) - 1 and ci == 1:
                im.save(out / "carve_demo_raking_full.png")
            # show the lower half (where the figures are), like the photo framing
            sheet.paste(im.crop((0, size // 3, size, size // 3 + size * 2 // 3)).resize((tw, tw * 2 // 3)),
                        (10 + ci * (tw + 10), y + 16))
            dr.text((10 + ci * (tw + 10) + 4, y + 18), title, fill=(255, 255, 255))
        ph = photo.resize((tw, int(tw * photo.height / photo.width)))
        sheet.paste(ph.crop((0, ph.height // 3, tw, ph.height // 3 + tw * 2 // 3)), (10 + 3 * (tw + 10), y + 16))
    print(f"carve normal tilt p95 (last variant) {np.percentile(np.degrees(np.arccos(ncarve[fig][:, 2])), 95):.1f}°")
    sheet.save(out / "carve_demo.png")
    print(f"window {cc['cell_mm']} mm at {rpx} mm/px ({size}px) around grid {cx},{cy}; "
          f"carved {fig.mean():.1%} of window, {len(variants)} variants")


if __name__ == "__main__":
    main()
