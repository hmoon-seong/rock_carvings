"""Step 7: export web textures + metadata to public/wall/.

Bakes the look chosen in the interactive demo (tools/wall_bake/demo/assets/config.json):
surface bumps, stains, chalk and crevice shading go into the textures; light, grain and carving
settings go into metadata.json as runtime defaults.
"""
from __future__ import annotations

import hashlib
import json
import time

import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, label

import shading as sh
from ply import REPO, load_config


def downsample_normals(n, f):
    H, W = (np.array(n.shape[:2]) // f) * f
    m = n[:H, :W].reshape(H // f, f, W // f, f, 3).mean((1, 3))
    return m / np.linalg.norm(m, axis=-1, keepdims=True)


def downsample(x, f):
    H, W = (np.array(x.shape[:2]) // f) * f
    return x[:H, :W].reshape(H // f, f, W // f, f, *x.shape[2:]).mean((1, 3))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def save_webp(arr, path, **kw):
    Image.fromarray(arr).save(path, "WEBP", method=6, **kw)
    return path.stat().st_size


def main():
    t0 = time.time()
    cfg = load_config()
    ec = cfg["export"]
    bake = REPO / cfg["paths"]["bake_dir"]
    pub = REPO / cfg["paths"]["public_dir"]
    pub.mkdir(parents=True, exist_ok=True)
    demo_cfg_path = REPO / ec["look_config"]
    look_cfg = json.loads(demo_cfg_path.read_text())
    grid = json.loads((bake / "grid.json").read_text())
    look = json.loads((bake / "look.json").read_text())
    layers = json.loads((bake / "albedo_layers.json").read_text())
    valid = np.load(bake / "valid.npy")
    H, W = valid.shape
    px = grid["mm_per_px"]

    # --- normals: surface bumps baked in (xy scale), same as the demo's uBumps
    n = np.load(bake / "normal.npy").astype(np.float64)
    n[..., :2] *= look_cfg["bumps"]
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    n[~valid] = [0, 0, 1]

    # --- albedo + AO: the demo's shader math, evaluated once
    base = np.load(bake / "albedo_base_lin.npy").astype(np.float64)
    ao = np.load(bake / "ao.npy").astype(np.float64)
    stain = np.load(bake / "stain.npy")[..., None]
    chalk = np.load(bake / "chalk.npy")[..., None]
    alb = base + (np.array(layers["stain_lin"]) - base) * np.clip(look_cfg["stains"] * stain, 0, 1)
    alb = alb + (np.array(layers["chalk_lin"]) - alb) * np.clip(look_cfg["chalk"] * chalk, 0, 1)
    cav = 1 - ao
    alb *= np.maximum(1 - look_cfg["crevice"] * layers["cavity_L_fitted"] * cav / 76.0, 0.05)[..., None] ** 3
    ao_out = np.maximum(ao, 1e-3) ** look_cfg["crevice"]
    alb[~valid] = sh.lab_to_linear(np.array([20.0, 2.0, 1.0]))
    ao_out[~valid] = 0.0
    print(f"ao^{look_cfg['crevice']}: valid min {ao_out[valid].min():.3f} (alpha 0 = outside the wall)")

    def rgba(albedo_lin, a):
        return np.concatenate([sh.to_u8(sh.linear_to_srgb(albedo_lin)), (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)[..., None]], -1)

    sizes = {}
    # --- full res
    sizes["full_normal.webp"] = save_webp(sh.encode_normal(n), pub / "full_normal.webp", quality=ec["normal_quality"])
    sizes["full_albedo.webp"] = save_webp(rgba(alb, ao_out), pub / "full_albedo.webp", quality=ec["albedo_quality"],
                                          alpha_quality=ec["full_ao_quality"])
    # --- overview (long side ~1024), vector-averaged normals
    f = max(1, round(W / ec["overview_long_side"]))
    sizes["overview_normal.webp"] = save_webp(sh.encode_normal(downsample_normals(n, f)), pub / "overview_normal.webp",
                                              quality=ec["overview_normal_quality"])
    alb_o, ao_o = downsample(alb, f), downsample(ao_out, f)
    ao_o[downsample(valid.astype(float), f) < 0.999] = 0.0
    sizes["overview_albedo.webp"] = save_webp(rgba(alb_o, ao_o), pub / "overview_albedo.webp",
                                              quality=ec["albedo_quality"], alpha_quality=ec["overview_ao_quality"])
    # --- detail tile (unchanged)
    Image.open(bake / "detail_normal.webp").save(pub / "detail_normal.webp", "WEBP", quality=90, method=6)
    sizes["detail_normal.webp"] = (pub / "detail_normal.webp").stat().st_size
    # --- placement mask: valid, pulled in from the edges (drops the top-right cap shard), largest piece
    margin = int(round(ec["placement_margin_mm"] / px))
    place = binary_erosion(valid, iterations=margin)
    lab_, _ = label(place)
    place = lab_ == np.argmax(np.bincount(lab_.ravel())[1:]) + 1
    Image.fromarray((place * 255).astype(np.uint8)).save(pub / "placement_mask.png", optimize=True)
    sizes["placement_mask.png"] = (pub / "placement_mask.png").stat().st_size

    # --- alternatives, reported only: half-res albedo, lossless normals
    alt = REPO / cfg["paths"]["bake_dir"] / "export_alt"
    alt.mkdir(exist_ok=True)
    alt_half = save_webp(rgba(downsample(alb, 2), downsample(ao_out, 2)), alt / "full_albedo_half.webp",
                         quality=ec["albedo_quality"], alpha_quality=ec["full_ao_quality"])
    # AO precision after compression (alpha channel), and wall/outside separation
    for name in ("full_albedo.webp", "overview_albedo.webp"):
        dec_a = np.asarray(Image.open(pub / name))[..., 3].astype(int)
        src_a = (np.clip(ao_out if name.startswith("full") else ao_o, 0, 1) * 255 + 0.5).astype(int)
        inside = src_a > 0
        print(f"{name}: AO mean abs error {np.abs(dec_a - src_a)[inside].mean():.2f}/255, "
              f"wall px read as outside {((dec_a == 0) & inside).sum()}, outside read as wall {((dec_a > 0) & ~inside).sum()}")
    alt_lossless = save_webp(sh.encode_normal(n), alt / "full_normal_lossless.webp", lossless=True)

    # --- normal compression check under the default raking light
    dec = sh.decode_normal(np.asarray(Image.open(pub / "full_normal.webp").convert("RGB")))
    ref = sh.decode_normal(sh.encode_normal(n))
    L = sh.light_dir(look_cfg["azimuth"], look_cfg["elevation"])
    d_lossy = np.clip(dec @ L, 0, 1)[valid]
    d_ref = np.clip(ref @ L, 0, 1)[valid]
    err = np.abs(d_lossy - d_ref)
    ys, xs = np.nonzero(valid)
    cy, cx = int(np.median(ys)), int(np.median(xs))
    crop = (slice(cy - 200, cy + 200), slice(cx - 300, cx + 300))
    shade_ref = np.clip(ref[crop] @ L, 0, 1)
    shade_dec = np.clip(dec[crop] @ L, 0, 1)
    Image.fromarray(sh.to_u8(np.concatenate([shade_ref, shade_dec, 0.5 + 4 * (shade_dec - shade_ref)], 1))).save(
        bake / "normal_compression_check.png")

    # --- metadata
    wall_mm = [W * px, H * px]
    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "width_px": W, "height_px": H, "mm_per_px": px,
        "width_mm": round(wall_mm[0], 1), "height_mm": round(wall_mm[1], 1),
        "scale_is_provisional": cfg["align"]["real_width_m"] <= 0,
        "coordinates": "mm on the wall plane, origin top-left, x right, y down; texture uv = mm / [width_mm, height_mm]",
        "images": {
            "full_normal": {"file": "full_normal.webp", "px": [W, H], "rect_mm": [0, 0, *wall_mm]},
            "full_albedo": {"file": "full_albedo.webp", "px": [W, H], "rect_mm": [0, 0, *wall_mm],
                            "channels": "RGB = albedo (sRGB), A = ambient occlusion (0 = outside the wall)"},
            "overview_normal": {"file": "overview_normal.webp", "px": [W // f, H // f], "rect_mm": [0, 0, W // f * f * px, H // f * f * px]},
            "overview_albedo": {"file": "overview_albedo.webp", "px": [W // f, H // f], "rect_mm": [0, 0, W // f * f * px, H // f * f * px],
                                "channels": "RGB = albedo (sRGB), A = ambient occlusion"},
            "detail_normal": {"file": "detail_normal.webp", "px": [512, 512], "tile_mm": look["detail"]["tile_mm"],
                              "wrap": "repeat"},
            "placement_mask": {"file": "placement_mask.png", "px": [W, H], "meaning": "255 = user carvings may be placed"},
        },
        "upload_notes": "Upload RGBA images with premultiplyAlpha: 'none' and colorSpaceConversion: 'none' "
                        "(createImageBitmap options), or AO in alpha corrupts RGB and normals get color-managed.",
        "detail_tile_mm": look["detail"]["tile_mm"],
        "normal_convention": "OpenGL, +Y up, rgb = n * 0.5 + 0.5",
        "normal_strength_baked": look_cfg["bumps"],
        "lighting": {
            "model": [
                "nBase = decode(full_normal); nDetail = decode(detail_normal at uv_mm / detail_tile_mm)",
                "n = normalize(vec3(nBase.xy + detail_strength * nDetail.xy, nBase.z))",
                "n = normalize(vec3(n.xy + nCarve.xy, n.z))   // user carving layer",
                "diffuse = max(dot(n, L), 0)",
                "ambient = mix(ground_color, sky_color, n.y * 0.5 + 0.5) * ao * ambient_intensity",
                "color = albedo * (sun_color * sun_intensity * diffuse + ambient) * exposure",
                "all linear; decode sRGB albedo, encode sRGB at the end",
            ],
            "light_dir": "L = (sin(az) cos(el), cos(az) cos(el), sin(el)); az 0 = from image top, 90 = from the right",
            "default": {"azimuth_deg": look_cfg["azimuth"], "elevation_deg": look_cfg["elevation"],
                        "sun_intensity": look_cfg["sun"], "ambient_intensity": look_cfg["shade"],
                        "exposure": look_cfg["exposure"], "detail_strength": look_cfg["grain"]},
            "sun_color": sh.DEFAULT_LIGHTING["sun_color"], "sky_color": sh.DEFAULT_LIGHTING["sky_color"],
            "ground_color": sh.DEFAULT_LIGHTING["ground_color"],
            "space": "linear",
        },
        "carving": {
            "note": "defaults for the app's carve tool, chosen in the demo; the carve layer is built at runtime",
            "depth_mm": look_cfg["depth"], "bevel_sigma_mm": look_cfg["bevel"], "peck_roughness": look_cfg["pecks"],
            "drawing_width_mm": look_cfg["size"], "fresh_stone_lightening": look_cfg["carveLight"],
            "demo_center_mm": look_cfg.get("carve_center_mm"),
            "peck_model": "craters r 1-2.5 mm, depth (0.5-1.5) * peck_roughness mm, 0.15 * roughness per mm^2 of drawing",
        },
        "source_sha256": {
            "ply": sha256(REPO / cfg["paths"]["ply"]),
            "photos": {p.name: sha256(p) for p in sorted((REPO / cfg["paths"]["photos"]).glob("*.jpg"))},
            "look_config": sha256(demo_cfg_path),
        },
        "config": cfg,
    }
    (pub / "metadata.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    sizes["metadata.json"] = (pub / "metadata.json").stat().st_size

    # --- report
    first = sizes["overview_normal.webp"] + sizes["overview_albedo.webp"] + sizes["detail_normal.webp"] + sizes["metadata.json"]
    full = sizes["full_normal.webp"] + sizes["full_albedo.webp"]
    print(f"overview factor {f} -> {W // f} x {H // f}")
    for k, v in sizes.items():
        print(f"  {k:22s} {v / 1024:8.1f} KB")
    print(f"first visit (overview x2 + detail + metadata): {first / 1024:.0f} KB  (budget 300 KB) "
          f"{'OK' if first <= 300 * 1024 else 'OVER'}")
    print(f"full-res wall (full normal + albedo): {full / 1024:.0f} KB  (budget 2560 KB) "
          f"{'OK' if full <= 2560 * 1024 else 'OVER'}")
    print(f"alternatives: albedo at half res {alt_half / 1024:.0f} KB (vs {sizes['full_albedo.webp'] / 1024:.0f}); "
          f"lossless normals {alt_lossless / 1024:.0f} KB (vs {sizes['full_normal.webp'] / 1024:.0f})")
    print(f"normal WebP q{ec['normal_quality']} under default light: diffuse error mean {err.mean():.4f}, "
          f"p99 {np.percentile(err, 99):.4f}, max {err.max():.3f}")
    print(f"placement area {place.mean():.1%} of grid (margin {ec['placement_margin_mm']} mm); done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
