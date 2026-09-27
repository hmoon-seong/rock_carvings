"""Step 1: extract the "look" from ref/2d/original into data/bake/.

Outputs:
  look.json            color stats, palette, color-scale and grain spectra, detail tile params
  detail_normal.webp   512x512 seamlessly tiling normal map (OpenGL +Y up)
  detail_height.npy    the tile's height field in mm (float32)
  photo_masks.jpg      contact sheet, excluded pixels tinted cyan
  look_report.png      palette, spectra, tiled detail render next to photo crops
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import binary_dilation, gaussian_filter

import shading as sh
from ply import REPO, load_config

CYAN = np.array([0, 255, 255], np.float64)


# ---------------------------------------------------------------- helpers

def mblur(x, m, sigma):
    """Normalized (masked) gaussian blur."""
    m = m.astype(np.float64)
    return gaussian_filter(x * m, sigma) / np.maximum(gaussian_filter(m, sigma), 1e-6)


def photo_mask(lab, pc):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    hue = np.degrees(np.arctan2(b, a))
    chroma = np.hypot(a, b)
    soil = (hue > pc["soil_hue_deg"][0]) & (hue < pc["soil_hue_deg"][1]) & (chroma > pc["soil_chroma"])
    bad = (L < pc["shadow_L"]) | (L > pc["highlight_L"]) | ((a < pc["green_a_max"]) & (b > 0)) | soil
    if pc["mask_grow_px"]:
        bad = binary_dilation(bad, iterations=pc["mask_grow_px"])
    return ~bad


def fft_power(x, m):
    """Windowed 2D power spectrum of x (masked pixels zeroed after de-meaning)."""
    h, w = x.shape
    win = np.outer(np.hanning(h), np.hanning(w)) * m
    xm = np.where(m, x - x[m].mean(), 0.0)
    F = np.fft.fft2(xm * win)
    P = np.abs(F) ** 2 / max((win ** 2).sum(), 1e-9)
    fy, fx = np.meshgrid(np.fft.fftfreq(h), np.fft.fftfreq(w), indexing="ij")
    return P, fx, fy


def binned(P, fx, fy, edges, stat="mean"):
    fr = np.hypot(fx, fy).ravel()
    idx = np.digitize(fr, edges) - 1
    ok = (idx >= 0) & (idx < len(edges) - 1)
    s = np.bincount(idx[ok], P.ravel()[ok], len(edges) - 1)
    if stat == "sum":
        return s
    c = np.bincount(idx[ok], minlength=len(edges) - 1)
    return s / np.maximum(c, 1)


def kmeans(X, k, iters, rng):
    # k-means++ init
    C = [X[rng.integers(len(X))]]
    for _ in range(1, k):
        d = np.min(((X[:, None] - np.array(C)[None]) ** 2).sum(-1), axis=1)
        C.append(X[rng.choice(len(X), p=d / d.sum())])
    C = np.array(C)
    for _ in range(iters):
        lab = np.argmin(((X[:, None] - C[None]) ** 2).sum(-1), axis=1)
        C = np.array([X[lab == j].mean(0) if np.any(lab == j) else C[j] for j in range(k)])
    lab = np.argmin(((X[:, None] - C[None]) ** 2).sum(-1), axis=1)
    return C, lab


def make_palette(X, pc, seed):
    C, lbl = kmeans(X, pc["palette_k"], pc["kmeans_iters"], np.random.default_rng(seed))
    palette = []
    for j in np.argsort(C[:, 0]):
        sel = X[lbl == j]
        srgb = sh.linear_to_srgb(sh.lab_to_linear(C[j]))
        palette.append({"lab": C[j].round(2).tolist(), "lab_std": sel.std(0).round(2).tolist(),
                        "weight": round(float(len(sel) / len(X)), 4),
                        "hex": "#" + "".join(f"{v:02x}" for v in sh.to_u8(srgb))})
    return palette


def loglog_plot(series, title, xlabel, size=(760, 380)):
    W, H = size
    img = Image.new("RGB", size, (250, 249, 246))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = 60, 30, W - 20, H - 45
    xs = np.concatenate([s[0][s[1] > 0] for s in series])
    ys = np.concatenate([s[1][s[1] > 0] for s in series])
    lx0, lx1 = np.floor(np.log10(xs.min())), np.ceil(np.log10(xs.max()))
    ly0, ly1 = np.floor(np.log10(ys.min())), np.ceil(np.log10(ys.max()))
    X = lambda v: x0 + (np.log10(v) - lx0) / (lx1 - lx0) * (x1 - x0)
    Y = lambda v: y1 - (np.log10(v) - ly0) / (ly1 - ly0) * (y1 - y0)
    d.rectangle([x0, y0, x1, y1], outline=(120, 120, 120))
    for e in range(int(lx0), int(lx1) + 1):
        d.line([X(10.0 ** e), y0, X(10.0 ** e), y1], fill=(225, 225, 225))
        d.text((X(10.0 ** e) - 12, y1 + 5), f"1e{e}", fill=(60, 60, 60))
    for e in range(int(ly0), int(ly1) + 1):
        d.line([x0, Y(10.0 ** e), x1, Y(10.0 ** e)], fill=(225, 225, 225))
        d.text((8, Y(10.0 ** e) - 6), f"1e{e}", fill=(60, 60, 60))
    for i, (x, y, color, label) in enumerate(series):
        ok = y > 0
        pts = list(zip(X(x[ok]), Y(y[ok])))
        if len(pts) > 1:
            d.line(pts, fill=color, width=2)
        d.text((x1 - 230, y0 + 8 + 14 * i), "— " + label, fill=color)
    d.text((x0, 8), title, fill=(20, 20, 20))
    d.text(((x0 + x1) // 2 - 40, H - 20), xlabel, fill=(60, 60, 60))
    return img


# ---------------------------------------------------------------- detail tile

def synth_detail(freq_mm, psd_L, beta, dc, seed):
    """Periodic height field whose shading spectrum follows the photo grain spectrum."""
    N, dx = dc["size_px"], dc["mm_per_px"]
    rng = np.random.default_rng(seed)
    fy, fx = np.meshgrid(np.fft.fftfreq(N, dx), np.fft.fftfreq(N, dx), indexing="ij")
    f = np.hypot(fx, fy)
    f[0, 0] = 1.0
    # luminance PSD: measured curve inside its range, power law (slope -beta) outside
    lf, lp = np.log(freq_mm), np.log(psd_L)
    logP = np.interp(np.log(f), lf, lp)
    hi, lo = f > freq_mm[-1], f < freq_mm[0]
    logP[hi] = lp[-1] - beta * (np.log(f[hi]) - lf[-1])
    logP[lo] = lp[0] - beta * (np.log(f[lo]) - lf[0])
    # shading ~ slope, so height amplitude = sqrt(P_L) / f
    amp = np.exp(logP / 2) / f
    amp *= 1 - np.exp(-(f * dc["max_wavelength_mm"]) ** 2)          # leave long waves to the base map
    amp *= np.exp(-(f * dc["rolloff_wavelength_mm"]) ** 2)          # soft cut below photo resolution
    amp[0, 0] = 0
    h = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((N, N))) * amp))
    h /= h.std()

    # sparse periodic pits (pecked dots)
    tile_mm = N * dx
    n_pits = rng.poisson(dc["pit_density"] * tile_mm ** 2)
    yy, xx = np.mgrid[0:N, 0:N] * dx
    pits = np.zeros((N, N))
    for cx, cy, r in zip(rng.uniform(0, tile_mm, n_pits), rng.uniform(0, tile_mm, n_pits),
                         rng.uniform(*dc["pit_radius_mm"], n_pits)):
        ddx = (xx - cx + tile_mm / 2) % tile_mm - tile_mm / 2
        ddy = (yy - cy + tile_mm / 2) % tile_mm - tile_mm / 2
        q = (ddx ** 2 + ddy ** 2) / r ** 2
        pits = np.minimum(pits, np.where(q < 1, -(1 - q) ** 2, 0.0))
    h = h + dc["pit_depth"] * pits

    # periodic central differences (px units), scale to the target RMS slope
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2
    grow = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2
    s = dc["rms_slope"] / np.sqrt((gx ** 2 + grow ** 2).mean())
    n = np.stack([-s * gx, s * grow, np.ones_like(h)], -1)     # +Y up: dh/dy_up = -dh/drow
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (h * s * dx).astype(np.float32), n, n_pits


# ---------------------------------------------------------------- main

def main():
    t0 = time.time()
    cfg = load_config()
    pc, dc, seed = cfg["photos"], cfg["detail"], cfg["seed"]
    out = REPO / cfg["paths"]["bake_dir"]
    out.mkdir(parents=True, exist_ok=True)
    mmpp = pc["photo_mm_per_px"]
    rng = np.random.default_rng(seed)

    excluded = set(pc["exclude"])
    paths = [p for p in sorted((REPO / cfg["paths"]["photos"]).glob("*.jpg")) if p.stem not in excluded]
    ref_name = pc["reference"]
    assert any(p.stem == ref_name for p in paths), ref_name
    edges = np.geomspace(1 / 512, 0.5, 41)       # cycles / photo px
    fc = np.sqrt(edges[:-1] * edges[1:])
    samples, psd_grain, var_color, keep_frac, photo_means, aniso = [], [], [], [], [], []
    thumbs, photos = [], []
    ref = {}

    for p in paths:
        srgb = np.asarray(Image.open(p).convert("RGB"), np.float64) / 255
        lin = sh.srgb_to_linear(srgb)
        lab = sh.linear_to_lab(lin)
        m = photo_mask(lab, pc)
        keep_frac.append(m.mean())

        # approximate de-lighting on luminance, chromaticity untouched
        Y = sh.luminance(lin)
        gain = np.median(Y[m]) / np.maximum(mblur(Y, m, pc["delight_sigma_px"]), 1e-4)
        lab_d = sh.linear_to_lab(np.clip(lin * gain[..., None], 0, 1))
        photo_means.append(lab_d[m].mean(0))
        photos.append((p.stem, srgb, m))

        # palette samples: slightly blurred color = regions, not speckle
        lab_b = np.stack([mblur(lab_d[..., c], m, pc["palette_blur_px"]) for c in range(3)], -1)
        idx = np.flatnonzero(m.ravel())
        samples.append(lab_b.reshape(-1, 3)[rng.choice(idx, min(len(idx), pc["palette_samples_per_photo"]), replace=False)])
        if p.stem == ref_name:
            ref["samples"] = lab_b.reshape(-1, 3)[idx]

        # color-scale spectrum: variance per radial bin of low-passed de-lit L, a, b
        vc = []
        for c in range(3):
            x = mblur(lab_d[..., c], m, pc["color_blur_px"])
            P, fx, fy = fft_power(x, m)
            vc.append(binned(P, fx, fy, edges, "sum"))
            if c == 0:
                band = (np.hypot(fx, fy) > 1 / 100) & (np.hypot(fx, fy) < 1 / 8)
                aniso.append((P[band] * fx[band] ** 2).sum() / (P[band] * fy[band] ** 2).sum())
        var_color.append(np.array(vc))

        # grain spectrum: high-pass log luminance of the de-lit image
        Yd = np.clip(Y * gain, 1e-4, None)
        g = np.log(Yd) - np.log(np.maximum(mblur(Yd, m, pc["grain_hp_sigma_px"]), 1e-4))
        P, fx, fy = fft_power(g, m)
        psd_grain.append(binned(P, fx, fy, edges))
        if p.stem == ref_name:
            ref["psd"] = psd_grain[-1]

        tint = np.where(m[..., None], srgb * 255, srgb * 255 * 0.4 + CYAN * 0.6)
        thumbs.append(Image.fromarray(tint.astype(np.uint8)).resize((180, 199), Image.LANCZOS))

    # --- mask contact sheet
    sheet = Image.new("RGB", (7 * 180, 6 * 199), (0, 0, 0))
    for i, t in enumerate(thumbs):
        sheet.paste(t, ((i % 7) * 180, (i // 7) * 199))
    sheet.save(out / "photo_masks.jpg", quality=88)

    # --- color statistics
    X = np.concatenate(samples)
    lab_mean, lab_cov = X.mean(0), np.cov(X.T)
    photo_means = np.array(photo_means)
    palette = make_palette(X, pc, seed)
    Xr = ref["samples"]
    ref_palette = make_palette(Xr, pc, seed)

    # --- color scale: variance per log-frequency bin ~ f^2 * PSD, so PSD slope = slope(sum) - 2
    VC = np.mean(var_color, 0)                         # [3, bins]
    cb = (fc >= 1 / pc["color_fit_band_px"][1]) & (fc <= 1 / pc["color_fit_band_px"][0])
    color_scale = {}
    for c, name in enumerate("Lab"):
        v = VC[c]
        cum = np.cumsum(v[2:]) / v[2:].sum()           # skip the 2 lowest (window-limited) bins
        f50 = fc[2:][np.searchsorted(cum, 0.5)]
        slope = np.polyfit(np.log(fc[cb]), np.log(v[cb]), 1)[0] - 2
        color_scale[name] = {"psd_slope": round(float(slope), 2),
                             "half_variance_wavelength_mm": round(float(1 / f50 * mmpp), 1)}
    color_scale["L_anisotropy_fx2_over_fy2"] = round(float(np.median(aniso)), 3)

    # --- grain: mean PSD, undo the high-pass filter response, fit a power law in the band
    Pg = np.mean(psd_grain, 0)
    hp = (1 - np.exp(-2 * np.pi ** 2 * pc["grain_hp_sigma_px"] ** 2 * fc ** 2)) ** 2
    ok = hp > 0.2
    Pg_c = np.where(ok, Pg / np.maximum(hp, 1e-9), np.nan)
    wl0, wl1 = pc["grain_fit_band_px"]
    band = ok & (fc >= 1 / wl1) & (fc <= 1 / wl0)
    beta, logA = np.polyfit(np.log(fc[band]), np.log(Pg_c[band]), 1)
    beta = -beta
    meas = ok & (fc <= 1 / 2.5)                        # trust the curve up to 2.5 px wavelength
    freq_mm, psd_mm = fc[meas] / mmpp, Pg_c[meas]

    # --- detail tile
    Pref_c = np.where(ok, ref["psd"] / np.maximum(hp, 1e-9), np.nan)
    beta_ref = -np.polyfit(np.log(fc[band]), np.log(Pref_c[band]), 1)[0]
    if dc["grain_source"] == "reference":
        src_psd, src_beta = Pref_c, beta_ref
    else:
        src_psd, src_beta = Pg_c, beta
    h_mm, n_detail, n_pits = synth_detail(freq_mm, src_psd[meas], src_beta, dc, seed)
    tile_mm = dc["size_px"] * dc["mm_per_px"]
    rgb_n = sh.encode_normal(n_detail)
    np.save(out / "detail_height.npy", h_mm)
    Image.fromarray(rgb_n).save(out / "detail_normal.webp", "WEBP", quality=dc["webp_quality"], method=6)
    Image.fromarray(rgb_n).save(out / "detail_normal_lossless.webp", "WEBP", lossless=True, method=6)
    size_lossy = (out / "detail_normal.webp").stat().st_size
    size_lossless = (out / "detail_normal_lossless.webp").stat().st_size
    seam = max(np.abs(rgb_n[0].astype(int) - rgb_n[-1]).mean(), np.abs(rgb_n[:, 0].astype(int) - rgb_n[:, -1]).mean())
    inner = np.abs(np.diff(rgb_n.astype(int), axis=0)).mean()

    # --- render the tile at photo scale and measure it with the same grain pipeline
    albedo = sh.lab_to_linear(Xr.mean(0))                  # reference photo color
    L = sh.light_dir(sh.DEFAULT_LIGHTING["photo_azimuth_deg"], sh.DEFAULT_LIGHTING["photo_elevation_deg"])
    nd = sh.decode_normal(np.tile(rgb_n, (2, 2, 1)))
    flat = np.zeros_like(nd)
    flat[..., 2] = 1
    render = sh.shade(flat, albedo, np.ones(nd.shape[:2]), L, n_detail=nd, detail_strength=1.0)
    k = max(1, round(mmpp / dc["mm_per_px"]))          # detail px per photo px
    rp = render.reshape(render.shape[0] // k, k, render.shape[1] // k, k, 3).mean((1, 3))
    Yr = sh.luminance(rp)
    mr = np.ones(Yr.shape, bool)
    gr = np.log(Yr) - np.log(mblur(Yr, mr, pc["grain_hp_sigma_px"]))
    P, fx, fy = fft_power(gr, mr)
    Pr = binned(P, fx, fy, edges)
    Pr_c = np.where(ok, Pr / np.maximum(hp, 1e-9), np.nan)
    beta_r = -np.polyfit(np.log(fc[band]), np.log(Pr_c[band]), 1)[0]
    chk = ok & (fc >= 1 / pc["grain_check_band_px"][1]) & (fc <= 1 / pc["grain_check_band_px"][0])
    beta_chk_p = -np.polyfit(np.log(fc[chk]), np.log(Pg_c[chk]), 1)[0]
    beta_chk_r = -np.polyfit(np.log(fc[chk]), np.log(Pr_c[chk]), 1)[0]
    beta_chk_ref = -np.polyfit(np.log(fc[chk]), np.log(Pref_c[chk]), 1)[0]

    # --- look.json
    look = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "photo_mm_per_px": mmpp,
        "n_photos": len(paths),
        "excluded_photos": sorted(excluded),
        "mask_keep_fraction": {n: round(float(f), 3) for (n, _, _), f in zip(photos, keep_frac)},
        "lab_mean": lab_mean.round(2).tolist(),
        "lab_cov": lab_cov.round(3).tolist(),
        "lab_std": np.sqrt(np.diag(lab_cov)).round(2).tolist(),
        "between_photo_lab_std": photo_means.std(0).round(2).tolist(),
        "palette": palette,
        "reference": {
            "photo": ref_name,
            "note": "main visual reference; later steps target these stats when styles clash",
            "lab_mean": Xr.mean(0).round(2).tolist(),
            "lab_cov": np.cov(Xr.T).round(3).tolist(),
            "lab_std": Xr.std(0).round(2).tolist(),
            "palette": ref_palette,
            "grain_powerlaw_beta": round(float(beta_ref), 3),
            "grain_check_beta": round(float(beta_chk_ref), 3),
            "grain_psd": [float(f"{v:.4g}") for v in Pref_c[meas]],
        },
        "color_scale": color_scale,
        "grain": {
            "freq_cyc_per_mm": freq_mm.round(5).tolist(),
            "psd": [float(f"{v:.4g}") for v in psd_mm],
            "powerlaw_beta": round(float(beta), 3),
            "fit_band_px": pc["grain_fit_band_px"],
        },
        "detail": {
            "file": "detail_normal.webp", "grain_source": dc["grain_source"], "size_px": dc["size_px"], "mm_per_px": dc["mm_per_px"],
            "tile_mm": tile_mm, "rms_slope": dc["rms_slope"], "height_rms_mm": round(float(h_mm.std()), 4),
            "n_pits": int(n_pits), "seed": seed, "normal_convention": "OpenGL +Y up, rgb = n*0.5+0.5",
            "check_band_px": pc["grain_check_band_px"],
            "check_beta_photos": round(float(beta_chk_p), 3),
            "check_beta_render": round(float(beta_chk_r), 3),
        },
    }
    (out / "look.json").write_text(json.dumps(look, indent=2))

    # --- report image
    W = 1600
    rep = Image.new("RGB", (W, 1560), (250, 249, 246))
    d = ImageDraw.Draw(rep)
    d.text((20, 12), f"Look report — {len(paths)} photos, photo_mm_per_px={mmpp} (TODO), "
                     f"Lab mean {np.round(lab_mean, 1).tolist()}, std {np.round(np.sqrt(np.diag(lab_cov)), 1).tolist()}",
           fill=(20, 20, 20))
    x = 20
    for pal in palette:
        wbox = int(1100 * pal["weight"]) + 60
        d.rectangle([x, 36, x + wbox - 6, 136], fill=pal["hex"])
        d.text((x + 4, 140), f"{pal['hex']}  w={pal['weight']:.2f}", fill=(30, 30, 30))
        d.text((x + 4, 154), "Lab " + " ".join(f"{v:.0f}" for v in pal["lab"]), fill=(30, 30, 30))
        x += wbox
    x = 20
    for pal in ref_palette:
        wbox = int(1100 * pal["weight"]) + 60
        d.rectangle([x, 176, x + wbox - 6, 222], fill=pal["hex"])
        d.text((x + 4, 226), f"{pal['hex']}  w={pal['weight']:.2f}", fill=(30, 30, 30))
        x += wbox
    d.text((x + 10, 190), f"reference {ref_name}", fill=(30, 30, 30))
    pm = sh.to_u8(sh.linear_to_srgb(sh.lab_to_linear(photo_means)))
    for i, c in enumerate(pm):
        d.rectangle([20 + i * 26, 244, 20 + i * 26 + 24, 262], fill=tuple(int(v) for v in c))
    d.text((20 + len(pm) * 26 + 8, 248), "per-photo mean (de-lit)", fill=(30, 30, 30))

    f_mm = fc / mmpp
    norm = np.nanmedian(src_psd[band] / Pr_c[band])
    rep.paste(loglog_plot([(f_mm[ok], Pg_c[ok], (150, 60, 90), f"photos (beta={beta:.2f})"),
                           (f_mm[ok], Pr_c[ok] * norm, (40, 110, 170), f"detail render x{norm:.2g} (beta={beta_r:.2f})"),
                           (f_mm[ok], Pref_c[ok], (70, 150, 70), f"{ref_name[-7:]} (beta={beta_ref:.2f})")],
                          "Grain: high-pass log-luminance PSD", "cycles / mm"), (20, 270))
    rep.paste(loglog_plot([(f_mm, VC[0], (60, 60, 60), "L"), (f_mm, VC[1], (190, 60, 90), "a"),
                           (f_mm, VC[2], (200, 150, 40), "b")],
                          f"Color scale: variance per bin (PSD slope L {color_scale['L']['psd_slope']}, "
                          f"a {color_scale['a']['psd_slope']}, b {color_scale['b']['psd_slope']})", "cycles / mm"), (800, 270))

    rimg = Image.fromarray(sh.to_u8(sh.linear_to_srgb(rp)))
    rep.paste(rimg.resize((512, 512)), (20, 680))
    d.text((20, 1196), f"detail tile 2x2 at photo scale ({2 * tile_mm:.0f} mm), reference albedo, "
                       f"light az {sh.DEFAULT_LIGHTING['photo_azimuth_deg']:.0f} el "
                       f"{sh.DEFAULT_LIGHTING['photo_elevation_deg']:.0f}", fill=(30, 30, 30))
    for i, name in enumerate([ref_name, "original_Page_18"]):
        _, srgb, _ = next(ph for ph in photos if ph[0] == name)
        h0, w0 = srgb.shape[:2]
        crop = srgb[(h0 - 512) // 2:(h0 + 512) // 2, (w0 - 512) // 2:(w0 + 512) // 2]
        rep.paste(Image.fromarray(sh.to_u8(crop)), (550 + i * 530, 680))
        d.text((550 + i * 530, 1196), f"{name} center crop 512 px", fill=(30, 30, 30))
    tile = Image.fromarray(rgb_n)
    rep.paste(tile.resize((256, 256)), (20, 1220))
    d.text((290, 1230), f"detail_normal.webp  {dc['size_px']}px = {tile_mm:.0f} mm, "
                        f"{size_lossy / 1024:.0f} KB (q{dc['webp_quality']}), lossless {size_lossless / 1024:.0f} KB, "
                        f"{n_pits} pits", fill=(30, 30, 30))
    rep.save(out / "look_report.png")

    # --- console report
    print(f"photos: {len(paths)}, mask keep fraction median {np.median(keep_frac):.2f} "
          f"(min {min(keep_frac):.2f} {photos[int(np.argmin(keep_frac))][0]})")
    print(f"Lab mean {lab_mean.round(1)}  std {np.sqrt(np.diag(lab_cov)).round(1)}  "
          f"between-photo std {photo_means.std(0).round(1)}")
    print("palette (dark -> light):")
    for pal in palette:
        print(f"  {pal['hex']}  w={pal['weight']:.3f}  Lab {pal['lab']}  std {pal['lab_std']}")
    print(f"reference {ref_name}: Lab mean {Xr.mean(0).round(1)} std {Xr.std(0).round(1)}, "
          f"grain beta {beta_ref:.2f} (shared band {beta_chk_ref:.2f})")
    for pal in ref_palette:
        print(f"  {pal['hex']}  w={pal['weight']:.3f}  Lab {pal['lab']}")
    print(f"color scale: {json.dumps(color_scale)}")
    print(f"grain PSD power-law beta={beta:.2f} (band {wl0}-{wl1} px); detail render beta={beta_r:.2f}")
    print(f"  shared band {pc['grain_check_band_px']} px: photos beta={beta_chk_p:.2f}, render beta={beta_chk_r:.2f} (source: {dc['grain_source']}, {beta_chk_ref:.2f})")
    print(f"detail tile: {dc['size_px']}px, {tile_mm:.0f} mm, height rms {h_mm.std():.3f} mm, {n_pits} pits")
    print(f"detail_normal.webp {size_lossy:,} B (q{dc['webp_quality']}), lossless {size_lossless:,} B")
    print(f"tiling seam check: mean |edge row diff| {seam:.2f} vs mean |adjacent row diff| {inner:.2f}")
    print(f"done in {time.time() - t0:.1f}s -> {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
