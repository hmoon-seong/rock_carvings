# Wall Bake: Bangudae scan (.ply) to web textures

## Status & handoff (2026-09-27): read this first in a new session

**Done:** Steps 0–7. **Skipped:** Step 8 (the user picked the look in the interactive demo instead). The exported wall is in `public/wall/`. How the web app uses it is in **`WALL_ASSETS.md`**.

**Decisions made by the user**
- The goal is a believable, **carvable** scanned wall. Exact positions of the original Bangudae figures are **not needed**. The drawing emboss is off (`emboss.enabled = false`).
- `original_Page_06.jpg` is the main visual reference, and a perfect photo match is not required.
- Dropped photos: 05, 37, 41 (duplicates) and 38, 39 (harsh sun).
- The final look = the settings the user picked in the demo, saved in `tools/wall_bake/demo/assets/config.json`: az 36°, el 12°, sun 2.85, shade 0, stains 0.24, chalk 0.54, crevice 1.85, bumps 1.43, grain 0.32, carve depth 12 mm, bevel 3.8 mm, pecks 0.79, size 700 mm, lightening 0.38, exposure 0.94. `export.py` bakes these in.

**Findings that shaped the pipeline**
- `wall.ply` is a **closed solid**: the rock face + a flat back + a base + 85 floating hardware parts along the top. The pipeline keeps the largest component and gets orientation from the fine faces only (the carved face points along −PCA). The scanner's z axis = up (the wall comes out level). Coarse cap faces (> 600 units) are culled. Smooth base/cap walls near the edges are trimmed.
- Units are unknown. A **provisional width of 10 m** is used (`align.provisional_width_m`), so 1 unit ≈ 0.2 mm. Grid 3072 × 1372 at 3.389 mm/px.
- The mesh is too coarse (~8 mm edges) to contain the petroglyph figures.
- `ref/2d/drawing` pages are crops of a sharper render of the scan with the figures painted in brown/purple. Each photo/drawing page = **one cell** of the book's grid (`ref/size_reference.png`: about 10 × 6 cells over the carved panel, Page 06 = cell A2). Automatic registration of single pages to our 3.4 mm/px grid failed (`register_drawings.py` kept but unused).
- A carving test (`carve_demo.py`, `data/bake/carve_demo.png`) showed carvings read well when they have **sloped walls** and the wall around them is calm.
- WebP alpha is expensive, so AO uses `alpha_quality` 30 on the overview and 70 on the full-res albedo. Packing AO into the normal's blue channel failed (lossy WebP halves color-channel resolution).

**Open TODOs**
- `align.real_width_m`: the real wall width, to be confirmed by the team. Currently provisional 10 m. Changing it rescales mm consistently: re-run `bake.py align raster all46`, `export_demo.py`, `export.py`.
- `photos.photo_mm_per_px`: the photo scale (assumed 1.0). It only affects the grain tile's physical size (256 mm).
- Optional later: Step 8 calibration; a softer "photo" light preset (ambient ≈ 0.6–1.0) next to the raking default; the emboss of original figures (options under Step 4).
- The web renderer itself (Milestone 5 in `CLAUDE.md`) is not built yet. `demo/index.html` is the reference shader + carve-layer implementation.

**Re-run everything** (from the repo root, about 3 min total; all parameters are in `tools/wall_bake/config.toml`):
```
cd tools/wall_bake
python3 inspect_ply.py            # Step 0 report (read-only)
python3 analyze_photos.py         # Step 1: data/bake/look.json, detail_normal.webp
python3 bake.py align             # Step 2
python3 bake.py raster            # Step 3
python3 bake.py all46             # Steps 4-6 (layers, normals, albedo + separate demo layers)
python3 export_demo.py            # demo textures -> demo/assets/ (config.json there is the user's pick; keep it)
python3 export.py                 # Step 7 -> public/wall/
python3 -m http.server -d demo 8000   # interactive demo at http://localhost:8000
```
Python 3.12 + numpy, scipy, Pillow only. Intermediates go to `data/bake/` (gitignored). The project is **not a git repo** yet.

## Goal

