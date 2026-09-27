# Wall assets: how the web app uses `public/wall/`

These files are the shared guestbook wall (공유 암각화 벽). They were baked offline from the Bangudae scan by `tools/wall_bake/` (see `WALL_BAKE.md`). The browser never loads the 3D mesh. The wall is a **2.5D lit surface**: normal map + albedo + ambient occlusion, lit by a shader. User carvings are one extra normal layer on top.

A working reference implementation of everything below is the demo: `tools/wall_bake/demo/index.html` (WebGL2, one fragment shader). Copy from it.

## Files

| File | Size | Content |
|---|---|---|
| `metadata.json` | 12 KB | Dimensions, lighting defaults, carving defaults, file list. **Read this first.** |
| `overview_normal.webp` | 79 KB | 1024 × 457 normal map (whole wall, zoomed out) |
| `overview_albedo.webp` | 124 KB | 1024 × 457, RGB = albedo (sRGB), **A = ambient occlusion** |
| `detail_normal.webp` | 77 KB | 512 × 512 **tileable** grain normal map, one tile = 256 mm |
| `full_normal.webp` | 455 KB | 3072 × 1372 normal map (zoomed in) |
| `full_albedo.webp` | 760 KB | 3072 × 1372, RGB = albedo, A = AO |
| `placement_mask.png` | 11 KB | 3072 × 1372, 255 = a user carving may be placed here |

**Load order:** metadata → overview pair + detail (**291 KB**, the first-visit budget is 300 KB) → full pair only when the user zooms in (**1.2 MB**, the budget is 2.5 MB).

## Coordinates

- Wall size: **10,412 × 4,650 mm** (3.389 mm per px). **Provisional:** the real width is a TODO (`align.real_width_m`). Always read the size from `metadata.json`, never hard-code it.
- Positions are **millimetres on the wall plane**: origin at the top-left, x to the right, y down. Store carving placements in mm, never in pixels, so a re-bake at another resolution or scale doesn't break them.
- Texture uv = `mm / [width_mm, height_mm]` (v = 0 at the top). Detail uv = `mm / detail_tile_mm`, with `REPEAT` wrap.
- Alpha 0 in the albedo means outside the wall (draw background). The AO of wall pixels is always > 0.

## Loading textures (important)

- Use `createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })`. Also set `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false` and `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`. Otherwise the AO in alpha damages the RGB, and the browser color-manages the normal maps.
- Normal convention: **OpenGL, +Y up**, `n = rgb * 2 - 1`.
- Albedo is sRGB. Decode it to linear in the shader, light in linear, then encode sRGB at the end.
- Use mipmaps (WebGL2 allows them on non-power-of-two textures). The detail texture is 512², so it works in WebGL1 too.

## Lighting model (the contract)

```glsl
vec3 nBase   = texture(normalTex, uv).xyz * 2.0 - 1.0;
vec3 nDetail = texture(detailTex, uv_mm / detail_tile_mm).xyz * 2.0 - 1.0;
vec3 n = normalize(vec3(nBase.xy + detail_strength * nDetail.xy, nBase.z));   // whiteout blend
n      = normalize(vec3(n.xy + nCarve.xy, n.z));                              // user carving layer
vec4  a = texture(albedoTex, uv);          // a.rgb sRGB albedo, a.a = AO
vec3  albedo = srgbToLinear(a.rgb);
float diffuse = max(dot(n, L), 0.0);
vec3  ambient = mix(ground_color, sky_color, n.y * 0.5 + 0.5) * a.a * ambient_intensity;
vec3  color = albedo * (sun_color * sun_intensity * diffuse + ambient) * exposure;
fragColor = vec4(linearToSrgb(color), 1.0);
```

- Light direction: `L = (sin(az)·cos(el), cos(az)·cos(el), sin(el))`. Azimuth 0 = light from the top of the image, 90 = from the right. The "측광" (raking light) slider just changes `az`/`el`.
- Bake-time defaults (`metadata.lighting.default`, chosen by the user in the demo; the app now overrides the look with `src/look.json`): az **36°**, el **12°**, sun_intensity **2.85**, ambient_intensity **0**, exposure **0.94**, detail_strength **0.32**. Colors: sun (1.0, 0.96, 0.90), sky (0.42, 0.45, 0.52), ground (0.30, 0.26, 0.24).
- ambient_intensity 0 gives a dramatic raking look with black shadows. Raise it (about 0.6–1.0) for a soft daylight "photo" look. The AO only matters when ambient > 0.
- Budget: at most 3 texture fetches + the carving layer. One directional light + hemisphere ambient. No loops, no shadow maps.

## User carvings (the carve layer)

The app builds this at runtime from the user's drawing (a mask), exactly as the demo's `buildCarve()` does:

1. `soft = gaussianBlur(mask, bevel_sigma_mm)` (the demo uses 3 box-blur passes).
2. `height = -depth_mm * soft`, then add **pecks**: random overlapping craters inside the mask. Radius 1–2.5 mm, depth (0.5–1.5) × peck_roughness mm, density 0.15 × roughness per mm² of drawing, seeded RNG.
3. Carve normals in mm units: `n = normalize(-dh/dx, +dh/drow, 1)` (+Y up). Store rg = n.xy*0.5+0.5 and alpha = soft mask; sample it inside the carving's rectangle.
4. **Cast shadow** (blue channel, 0 = lit, 1 = shadow): recomputed on the CPU whenever the light moves (`src/carve/shadow.ts`, a linear-time height-field sweep at 2 mm/px). The shader multiplies the diffuse term by `1 - shadow`. This is what makes a carving read as cut *in*: at el 12° a 12 mm cut throws a ~56 mm shadow across its floor. Without it, the bevel alone reads as a raised plate.
5. Albedo inside the carving: `albedo *= 1 + fresh_stone_lightening * carveAlpha`.

Bake-time defaults (`metadata.carving`): depth **12 mm**, bevel σ **3.8 mm**, peck roughness **0.79**, drawing width **700 mm**, lightening **0.38**. The app's current defaults are in `src/look.json` (picked in the 실험실): depth **6.5 mm**, bevel σ **4.5 mm**, peck roughness **0.18**, lightening **0.66**.

Lessons learned:
- Carvings need **sloped walls** (a bevel of a few mm). Hairline edges vanish when zoomed out.
- Carvings need their **cast shadow** to read as recessed; light from below can still flip them visually (the crater illusion), so animations keep the light above.
- The carve layer should be about 1 mm/px, finer than the 3.4 mm/px wall textures.
- Only place carvings where `placement_mask` = 255: a 150 mm margin from the edges, and it excludes a flat cap shard at the top right.

## Re-baking

See the "Status & handoff" section in `WALL_BAKE.md`. In short: `tools/wall_bake/` scripts → `data/bake/` → `python3 tools/wall_bake/export.py` → `public/wall/`.
