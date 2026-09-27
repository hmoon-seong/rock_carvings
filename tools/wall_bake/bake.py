"""Steps 2 to 6 of WALL_BAKE.md. Usage: python3 bake.py align

Intermediates go to data/bake/.
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

import shading as sh
from ply import REPO, load_config, read_ply


# ---------------------------------------------------------------- geometry helpers

def face_geometry(xyz, faces):
    a, b, c = xyz[faces[:, 0]], xyz[faces[:, 1]], xyz[faces[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    normal = cross / np.maximum(area2, 1e-30)[:, None]
    longest = np.maximum.reduce([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1),
                                 np.linalg.norm(a - c, axis=1)])
    return (a + b + c) / 3, normal, area2 / 2, longest


def largest_component(xyz, faces):
    V = len(xyz)
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]]])
    ncomp, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(V, V)),
                                      directed=False)
    counts = np.bincount(lab[faces[:, 0]], minlength=ncomp)
    big = np.argmax(counts)
    keep_f = lab[faces[:, 0]] == big
    used = np.zeros(V, bool)
    used[faces[keep_f].ravel()] = True
    remap = np.cumsum(used) - 1
    return xyz[used], remap[faces[keep_f]].astype(np.int32), int((counts > 0).sum()), int((~keep_f).sum())


def rasterize(px, py, z, faces, W, H, chunk=4_000_000):
    """Z-buffer (keep max z) of triangles given vertex pixel coords (pixel centers at i+0.5).

    Triangles are bucketed by bbox size, and each bucket is evaluated on its bbox grid
    at once, so small and large triangles are both vectorized.
    """
    zbuf = np.full(H * W, -np.inf)
    tx, ty, tz = px[faces], py[faces], z[faces]
    x0 = np.floor(tx.min(1) - 0.5).astype(np.int64)
    y0 = np.floor(ty.min(1) - 0.5).astype(np.int64)
    size = np.maximum(np.ceil(tx.max(1) - 0.5).astype(np.int64) - x0,
                      np.ceil(ty.max(1) - 0.5).astype(np.int64) - y0) + 1
    # barycentric denominators; drop degenerate
    d = (ty[:, 1] - ty[:, 2]) * (tx[:, 0] - tx[:, 2]) + (tx[:, 2] - tx[:, 1]) * (ty[:, 0] - ty[:, 2])
    ok = np.abs(d) > 1e-12
    bucket = np.ceil(np.log2(np.maximum(size, 1))).astype(int)
    for bk in np.unique(bucket[ok]):
        s = 1 << bk
        ids = np.flatnonzero(ok & (bucket == bk))
        oy, ox = np.mgrid[0:s, 0:s]
        oy, ox = oy.ravel(), ox.ravel()
        step = max(1, chunk // (s * s))
        for i in range(0, len(ids), step):
            t = ids[i:i + step]
            gx = x0[t, None] + ox[None]
            gy = y0[t, None] + oy[None]
            cx, cy = gx + 0.5, gy + 0.5
            X, Y = tx[t], ty[t]
            w0 = ((Y[:, 1:2] - Y[:, 2:3]) * (cx - X[:, 2:3]) + (X[:, 2:3] - X[:, 1:2]) * (cy - Y[:, 2:3])) / d[t, None]
            w1 = ((Y[:, 2:3] - Y[:, 0:1]) * (cx - X[:, 2:3]) + (X[:, 0:1] - X[:, 2:3]) * (cy - Y[:, 2:3])) / d[t, None]
            w2 = 1 - w0 - w1
            eps = -1e-9
            inside = (w0 >= eps) & (w1 >= eps) & (w2 >= eps) & (gx >= 0) & (gx < W) & (gy >= 0) & (gy < H)
            if not inside.any():
                continue
            Z = w0 * tz[t, 0:1] + w1 * tz[t, 1:2] + w2 * tz[t, 2:3]
            np.maximum.at(zbuf, (gy * W + gx)[inside], Z[inside])
    return zbuf.reshape(H, W)


def hillshade(zb, px_size, az=315.0, el=45.0):
    valid = np.isfinite(zb)
    z = np.where(valid, zb, np.nan)
    fill = np.nanmedian(z)
    z = np.where(valid, z, fill)
    dzdx = np.gradient(z, px_size, axis=1)
    dzdy_up = -np.gradient(z, px_size, axis=0)
    n = np.stack([-dzdx, -dzdy_up, np.ones_like(z)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    shade = np.clip(n @ sh.light_dir(az, el), 0, 1) * 0.8 + 0.15
    img = np.stack([shade] * 3, -1)
    img[~valid] = [0.10, 0.12, 0.18]
    return sh.to_u8(img)


# ---------------------------------------------------------------- Step 2

def step_align(cfg):
    t0 = time.time()
    ac = cfg["align"]
    out = REPO / cfg["paths"]["bake_dir"]
    out.mkdir(parents=True, exist_ok=True)

    xyz, faces, _ = read_ply()
    xyz, faces, ncomp, dropped_f = largest_component(xyz, faces)
    print(f"kept largest of {ncomp} components: {len(xyz):,} vertices, {len(faces):,} faces "
          f"(dropped {dropped_f:,} faces)")

    cen, fn, area, longest = face_geometry(xyz, faces)
    fine = longest < ac["fine_edge_max"]
    w = area[fine]
    print(f"fine faces (longest edge < {ac['fine_edge_max']}): {fine.sum():,} "
          f"({fine.mean():.1%} of faces, {w.sum() / area.sum():.1%} of area)")

    # area-weighted PCA on fine face centroids
    P = cen[fine]
    mean = (P * w[:, None]).sum(0) / w.sum()
    C = ((P - mean) * w[:, None]).T @ (P - mean) / w.sum()
    evals, evecs = np.linalg.eigh(C)
    normal = evecs[:, 0]
    mean_n = (fn[fine] * w[:, None]).sum(0)
    mean_n /= np.linalg.norm(mean_n)
    auto_sign = 1.0 if mean_n @ normal > 0 else -1.0
    sign = -auto_sign if ac["flip_normal"] else auto_sign
    Z = normal * sign
    print(f"PCA eigvals {evals.round(0)}  smallest/middle {evals[0] / evals[1]:.3f}")
    print(f"fine-face mean normal · PCA normal = {mean_n @ normal:+.3f} -> auto sign {auto_sign:+.0f}"
          f"{' (flip_normal override!)' if ac['flip_normal'] else ''}")

    # in-plane: scan up axis projected onto the wall plane = image +Y, then roll
    up = np.asarray(ac["up_axis"], float)
    Yax = up - Z * (up @ Z)
    assert np.linalg.norm(Yax) > 0.2, "up_axis is nearly parallel to the wall normal"
    Yax /= np.linalg.norm(Yax)
    Xax = np.cross(Yax, Z)
    r = np.radians(ac["roll_degrees"])
    Xax, Yax = np.cos(r) * Xax + np.sin(r) * Yax, -np.sin(r) * Xax + np.cos(r) * Yax
    R = np.stack([Xax, Yax, Z])                        # rows: image x (right), y (up), z (toward viewer)
    tilt = np.degrees(np.arctan2(evecs[:, 2] @ Yax, evecs[:, 2] @ Xax))
    tilt = (tilt + 90) % 180 - 90
    print(f"up axis {up.tolist()} · wall normal = {up @ Z:+.3f}; PCA major axis is {tilt:+.2f}° from image horizontal"
          f"; roll_degrees = {ac['roll_degrees']}")

    A = (xyz - mean) @ R.T
    # scale from the fine surface's robust width
    fine_v = np.unique(faces[fine])
    lo, hi = np.percentile(A[fine_v, 0], [0.5, 99.5])
    width_units = hi - lo
    if ac["real_width_m"] > 0:
        scale, units = ac["real_width_m"] * 1000 / width_units, "mm"
    else:
        scale, units = ac["provisional_width_m"] * 1000 / width_units, "mm (provisional)"
        print(f"WARNING: align.real_width_m is unset; using provisional_width_m = {ac['provisional_width_m']} (TODO)")
    A *= scale
    ext = np.ptp(A[fine_v], axis=0)
    print(f"aligned extent of fine surface: x {ext[0]:.1f}  y {ext[1]:.1f}  z {ext[2]:.1f} {units}"
          f"  (robust width {width_units * scale:.1f})")

    _, fn_a, area_a, _ = face_geometry(A, faces)
    fz = fn_a[:, 2]
    tot = area_a[fine].sum()
    print(f"fine-face area facing +z (n_z>0.5): {area_a[fine & (fz > 0.5)].sum() / tot:.1%}, "
          f"-z (n_z<-0.5): {area_a[fine & (fz < -0.5)].sum() / tot:.1%}")

    np.savez(out / "aligned.npz", xyz=A.astype(np.float32), faces=faces)
    info = {"rotation_rows_xyz": R.round(6).tolist(), "center_scan_units": mean.round(4).tolist(),
            "scale": scale, "units": units, "auto_sign": auto_sign, "flip_normal": ac["flip_normal"],
            "roll_degrees": ac["roll_degrees"], "pca_major_tilt_deg": round(float(tilt), 3),
            "robust_width": round(float(width_units * scale), 2), "scan_units_per_mm": 1 / scale, "components_total": ncomp,
            "faces_dropped": dropped_f, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (out / "align.json").write_text(json.dumps(info, indent=2))

    # previews: front (chosen sign) and back (the other sign, seen from the other side, unmirrored)
    Wp = ac["preview_width_px"]
    xmin, xmax = A[:, 0].min(), A[:, 0].max()
    ymin, ymax = A[:, 1].min(), A[:, 1].max()
    px_size = (xmax - xmin) / Wp
    Hp = int(np.ceil((ymax - ymin) / px_size))
    for name, xs, zs in (("front", 1, 1), ("back", -1, -1)):
        x = A[:, 0] * xs
        px = (x - x.min()) / px_size
        py = (ymax - A[:, 1]) / px_size
        tr = time.time()
        zb = rasterize(px, py, A[:, 2] * zs, faces, Wp, Hp)
        img = hillshade(zb, px_size)
        Image.fromarray(img).save(out / f"align_preview_{name}.png")
        print(f"align_preview_{name}.png {Wp}x{Hp}, px {px_size:.2f} {units}, "
              f"coverage {np.isfinite(zb).mean():.1%}, raster {time.time() - tr:.1f}s")
    print(f"done in {time.time() - t0:.1f}s")


# ---------------------------------------------------------------- Step 3

def step_raster(cfg):
    t0 = time.time()
    gc, ac = cfg["grid"], cfg["align"]
    out = REPO / cfg["paths"]["bake_dir"]
    info = json.loads((out / "align.json").read_text())
    d = np.load(out / "aligned.npz")
    A, faces = d["xyz"].astype(np.float64), d["faces"]

    _, fn, _, longest = face_geometry(A, faces)
    front = fn[:, 2] > np.cos(np.radians(gc["max_facing_deg"]))
    fine = longest < gc["cap_edge_max"] / info["scan_units_per_mm"]
    keep = front & fine
    print(f"culled: back/side-facing {(~front).sum():,}, coarse cap {(front & ~fine).sum():,}; "
          f"kept {keep.sum():,} of {len(faces):,} faces")
    faces = faces[keep]
    used = np.unique(faces)
    x0, x1 = A[used, 0].min(), A[used, 0].max()
    y0, y1 = A[used, 1].min(), A[used, 1].max()
    px = (x1 - x0) / gc["target_width_px"]
    W, H = gc["target_width_px"], int(np.ceil((y1 - y0) / px))
    print(f"grid {W} x {H}, {px:.3f} mm/px, wall {x1 - x0:.0f} x {y1 - y0:.0f} mm")

    zb = rasterize((A[:, 0] - x0) / px, (y1 - A[:, 1]) / px, A[:, 2], faces, W, H)
    covered = np.isfinite(zb)

    # fill small holes: nearest valid value, then a light blur inside the filled pixels
    from scipy.ndimage import binary_erosion, distance_transform_edt, gaussian_filter, label
    holes, n = label(~covered)
    sizes = np.bincount(holes.ravel())
    small = (sizes <= gc["max_hole_px"])
    small[0] = False
    border = np.unique(np.concatenate([holes[0], holes[-1], holes[:, 0], holes[:, -1]]))
    small[border] = False                              # regions touching the frame are outside
    fillmask = small[holes]
    _, (iy, ix) = distance_transform_edt(~covered, return_indices=True)
    height = np.where(covered, zb, zb[iy, ix])
    blurred = gaussian_filter(height, 1.5)
    height = np.where(fillmask, blurred, height)
    valid = binary_erosion(covered | fillmask, iterations=gc["edge_crop_px"])
    from scipy.ndimage import binary_opening
    disk = np.hypot(*np.mgrid[-gc["open_px"]:gc["open_px"] + 1, -gc["open_px"]:gc["open_px"] + 1]) <= gc["open_px"]
    valid = binary_opening(valid, structure=disk)
    lab_v, nv = label(valid)
    valid = lab_v == np.argmax(np.bincount(lab_v.ravel())[1:]) + 1      # largest piece only
    valid[H - int(round(gc["bottom_crop_mm"] / px)):] = False

    # the solid's cap and base walls are artificially smooth: trim them near the outer edge
    from scipy.ndimage import uniform_filter
    lap = np.abs(height - gaussian_filter(height, 1.0))
    rough = uniform_filter(lap, 15)
    edge_dist = distance_transform_edt(valid) * px
    interior = valid & (edge_dist > gc["smooth_trim_band_mm"])
    thr = gc["smooth_trim_rough"] or float(np.percentile(rough[interior], 5))
    smooth = valid & (edge_dist <= gc["smooth_trim_band_mm"]) & (rough < thr)
    smooth = binary_opening(smooth, structure=disk)
    valid &= ~smooth
    valid = binary_opening(valid, structure=disk)
    lab_v, _ = label(valid)
    valid = lab_v == np.argmax(np.bincount(lab_v.ravel())[1:]) + 1
    from scipy.ndimage import binary_fill_holes
    valid = binary_fill_holes(valid) & (covered | fillmask)
    print(f"smooth trim: roughness threshold {thr:.3f} mm, removed {smooth.sum():,} px")
    print(f"coverage {covered.mean():.1%}; filled {fillmask.sum():,} px in {small.sum():,} holes; "
          f"valid after crop {valid.mean():.1%}")

    np.save(out / "height.npy", height.astype(np.float32))
    np.save(out / "valid.npy", valid)
    np.save(out / "covered.npy", covered)
    grid = {"width_px": W, "height_px": H, "mm_per_px": px, "origin_mm": [x0, y1],
            "units": info["units"], "note": "x right, y down from origin_mm (top-left); height = +z toward viewer"}
    (out / "grid.json").write_text(json.dumps(grid, indent=2))
    lo, hi = np.percentile(height[valid], [0.5, 99.5])
    h16 = (np.clip((height - lo) / (hi - lo), 0, 1) * 65535).astype(np.uint16)
    h16[~valid] = 0
    Image.fromarray(h16).save(out / "height_preview.png")
    Image.fromarray(hillshade(np.where(valid, height, -np.inf), px)).save(out / "height_shaded.png")
    print(f"height range p0.5..p99.5 {lo:.1f}..{hi:.1f} mm; done in {time.time() - t0:.1f}s")


# ---------------------------------------------------------------- Steps 4 to 6 helpers

def mblur(x, m, sigma):
    from scipy.ndimage import gaussian_filter
    m = m.astype(np.float64)
    return gaussian_filter(x * m, sigma) / np.maximum(gaussian_filter(m, sigma), 1e-6)


def robust_norm(x, valid):
    return x / max(float(np.std(x[valid])), 1e-12)


def fbm(shape, mm_per_px, slope, lam_min, lam_max, rng, stretch_y=1.0):
    """Spectral noise, PSD ~ f^slope between wavelengths lam_min..lam_max (mm); unit std.

    stretch_y > 1 elongates features vertically."""
    H, W = shape
    fy, fx = np.meshgrid(np.fft.fftfreq(H, mm_per_px), np.fft.rfftfreq(W, mm_per_px), indexing="ij")
    f = np.hypot(fx, fy * stretch_y)
    f[0, 0] = 1.0
    amp = f ** (slope / 2)
    amp *= (1 - np.exp(-(f * lam_max) ** 2)) * np.exp(-(f * lam_min) ** 2)
    amp[0, 0] = 0
    x = np.fft.irfft2(np.fft.rfft2(rng.standard_normal(shape)) * amp, s=shape)
    return (x - x.mean()) / x.std()


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def gray_png(x, valid, path, lo=None, hi=None):
    lo = np.percentile(x[valid], 1) if lo is None else lo
    hi = np.percentile(x[valid], 99) if hi is None else hi
    img = np.clip((x - lo) / (hi - lo), 0, 1)
    img[~valid] = 0
    Image.fromarray((img * 255).astype(np.uint8)).save(path)


# ---------------------------------------------------------------- Step 4

def step_layers(cfg):
    from scipy.ndimage import gaussian_filter, gaussian_laplace
    t0 = time.time()
    lc, ec = cfg["layers"], cfg["emboss"]
    out = REPO / cfg["paths"]["bake_dir"]
    grid = json.loads((out / "grid.json").read_text())
    px = grid["mm_per_px"]
    height = np.load(out / "height.npy").astype(np.float64)
    valid = np.load(out / "valid.npy")

    h = gaussian_filter(height, lc["facet_sigma_px"])
    low = mblur(h, valid, lc["large_sigma_mm"] / px)
    final = (h - low) + lc["low_weight"] * low
    print(f"low: sigma {lc['large_sigma_mm']} mm; detail std {np.std((h - low)[valid]):.2f} mm, "
          f"low std {np.std(low[valid]):.1f} mm")

    carve = np.zeros_like(final)
    if ec["enabled"] and (out / "carve_brown.npy").exists():
        rng = np.random.default_rng(cfg["seed"] + 11)
        brown = np.load(out / "carve_brown.npy").astype(np.float64)
        purple = np.load(out / "carve_purple.npy").astype(np.float64)
        rough = 1 + ec["roughness"] * np.clip(fbm(final.shape, px, -2.0, 1.5 * px, ec["rough_scale_mm"], rng), -2, 2) / 2
        depth = gaussian_filter(ec["brown_depth_mm"] * (brown > 0.5) + ec["purple_depth_mm"] * ((purple > 0.5) & (brown <= 0.5)),
                                ec["edge_mm"] / px)
        final -= depth * rough
        carve = gaussian_filter(np.maximum(brown, purple), ec["edge_mm"] / px)
        print(f"emboss: brown {(brown > 0.5).sum():,} px, purple {(purple > 0.5).sum():,} px, "
              f"max depth {depth.max():.2f} mm")
    elif ec["enabled"]:
        print("WARNING: emboss enabled but carve_*.npy missing (run register_drawings.py register)")

    curv = np.zeros_like(final)
    for s in lc["curvature_scales_px"]:
        curv += robust_norm(-gaussian_laplace(final, s) * s * s, valid)
    curv = np.tanh(curv / len(lc["curvature_scales_px"]))

    cav = np.zeros_like(final)
    for s in lc["ao_scales_px"]:
        cav += np.clip(mblur(final, valid, s) - final, 0, None) / (s * px)
    cav /= len(lc["ao_scales_px"])
    ao = np.clip(np.exp(-lc["ao_strength"] * cav), lc["ao_min"], 1.0)
    print(f"curvature std {curv[valid].std():.3f}; ao mean {ao[valid].mean():.3f}, p5 {np.percentile(ao[valid], 5):.3f}")

    for name, arr in (("low", low), ("final", final), ("curvature", curv), ("ao", ao), ("carve", carve)):
        np.save(out / f"{name}.npy", arr.astype(np.float32))
    gray_png(curv, valid, out / "curvature.png", -1, 1)
    gray_png(ao, valid, out / "ao.png", 0, 1)
    Image.fromarray(hillshade(np.where(valid, final, -np.inf), px, az=315, el=30)).save(out / "final_shaded.png")
    print(f"done in {time.time() - t0:.1f}s")


# ---------------------------------------------------------------- Step 5

def step_normals(cfg):
    out = REPO / cfg["paths"]["bake_dir"]
    px = json.loads((out / "grid.json").read_text())["mm_per_px"]
    final = np.load(out / "final.npy").astype(np.float64)
    valid = np.load(out / "valid.npy")
    k = cfg["normals"]["normal_strength"]
    dx = np.gradient(final, px, axis=1)
    drow = np.gradient(final, px, axis=0)
    n = np.stack([-k * dx, k * drow, np.ones_like(final)], -1)   # +Y up: dh/dy_up = -dh/drow
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    n[~valid] = [0, 0, 1]
    np.save(out / "normal.npy", n.astype(np.float16))
    Image.fromarray(sh.encode_normal(n)).save(out / "normal.png")
    tilt = np.degrees(np.arccos(n[valid][:, 2]))
    print(f"normal tilt: median {np.median(tilt):.1f}°, p95 {np.percentile(tilt, 95):.1f}°, "
          f"max {tilt.max():.1f}° (strength {k})")


# ---------------------------------------------------------------- Step 6

def step_albedo(cfg):
    t0 = time.time()
    ab = cfg["albedo"]
    out = REPO / cfg["paths"]["bake_dir"]
    px = json.loads((out / "grid.json").read_text())["mm_per_px"]
    valid = np.load(out / "valid.npy")
    curv = np.load(out / "curvature.npy").astype(np.float64)
    ao = np.load(out / "ao.npy").astype(np.float64)
    carve = np.load(out / "carve.npy").astype(np.float64)
    final = np.load(out / "final.npy").astype(np.float64)
    look = json.loads((out / "look.json").read_text())
    ref = look["reference"] if ab["fit_to"] == "reference" else look
    rng = np.random.default_rng(cfg["seed"] + ab["seed_offset"])
    shape = valid.shape
    slope = look.get("color_scale", {}).get("L", {}).get("psd_slope", ab["psd_slope"])

    # 1. base color: correlated Lab noise with the reference covariance, snapped toward its palette
    mean = np.array(ref["lab_mean"])
    chol = np.linalg.cholesky(np.array(ref["lab_cov"]) + 1e-6 * np.eye(3))
    Z = np.stack([fbm(shape, px, slope, ab["lambda_min_mm"], ab["lambda_max_mm"], rng) for _ in range(3)], -1)
    lab = mean + Z @ chol.T
    pal = np.array([p["lab"] for p in ref["palette"]])
    pw = np.array([p["weight"] for p in ref["palette"]])
    d2 = ((lab[..., None, :] - pal) ** 2).sum(-1)
    wsoft = np.exp(-(d2 - d2.min(-1, keepdims=True)) / (2 * ab["palette_tau"] ** 2)) * pw
    wsoft /= wsoft.sum(-1, keepdims=True)
    lab = (1 - ab["palette_snap"]) * lab + ab["palette_snap"] * (wsoft @ pal)

    # 2. geometry-driven terms
    convex = np.clip(curv, 0, 1)
    cavity = 1 - ao
    lab[..., 0] += ab["edge_L"] * convex
    chroma_scale = 1 + ab["edge_chroma"] * convex * 0.1
    lab[..., 1] *= chroma_scale
    lab[..., 2] *= chroma_scale
    cav_lab = np.stack([-ab["cavity_L"] * cavity, ab["cavity_a"] * cavity, ab["cavity_b"] * cavity], -1)
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    bed = fbm((shape[0], 1024), px, -2.0, *ab["bedding_lambda_mm"], rng)[:, :1]   # 1D along y
    bed = np.broadcast_to(bed, shape)
    lab[..., 0] += ab["bedding_L"] * bed
    lab[..., 0] += ab["carve_dL"] * carve
    lab_base = lab.copy()                              # no cavity, stains or chalk (for the demo's live sliders)
    lab = lab + cav_lab

    # 3. stains (dark grey-violet, vertically elongated) and pale chalky patches
    s_field = fbm(shape, px, -2.5, *ab["stain_lambda_mm"], rng, stretch_y=ab["stain_elong"])
    thr = np.quantile(s_field[valid], 1 - ab["stain_fraction"])
    stain = smoothstep(thr - 0.3, thr + 0.3, s_field) * ab["stain_strength"]
    c_field = fbm(shape, px, -2.5, *ab["chalk_lambda_mm"], rng)
    thr = np.quantile(c_field[valid], 1 - ab["chalk_fraction"])
    chalk = smoothstep(thr - 0.3, thr + 0.3, c_field) * ab["chalk_strength"]
    dark, light = pal[0], pal[-1] + np.array([ab["chalk_dL"], -1.0, -0.5])
    lab = lab * (1 - stain[..., None]) + dark * stain[..., None]
    lab = lab * (1 - chalk[..., None]) + light * chalk[..., None]

    # 4. fit: global mean/std match per Lab channel to the target
    tgt_mean = np.array(ref["lab_mean"])
    tgt_std = np.array(ref["lab_std"]) * ab["fit_std_scale"]
    v = lab[valid]
    before_m, before_s = v.mean(0), v.std(0)
    fit = lambda x: (x - before_m) / before_s * tgt_std + tgt_mean
    lab = fit(lab)
    # separate layers for the interactive demo (same fit transform)
    base_lin = sh.lab_to_linear(fit(lab_base))
    np.save(out / "albedo_base_lin.npy", base_lin.astype(np.float16))
    np.save(out / "stain.npy", (stain / max(ab["stain_strength"], 1e-6)).astype(np.float32))
    np.save(out / "chalk.npy", (chalk / max(ab["chalk_strength"], 1e-6)).astype(np.float32))
    layer_info = {"stain_lin": sh.lab_to_linear(fit(dark)).round(5).tolist(),
                  "chalk_lin": sh.lab_to_linear(fit(light)).round(5).tolist(),
                  "stain_strength": ab["stain_strength"], "chalk_strength": ab["chalk_strength"],
                  "cavity_L_fitted": ab["cavity_L"] * tgt_std[0] / before_s[0]}
    (out / "albedo_layers.json").write_text(json.dumps(layer_info, indent=2))
    after = lab[valid]
    print(f"fit to {ab['fit_to']}: before mean {before_m.round(2)} std {before_s.round(2)}")
    print(f"                 after  mean {after.mean(0).round(2)} std {after.std(0).round(2)} "
          f"(target std = ref std x {ab['fit_std_scale']})")

    albedo_lin = sh.lab_to_linear(lab)
    albedo_lin[~valid] = sh.lab_to_linear(np.array([20.0, 2.0, 1.0]))
    np.save(out / "albedo_lin.npy", albedo_lin.astype(np.float16))
    Image.fromarray(sh.to_u8(sh.linear_to_srgb(albedo_lin))).save(out / "albedo.png")

    # quick check render of the whole wall at the (placeholder) photo preset, no detail texture
    n = np.load(out / "normal.npy").astype(np.float64)
    d = sh.DEFAULT_LIGHTING
    L = sh.light_dir(d["photo_azimuth_deg"], d["photo_elevation_deg"])
    img = sh.linear_to_srgb(sh.shade(n, albedo_lin, np.where(valid, ao, 0), L))
    Image.fromarray(sh.to_u8(img)).save(out / "render_check.png")
    print(f"done in {time.time() - t0:.1f}s")


def main():
    steps = {"align": step_align, "raster": step_raster, "layers": step_layers,
             "normals": step_normals, "albedo": step_albedo}
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=list(steps) + ["all46"])
    args = ap.parse_args()
    cfg = load_config()
    if args.step == "all46":
        for s in ("layers", "normals", "albedo"):
            print(f"== {s}")
            steps[s](cfg)
    else:
        steps[args.step](cfg)


if __name__ == "__main__":
    main()