Build a one-time offline Python pipeline that turns the PLY scan of the Bangudae rock face (`ref/3d/wall.ply`, 38.8 MB) into 2D textures for the web app's shared wall.

**Visual target:** make the wall look like the reference photos in `ref/2d/original` without hurting web app performance. The scan provides **geometry only**. All color and fine surface character come from the photos.

- A perfect fit is **not** required. Aim for a convincing likeness, not a metric match.
- **`original_Page_06.jpg` is the main reference.** When photo styles clash (color, lightness, grain), follow Page 06. Its stats are stored separately in `look.json` → `reference`, and Steps 6 and 8 target them first. The pooled stats only describe the natural variation.
- Excluded photos (config `photos.exclude`): near-duplicates 05, 37, 41 and the harsh direct-sun shots 38, 39.
- A separate agent may be used to review visual consistency (render vs. Page 06) at Step 8.

The browser never loads the mesh. The web renderer is 2.5D: a WebGL fragment shader lights a normal map with an adjustable light, and user carvings are blended on top. This task produces the textures, the metadata, and a precise lighting-model definition for that renderer.

Read `CLAUDE.md` first for overall project context (암각화몬).

## Inputs

### Scan: `ref/3d/wall.ply` (geometry only)

Read from the header (verified 2026-09-27):

```
format binary_little_endian 1.0
comment by Geomagic Studio
element vertex 993286        # x, y, z float32 + red, green, blue uchar  (15 B/vertex)
element face 1986346         # list uchar int vertex_indices
```

- File size is exactly header (267 B) + 993,286 × 15 B + 1,986,346 × 13 B. So every face is a triangle and both blocks can be read directly as numpy structured arrays.
- **Vertex colors are ignored.** The rgb bytes are part of the vertex record and get read, but they are thrown away right after loading. Nothing downstream uses them.
- Everything fits in RAM. No chunking is needed.
- **The mesh is coarse.** About 1M vertices over a panel several meters wide suggests roughly 3 to 6 mm vertex spacing (Step 0 measures it). The mesh gives the large and medium forms: bedding layers, fracture ledges, cracks, and figure grooves if they are resolvable. It does **not** give the mm-scale grain that dominates the photos. That grain comes from the photos (Step 5).
- F ≈ 2V − 226, so the mesh is either open with a short boundary or nearly closed. Step 0 settles it.

### Photos: `ref/2d/original/*.jpg` (the look)

- 42 close-up photos (about 600–790 px, scanned book pages) of sections of the panel in soft daylight. The observed look:
  - Mauve / pinkish-grey stone. Hue varies from rosy brown to cool violet-grey.
  - A fine granular, pecked texture over the whole surface, at mm scale.
  - Horizontal bedding layers and diagonal cracks. Fracture ledges catch light as **bright pale edges**, with soft shadows under them.
  - Shadows are soft and never black. There is a strong ambient/sky fill.
  - Low-frequency **dark stains** (grey-violet) and **pale chalky patches**.
- Some photos include soil, vegetation, or deep shadow at the edges. The analysis must exclude those pixels.
- Their physical scale is unknown. Config `photo_mm_per_px` (TODO: estimate it by eye from a known feature, e.g. figure size vs. the motif chart). Default is 1.0.

### Drawings: `ref/2d/drawing/*.jpg`

- 42 pages that appear to pair 1:1 with the photos (tracings of the same sections). They are used only by the optional fallback in Step 4.

## Constraints

- Python 3.11+. Dependencies: `numpy`, `scipy`, `Pillow` (all present). Nothing else unless you explain why. Parse the PLY header yourself and read the body with structured dtypes.
- All parameters live in `tools/wall_bake/config.toml` (read with stdlib `tomllib`).
- Deterministic and re-runnable. Every random step uses a fixed seed from the config.
- Keep `ref/3d/wall.ply` out of git (or use Git LFS). Add `data/` and `*.npy` to `.gitignore`.
- **Web performance budget:**
  - First visit (overview + detail textures): **≤ 300 KB total**.
  - Full-res wall: **≤ 2.5 MB total**, long side ≤ 4096 px per image.
  - Shader: at most **3 texture fetches** per pixel (base normal, albedo+AO, tiled detail) plus the user-carving layer. One directional light plus a hemisphere ambient term. No loops, no shadow maps.
  - The base textures are only as sharp as the mesh (`mm_per_px ≈ edge_len / 2`). Photo-like sharpness when zoomed in comes from the small **tiled detail texture**, not from bigger base textures. This is the key trick that keeps downloads small.

