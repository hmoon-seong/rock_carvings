"""Register ref/2d/drawing pages onto the wall grid and extract figure masks (Step 4 emboss input).

The drawing pages are crops of a shaded render of this same scan with figures painted on top
(brown, plus some purple). Each page is matched to our own shaded height map by masked
normalized cross-correlation over scale, rotation and translation (a similarity transform).

  python3 register_drawings.py calibrate   # wide scale/rotation/light sweep on a few pages
  python3 register_drawings.py register    # all pages, narrow search around the calibration

Outputs (data/bake/): drawings_calib.json, drawings_reg.json, carve_brown.npy, carve_purple.npy,
drawings_overlay.png, drawings_pages/*.png (per-page match check).
"""
from __future__ import annotations

import json
import sys
import time

import numpy as np
from PIL import Image
from scipy import fft as sfft
from scipy.ndimage import (affine_transform, binary_dilation, binary_opening, gaussian_filter,
                           uniform_filter, zoom)

from bake import hillshade
from ply import REPO, load_config

W_ = -1  # scipy.fft workers: all cores


# ---------------------------------------------------------------- inputs

def page_layers(path, rc):
    """-> gray (float), usable mask (rock, not figure/background), brown mask, purple mask."""
    rgb = np.asarray(Image.open(path).convert("RGB"), np.float64)
    mx, mn = rgb.max(-1), rgb.min(-1)
    chroma = mx - mn
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    fig = chroma > rc["figure_chroma"]
    purple = fig & (b > g + rc["purple_b_minus_g"])
    brown = fig & ~purple
    gray = rgb.mean(-1)
    bg_rgb = np.array(rc["background_rgb"], float)
    near_bg = np.abs(rgb - bg_rgb).max(-1) < rc["background_tol"]
    flat = np.sqrt(np.maximum(uniform_filter(gray ** 2, 7) - uniform_filter(gray, 7) ** 2, 0)) < rc["background_flat_std"]
    bg = binary_opening(near_bg & flat, iterations=3)
    bg = binary_dilation(bg, iterations=4)
    usable = ~binary_dilation(fig, iterations=4) & ~bg
    return gray, usable, brown, purple


def features(gray, mask, sigma):
    """Masked high-pass, unit variance inside the mask."""
    m = mask.astype(np.float64)
    lo = gaussian_filter(gray * m, sigma) / np.maximum(gaussian_filter(m, sigma), 1e-6)
    f = np.where(mask, gray - lo, 0.0)
    s = f[mask].std() if mask.any() else 1.0
    return f / max(s, 1e-9)


