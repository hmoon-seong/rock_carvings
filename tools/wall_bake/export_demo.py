"""Write textures + metadata for the interactive carving demo (tools/wall_bake/demo/).

  python3 export_demo.py
  python3 -m http.server -d tools/wall_bake/demo 8000     # then open http://localhost:8000
"""
from __future__ import annotations

import json
import shutil

import numpy as np
from PIL import Image

import shading as sh
from ply import REPO, load_config


def main():
    cfg = load_config()
    out = REPO / cfg["paths"]["bake_dir"]
    demo = REPO / "tools/wall_bake/demo/assets"
    demo.mkdir(parents=True, exist_ok=True)
    grid = json.loads((out / "grid.json").read_text())
    look = json.loads((out / "look.json").read_text())
    layers = json.loads((out / "albedo_layers.json").read_text())
    valid = np.load(out / "valid.npy")

    n = np.load(out / "normal.npy").astype(np.float64)
    Image.fromarray(sh.encode_normal(n)).save(demo / "normal.webp", "WEBP", quality=92, method=6)
    base = np.load(out / "albedo_base_lin.npy").astype(np.float64)
    Image.fromarray(sh.to_u8(sh.linear_to_srgb(base))).save(demo / "albedo.webp", "WEBP", quality=88, method=6)
    ao = np.load(out / "ao.npy")
    stain = np.load(out / "stain.npy")
    chalk = np.load(out / "chalk.npy")
    rgba = np.stack([ao, np.clip(stain, 0, 1), np.clip(chalk, 0, 1), valid.astype(np.float32)], -1)
    Image.fromarray((rgba * 255 + 0.5).astype(np.uint8)).save(demo / "layers.webp", "WEBP", lossless=True, method=6)
    shutil.copy(out / "detail_normal.webp", demo / "detail.webp")
    shutil.copy(REPO / cfg["paths"]["drawings"] / f"drawings_Page_{cfg['carve_demo']['page']:02d}.jpg", demo / "drawing.jpg")

    cc = cfg["carve_demo"]
    d = sh.DEFAULT_LIGHTING
    meta = {
        "wall_px": [grid["width_px"], grid["height_px"]],
        "mm_per_px": grid["mm_per_px"],
        "wall_mm": [grid["width_px"] * grid["mm_per_px"], grid["height_px"] * grid["mm_per_px"]],
        "units_note": grid["units"],
        "detail_tile_mm": look["detail"]["tile_mm"],
        "stain_lin": layers["stain_lin"], "chalk_lin": layers["chalk_lin"],
        "cavity_L": layers["cavity_L_fitted"],
        "sun_color": d["sun_color"], "sky_color": d["sky_color"], "ground_color": d["ground_color"],
        "carve_center_uv": [cc["center_grid_px"][0] / grid["width_px"], cc["center_grid_px"][1] / grid["height_px"]],
        "carve_size_mm": cc["cell_mm"],
        "figure_chroma": cfg["register"]["figure_chroma"],
        "defaults": {"azimuth": 315, "elevation": 45, "sun": 1.0, "shade": 1.0,
                     "stains": 0.6, "chalk": 0.5, "crevice": 1.0, "bumps": 1.0, "grain": 0.5,
                     "depth": 5.0, "bevel": 3.0, "pecks": 0.6, "size": cc["cell_mm"], "carveLight": 0.08},
    }
    (demo / "meta.json").write_text(json.dumps(meta, indent=2))
    for f in sorted(demo.iterdir()):
        print(f"{f.name:14s} {f.stat().st_size / 1024:8.0f} KB")


if __name__ == "__main__":
    main()