## File structure

```
tools/wall_bake/
  config.toml
  ply.py             # header parser + structured-dtype reader (shared)
  inspect_ply.py     # Step 0
  analyze_photos.py  # Step 1, photo statistics -> data/bake/look.json + detail texture
  bake.py            # Steps 2 to 6, writes intermediates to data/bake/
  shading.py         # the lighting model in numpy, used by preview/calibrate (mirrors the GLSL)
  export.py          # Step 7, writes to public/wall/
  preview.py         # Step 8, relit previews + side-by-side with photos
  carve_demo.py      # offline carving feasibility check (data/bake/carve_demo.png)
  export_demo.py     # textures for the interactive demo -> demo/assets/ (generated, gitignored)
  demo/index.html    # interactive WebGL carving demo: place Page 06's drawing, live sliders
```

**Interactive demo:** `python3 tools/wall_bake/export_demo.py`, then `python3 -m http.server -d tools/wall_bake/demo 8000` and open http://localhost:8000.
- Controls: light direction, elevation, sun and shade strength; stains, chalk, crevice shading, surface bumps, grain; carve depth, bevel, pecks, size, lightening.
- Click to place the carving. "설정 복사" copies the chosen values for Step 8.
- Step 6 now also saves `albedo_base_lin.npy`, `stain.npy`, `chalk.npy` and `albedo_layers.json`, so the demo can vary stains and crevice shading live.

## Step 0: Inspect scan (STOP and report after this)

`inspect_ply.py` prints:

- Header, format, element counts, property types (asserted, so a replaced file fails loudly).
- Face check: every count byte == 3, indices within `[0, V)`, number of degenerate faces.
- Topology: boundary edges (edges used by one face) grouped into loops. Is the mesh closed, open, or open with holes?
- Bounding box and extents over all vertices.
- PCA on all vertices: eigenvalues and the ratio of smallest to middle.
- Edge length stats from faces (median, p5, p95), plus KD-tree NN distance on a patch for comparison.
- Face normal histogram against the PCA normal: fraction facing +n, facing −n, and side-on.

Report these and suggest `mm_per_px` of about `median_edge_len / 2`.

## Step 1: Analyze the photos (`analyze_photos.py`) (STOP and report after this)

Extract the "look" from the photos into `data/bake/look.json` and a detail texture. All later steps use only these outputs, never the photos directly.

1. **Pixel mask per photo:** exclude near-black shadow (L < `shadow_L`), blown highlights, and non-rock hues (green vegetation, orange soil) with simple Lab thresholds. Save a mask preview contact sheet so I can check it.
2. **Approximate de-lighting:** in each photo, split luminance into a large-sigma lighting estimate and the remainder, then work on `L / blur(L)`. This is only approximate, but it keeps shading from being baked into the albedo stats.
3. **Color statistics** (Lab, pooled over all photos, masked):
   - Mean and covariance of (L, a, b). This defines the base stone color and its natural spread.
   - A small palette: 4 to 6 colors from k-means (numpy, fixed seed, a few iterations), with their weights. This covers base mauve, cool grey-violet, dark stain, and pale chalky patches.
   - The spatial scale of color variation: radial power spectrum of the a/b channels after low-pass. This tells how big the stains and patches are (in photo px, converted via `photo_mm_per_px`).
4. **Grain spectrum:** radial power spectrum of the high-pass de-lit luminance. This measures the mm-scale granular texture.
5. **Detail texture:** synthesize a **seamlessly tileable** 512×512 height field by FFT spectral synthesis. Use random phase (fixed seed) and an amplitude that follows the measured grain spectrum. FFT noise is periodic, so it tiles with no seams.
   - Export it as a small normal map `detail_normal.webp`, about 50–100 KB, and record its physical size (`detail_tile_mm`) in metadata.
   - Add a sparse layer of small pits (pecked-dot look), also periodic. `pit_density` and `pit_depth` go in config.
   - Its amplitude is tuned in Step 8, not guessed here.