def wall_render(height, valid, mm_per_px, az, el, factor):
    img = hillshade(np.where(valid, height, -np.inf), mm_per_px, az=az, el=el)[..., 0].astype(np.float64)
    if factor > 1:
        H, W = (np.array(img.shape) // factor) * factor
        img = img[:H, :W].reshape(H // factor, factor, W // factor, factor).mean((1, 3))
        v = valid[:H, :W].reshape(H // factor, factor, W // factor, factor).mean((1, 3)) > 0.99
    else:
        v = valid
    return img, v


# ---------------------------------------------------------------- masked NCC

class Matcher:
    """Masked NCC of many templates against one fixed image (Padfield 2012)."""

    def __init__(self, img, mask, pad):
        self.pad = pad
        I = np.pad(np.where(mask, img, 0.0), pad)
        J = np.pad(mask.astype(np.float64), pad)
        self.shape = I.shape
        s = self.fshape = [sfft.next_fast_len(n, real=True) for n in I.shape]
        self.FIJ = sfft.rfft2(I * J, s, workers=W_)
        self.FJ = sfft.rfft2(J, s, workers=W_)
        self.FI2J = sfft.rfft2(I * I * J, s, workers=W_)

    def match(self, T, M, min_overlap=0.6):
        s = self.fshape
        M = M.astype(np.float64)
        TM = T * M
        FM = np.conj(sfft.rfft2(M, s, workers=W_))
        FTM = np.conj(sfft.rfft2(TM, s, workers=W_))
        FT2M = np.conj(sfft.rfft2(TM * T, s, workers=W_))
        ir = lambda X: sfft.irfft2(X, s, workers=W_)[: self.shape[0] - T.shape[0] + 1, : self.shape[1] - T.shape[1] + 1]
        n = ir(self.FJ * FM)
        sI, sT = ir(self.FIJ * FM), ir(self.FJ * FTM)
        sIT, sI2, sT2 = ir(self.FIJ * FTM), ir(self.FI2J * FM), ir(self.FJ * FT2M)
        n = np.maximum(n, 1e-6)
        num = sIT - sI * sT / n
        den = np.sqrt(np.maximum((sI2 - sI ** 2 / n) * (sT2 - sT ** 2 / n), 1e-9))
        ok = n > min_overlap * M.sum()
        if not ok.any():
            return -1.0, 0.0, 0, 0
        score = np.where(ok, num / den, -1.0)
        k = np.argmax(score)
        dy, dx = np.unravel_index(k, score.shape)
        # peak-to-sidelobe ratio: size-independent significance of the peak
        vals = score[ok]
        psr = (score.flat[k] - np.median(vals)) / max(vals.std(), 1e-9)
        return float(psr), float(score.flat[k]), dx - self.pad, dy - self.pad


def warp_page(arr, scale, rot_deg, order=1):
    """Similarity-warp a page (page px -> target px): x' = scale * R(rot) x + offset.

    Returns warped array and the offset (target coords of the warped array's origin)."""
    h, w = arr.shape
    c, s_ = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    A = scale * np.array([[c, -s_], [s_, c]])                     # (x, y)
    corners = np.array([[0, 0], [w, 0], [0, h], [w, h]], float) @ A.T
    lo = np.floor(corners.min(0))
    size = np.ceil(corners.max(0) - lo).astype(int) + 1
    Ai = np.linalg.inv(A)
    # affine_transform works in (row, col): page_rc = Ai_rc @ out_rc + off_rc
    Ai_rc = Ai[::-1, ::-1]
    off = Ai @ lo
    out = affine_transform(arr.astype(np.float64), Ai_rc, offset=off[::-1], output_shape=(size[1], size[0]),
                           order=order, cval=0.0)
    return out, A, lo


def match_page(matcher, gray, usable, scale, rot, sigma):
    g, _, _ = warp_page(gray, scale, rot)
    m, A, lo = warp_page(usable.astype(np.float64), scale, rot, order=0)
    m = m > 0.5
    if m.sum() < 500:
        return -1.0, None
    T = features(g, m, sigma)
    psr, ncc, dx, dy = matcher.match(T, m)
    return psr, (A, lo, dx, dy, ncc)


# ---------------------------------------------------------------- stages

def load_wall(cfg):
    out = REPO / cfg["paths"]["bake_dir"]
    grid = json.loads((out / "grid.json").read_text())
    return out, grid, np.load(out / "height.npy").astype(np.float64), np.load(out / "valid.npy")


def calibrate(cfg):
    rc = cfg["register"]
    out, grid, height, valid = load_wall(cfg)
    f = rc["coarse_factor"]
    mmpp = grid["mm_per_px"] * f
    pages = [REPO / cfg["paths"]["drawings"] / f"drawings_Page_{p:02d}.jpg" for p in rc["calib_pages"]]
    layers = [page_layers(p, rc) for p in pages]
    scales = np.geomspace(*rc["calib_page_mm_per_px"], rc["calib_n_scales"])
    rots = np.arange(-rc["calib_rot_deg"], rc["calib_rot_deg"] + 1e-9, rc["calib_rot_step"])
    results = []
    for az, el in rc["calib_lights"]:
        img, v = wall_render(height, valid, grid["mm_per_px"], az, el, f)
        I = features(img, v, rc["feature_sigma_px"])
        pad = int(max(max(l[0].shape) for l in layers) * scales[-1] / mmpp * 0.75) + 4
        matcher = Matcher(I, v, pad)
        for pi, (p, (gray, usable, _, _)) in enumerate(zip(rc["calib_pages"], layers)):
            t0 = time.time()
            best = (-1, None, None)
            table = np.zeros((len(scales), len(rots)))
            for si, s in enumerate(scales):
                for ri, r in enumerate(rots):
                    sc, tr = match_page(matcher, gray, usable, s / mmpp, r, rc["feature_sigma_px"])
                    table[si, ri] = sc
                    if sc > best[0]:
                        best = (sc, s, r, tr[4], tr[2] + 0, tr[3] + 0)
            srt = np.sort(table.ravel())[::-1]
            results.append({"light": [az, el], "page": p, "score": best[0], "ncc": best[3],
                            "page_mm_per_px": best[1], "rot_deg": best[2], "offset_px": [int(best[4]), int(best[5])],
                            "runner_up_gap": float(srt[0] - np.median(srt[:50]))})
            np.save(out / f"calib_table_p{p:02d}_az{int(az)}.npy", table)
            print(f"light az{az} el{el} page {p:02d}: best PSR {best[0]:.2f} (ncc {best[3]:.3f}) at {best[1]:.3f} mm/px, "
                  f"rot {best[2]:+.1f}° off {best[4]},{best[5]}  (median of top-50 {np.median(srt[:50]):.2f})  "
                  f"{time.time() - t0:.0f}s", flush=True)
    (out / "drawings_calib.json").write_text(json.dumps(results, indent=2))


def register(cfg):
    rc = cfg["register"]
    out, grid, height, valid = load_wall(cfg)
    calib = json.loads((out / "drawings_calib.json").read_text())
    good = [c for c in calib if c["score"] > rc["accept_score"]]
    assert good, "no calibration page matched; check drawings_calib.json"
    az, el = max(good, key=lambda c: c["score"])["light"]
    good = [c for c in good if c["light"] == [az, el]]
    s0 = float(np.median([c["page_mm_per_px"] for c in good]))
    r0 = float(np.median([c["rot_deg"] for c in good]))
    print(f"calibration: light az{az} el{el}, page {s0:.3f} mm/px, rot {r0:+.1f}° from {len(good)} pages")

    f = rc["coarse_factor"]
    mmpp = grid["mm_per_px"] * f
    img, v = wall_render(height, valid, grid["mm_per_px"], az, el, f)
    I = features(img, v, rc["feature_sigma_px"])
    scales = s0 * np.geomspace(1 / rc["reg_scale_range"], rc["reg_scale_range"], rc["reg_n_scales"])
    rots = r0 + np.arange(-rc["reg_rot_deg"], rc["reg_rot_deg"] + 1e-9, rc["reg_rot_step"])
    pages = sorted((REPO / cfg["paths"]["drawings"]).glob("*.jpg"))
    pad = int(800 * scales[-1] / mmpp * 0.75) + 4
    matcher = Matcher(I, v, pad)

    H, W = valid.shape
    brown_acc = np.zeros((H, W))
    purple_acc = np.zeros((H, W))
    base = hillshade(np.where(valid, height, -np.inf), grid["mm_per_px"], az=az, el=el).astype(np.float64)
    overlay = base.copy()
    reg = []
    (out / "drawings_pages").mkdir(exist_ok=True)
    for p in pages:
        t0 = time.time()
        gray, usable, brown, purple = page_layers(p, rc)
        best = (-1.0, None, None, None)
        for s in scales:
            for r in rots:
                sc, tr = match_page(matcher, gray, usable, s / mmpp, r, rc["feature_sigma_px"])
                if sc > best[0]:
                    best = (sc, s, r, tr)
        sc, s, r, (A, lo, dx, dy, ncc) = best
        # page px -> full-res grid px:  f * (A @ p - lo + d)
        A_full = A * f
        b_full = (np.array([dx, dy]) - lo) * f
        ok = sc > rc["accept_score"]
        reg.append({"page": p.stem, "score": round(sc, 4), "ncc": round(ncc, 4), "page_mm_per_px": round(s, 4), "rot_deg": round(r, 2),
                    "A": A_full.round(6).tolist(), "b": b_full.round(3).tolist(), "accepted": bool(ok),
                    "figure_px": int(brown.sum() + purple.sum())})
        # warp figure masks into the grid
        Ai = np.linalg.inv(A_full)
        grid_rc = lambda m: affine_transform(m.astype(np.float64), Ai[::-1, ::-1], offset=(-Ai @ b_full)[::-1],
                                             output_shape=(H, W), order=1, cval=0.0)
        wb, wp = grid_rc(brown), grid_rc(purple)
        cover = grid_rc(np.ones_like(gray))
        if ok:
            brown_acc = np.maximum(brown_acc, wb)
            purple_acc = np.maximum(purple_acc, wp)
        # per-page check image: page gray vs our render at the found placement
        ys, xs = np.nonzero(cover > 0.5)
        if len(ys):
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            crop = base[y0:y1, x0:x1, 0]
            pg = Image.open(p).convert("RGB").resize((x1 - x0, y1 - y0)) if abs(r) < 0.01 else None
            chk = np.stack([crop] * 3, -1)
            chk[..., 0] = np.clip(chk[..., 0] + 160 * wb[y0:y1, x0:x1], 0, 255)
            chk[..., 2] = np.clip(chk[..., 2] + 160 * wp[y0:y1, x0:x1], 0, 255)
            left = np.asarray(Image.open(p).convert("RGB").resize((360, int(360 * gray.shape[0] / gray.shape[1]))))
            right = np.asarray(Image.fromarray(chk.astype(np.uint8)).resize((360, left.shape[0])))
            Image.fromarray(np.concatenate([left, right], 1)).save(out / "drawings_pages" / f"{p.stem}.jpg", quality=85)
        edge = binary_dilation(cover > 0.5, iterations=2) & ~(cover > 0.5)
        overlay[edge] = [0, 200, 0] if ok else [220, 0, 0]
        print(f"{p.stem}: score {sc:.3f} {'OK ' if ok else 'REJ'} {s:.3f} mm/px rot {r:+.1f}° "
              f"at grid ({b_full[0]:.0f},{b_full[1]:.0f})  {time.time() - t0:.0f}s", flush=True)

    overlay[..., 0] = np.clip(overlay[..., 0] + 150 * brown_acc, 0, 255)
    overlay[..., 2] = np.clip(overlay[..., 2] + 150 * purple_acc, 0, 255)
    Image.fromarray(overlay.astype(np.uint8)).save(out / "drawings_overlay.png")
    np.save(out / "carve_brown.npy", brown_acc.astype(np.float32))
    np.save(out / "carve_purple.npy", purple_acc.astype(np.float32))
    (out / "drawings_reg.json").write_text(json.dumps({"light": [az, el], "pages": reg}, indent=2))
    acc = sum(r["accepted"] for r in reg)
    print(f"accepted {acc}/{len(reg)} pages; carve area brown {(brown_acc > 0.5).mean():.2%}, "
          f"purple {(purple_acc > 0.5).mean():.2%} of grid")


if __name__ == "__main__":
    {"calibrate": calibrate, "register": register}[sys.argv[1]](load_config())