6. Save `data/bake/look_report.png`: the palette swatches, the spectra, a tiled detail patch under the default light, and a few photo crops beside it.

## Step 2: Load and align

- `ply.py` structured dtypes:
  - vertex: `[('x','<f4'),('y','<f4'),('z','<f4'),('r','u1'),('g','u1'),('b','u1')]`, then keep `xyz` only.
  - face: `[('n','u1'),('i','<i4',3)]`
- **Keep only the largest connected component.** Step 0 found the mesh is a closed solid with 85 small extra components: man-made hardware (cylinders/brackets) floating along the top edge, up to 17k units in front of the rock.
- **Fine faces only for orientation.** The solid's flat back is ~68k large triangles holding 62% of the area, which skews area-weighted stats. Select fine faces (longest edge < `fine_edge_max`, default ~150 units) and run area-weighted PCA on their centroids. The smallest-variance axis is the wall normal (ratio 0.157 vs 0.226 on all vertices). Rotate so it points to +z. The sign is chosen so the fine faces' area-weighted mean normal points to +z (Step 0: the carved face faces −PCA), and config `flip_normal` overrides it.
- In-plane rotation: align the scan's original up axis to image up. Config `roll_degrees` for manual correction.
- Scale: config `real_width_m` (TODO: real width of the panel to be confirmed by the team). Convert to millimeters. If it is unset, keep native units and warn.
- Save `data/bake/align_preview_front.png` and `align_preview_back.png` (grey-shaded height, both normal signs). STOP for approval.

## Step 3: Rasterize the mesh

- **Cull back faces:** drop triangles with aligned `n_z <= cos(max_facing_deg)` (e.g. 80°). This removes the back side, base, and most side walls.
- Grid from `mm_per_px`. Expect about 2k to 5k px on the long side.
- Rasterize triangles into a z-buffer (keep max z) with barycentric interpolation of z. Either a numpy bbox rasterizer or barycentric supersampling + `np.maximum.reduceat`, whichever is simpler.
- Validity mask = covered pixels. Fill small holes (< `max_hole_px`) with the nearest valid value plus a light blur. Erode by `edge_crop_mm`.
- Save `height.npy` (float32, mm), `valid.npy`, and a 16-bit PNG preview.

## Step 4: Geometry layers

- `low` = normalized gaussian blur of height, with sigma `large_sigma_mm / mm_per_px` (blur of height\*mask divided by blur of mask).
- `detail = height - low`, then `final = detail + low_weight * low` (`low_weight` about 0.1).
- **Curvature** (Laplacian of `final` at 2 or 3 scales) and **ambient occlusion**: cheap multi-scale "height minus blurred height" cavity. Optionally use a horizon-based AO with 8 directions, which is fine offline. These drive both the albedo (Step 6) and the AO channel.
- **Figures are not in the mesh** (checked at Step 2: close-ups at 10 units/px show bedding, cracks and ledges, but no figures). The fallback is to emboss figure masks from `ref/2d/drawing`.
  - Finding (2026-09-27): the drawing pages do **not** pair with the photos. Each page is a crop of a much sharper shaded render of the scan, with figures painted in brown and purple (a second group). The pages don't overlap each other.
  - `register_drawings.py` (masked NCC over scale/rotation/translation, and outline matching) did **not** register single pages reliably: the best fits sat on search-range edges or on wrong places. The pages appear to be at about 0.3–1 mm/px, far sharper than the 3.4 mm/px grid.
  - **Status: emboss skipped for now** (`emboss.enabled = false`). The code path in Step 4 stays and uses `carve_brown.npy` / `carve_purple.npy` when they exist.
  - **Decision (2026-09-27): exact positions of the original carvings are not needed.** The scanned wall structure is the starting surface; what matters is that user drawings can be carved into it.
  - `ref/size_reference.png` is the book's key. The carved panel is divided into a grid of about 10 × 6 cells (columns 1–10, rows A–G), and each photo/drawing page is **one cell**. So photos and drawings *do* pair, by cell (Page 06 = A2). The book's model is a smaller crop (the main panel, with a notch at the bottom) than our scan (the whole cliff). Cell size is provisional at 800 mm (`carve_demo.cell_mm`).
  - **Carving feasibility check:** `carve_demo.py` carves a page's figures (as a stand-in user drawing) into the wall the way the app will: a pecked carve height layer at 1 mm/px turned into `nCarve` and lit with the contract. Result: `data/bake/carve_demo.png`. Findings:
    - It works with no extra texture fetch beyond the planned carve layer.
    - Carvings need **beveled walls** (depth ~5–8 mm, gaussian edge σ ~3–5 mm). Hairline edges vanish at overview zoom.
    - The wall must stay **calm** around the carving: lower albedo stain contrast and AO, base normals scaled ~0.5, detail strength ~0.35–0.4. These go into Step 8's tuning, with carving legibility as an explicit criterion.
  - Options for later: rough per-page location hints plus local refinement; exact 2-point manual anchors per page; a book overview figure showing where each page sits; or procedural placement (not the real layout).

## Step 5: Normal map (base)

- Central differences of `final` in mm, times `normal_strength`. `n = normalize(-dh/dx, -dh/dy, 1)`, encoded `rgb = n * 0.5 + 0.5`. OpenGL convention (+Y up), recorded in metadata.
- Base normals carry mesh geometry only. The fine grain is **not** baked in. The shader adds it from the tiled `detail_normal` (Step 1), so base textures stay small and the grain stays sharp at any zoom.

## Step 6: Albedo (procedural, driven by photo statistics + geometry)

Generate it with no vertex colors. Everything is deterministic from `look.json`, the geometry layers, and a fixed seed:

1. **Base color field:** low-frequency noise at the measured stain/patch scale. It picks colors from the k-means palette by their measured weights, blended smoothly (not hard regions). Use the Lab covariance to add small per-region variation.
2. **Geometry-driven terms** (these produce the photo look):
   - Convex edges and ledges (positive curvature) get lighter and paler. This gives the bright broken-edge look.
   - Cavities and cracks (negative curvature, low AO) get slightly darker and warmer.
   - Bedding: a subtle horizontal banding from `low`-height layers, if the mesh shows them.
   - Every weight is in config.
3. **Stains / chalky patches:** sparse low-frequency masks. Dark grey-violet stains run slightly down-slope (vertical elongation). Pale patches have soft edges.
4. **Fit to the photos:** after generating, do a global mean/std match per Lab channel so the albedo matches the photos' de-lit statistics. Print the before/after stats.
- Save `albedo.png`, `ao.png`, `curvature.png`.

## Step 7: Export (`export.py`)

```
public/wall/
  metadata.json
  overview_normal.webp     # long side ~1024 px, ≤ ~100 KB
  overview_albedo.webp     # long side ~1024 px, RGB = albedo, A = AO, ≤ ~100 KB
  detail_normal.webp       # 512×512 tileable, ≤ ~100 KB
  full_normal.webp         # full res (or 2×1 / 2×2 grid if > 4096 px)
  full_albedo.webp         # RGB = albedo, A = AO
  placement_mask.png
```

- AO goes in the albedo alpha, so it adds no extra request or texture fetch.
- Pixels outside the valid area get alpha AO = 0 and a dark albedo. `placement_mask.png` defines where user carvings may go.
- The albedo is low-frequency by construction, so it can be exported at **half** the normal-map resolution if that fits the budget better. The shader samples it with linear filtering. Report sizes both ways.
- Downsample normals by averaging vectors and renormalizing.
- Formats: albedo WebP q80. Normals WebP q90, then check for blocky artifacts under raking light. If they show, use lossless and report the size.
- `metadata.json`: `width_px`, `height_px`, `mm_per_px`, `width_mm`, `height_mm`, `images` (files + pixel rects + resolution), `detail_tile_mm`, `normal_convention`, `height_scale_mm`, `lighting` (the model below and its default parameters), `source_sha256` (ply + photos), `config`, `generated_at`.

## Lighting model contract (shared with the web renderer)

`shading.py` implements exactly this, and the GLSL must match it:

```
nBase   = decode(full_normal)
nDetail = decode(detail_normal sampled at uv_mm / detail_tile_mm)
n       = normalize(vec3(nBase.xy + detail_strength * nDetail.xy, nBase.z))   // whiteout blend
n       = normalize(vec3(n.xy + nCarve.xy, n.z))                              // user carvings, same blend
diffuse = max(dot(n, L), 0)
ambient = mix(ground_color, sky_color, n.y * 0.5 + 0.5) * ao * ambient_intensity
color   = albedo * (sun_color * sun_intensity * diffuse + ambient) * exposure
```

- Added at Step 7 (2026-09-27): `sun_intensity`, `ambient_intensity` and `exposure`, so the demo's sliders map 1:1 to the app. Their defaults come from the look picked in the demo (`demo/assets/config.json` → `metadata.json` → `lighting.default`).
- The demo's rock sliders (bumps, stains, chalk, crevice) are baked into the exported textures. Grain stays a runtime `detail_strength`.

- Defaults: `sun_color`, `sky_color`, `ground_color`, `detail_strength`, and a **"photo" preset** light (direction and elevation roughly matching the photos: from above, moderate elevation) are all fitted in Step 8. The app's raking-light slider just changes `L`.
- Everything happens in linear space, with an sRGB encode at the end. Record this in metadata.

**Status (2026-09-27): Step 7 done.**
- Sizes: first visit 291 KB (≤ 300 KB), full-res wall 1.2 MB (≤ 2.5 MB).
- AO in the albedo alpha is expensive in WebP. It uses `alpha_quality` 30 for the overview and 70 for full res; mean AO error is 5/255 and 2/255.
- Packing AO into the normal map's blue channel was tried and rejected: lossy WebP halves the resolution of the color channels.
- Normals are WebP q90: diffuse error mean 0.009 under the default raking light, with no visible blocks (`data/bake/normal_compression_check.png`).
- The placement mask keeps a 150 mm margin from the edges and excludes the top-right cap shard.
- Upload RGBA images with `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'`.

## Step 8: Calibrate and verify (`preview.py`) — skipped for now (user decision 2026-09-27; the look was picked in the demo)

All renders come from the **exported files** (not intermediates), through `shading.py`.

1. **Look-match calibration** at the "photo" preset light. Crop wall regions at the photos' scale and compare them with the photos on:
   - Lab mean/std of the rendered color.
   - The high-pass luminance power spectrum (grain).
   - Shadow depth: the p5 luminance, where shadows should not be black.
   
   Fit a small set of parameters (`detail_strength`, `normal_strength`, ambient level/colors, albedo contrast) with a coarse grid search. Print the metric table and save the best 2 or 3 candidates **side by side with photo crops** in `data/bake/lookmatch_*.png` for me to pick.
2. **Raking-light previews:** elevation 15°, azimuths 0/90/180/270, saved as `data/bake/preview_*.png`.
3. Checks to report:
   - Known figures (whales, deer, human figures) visible under raking light.
   - How close the photo preset render is to the photos, by the metrics plus my eye.
   - No visible tiling repetition of the detail texture at typical zoom. If it shows, add a second detail sample at a rotated, non-integer scale. That is one more fetch, so report the cost.
   - No seams if the full texture is split into a grid.
   - Physical size in meters.
   - Output sizes against the budget, and runtime.

## Coordinate contract with the web app

- User carving placements are stored in **millimeters** on the wall plane (origin top-left), not pixels. Re-baking at a different resolution never breaks existing placements.
- The detail texture is also addressed in mm (`uv_mm / detail_tile_mm`), so grain scale stays physically consistent at every zoom level.

## Out of scope

The web renderer itself, converting user drawings into carvings, storage, and moderation. Projecting the photos onto the scan is also out of scope: we have no registration, and the photos contain baked lighting. We only borrow their statistics.

## Working style

- Stop after Step 0, after Step 1, and after Step 2 for my approval.
- When a parameter choice is uncertain (sigma, normal strength, detail strength, palette weights), render two or three candidates side by side with photo crops and let me pick.
- Explain any dependency you add.
