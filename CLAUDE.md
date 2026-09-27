# 암각화몬 (Amgakhwamon): Petroglyph Carving Web App

## What we are building

A mobile-first web app for visitors to the Bangudae Petroglyphs (반구대 암각화, Ulsan, Korea). A visitor makes a **simple drawing with a few flat colors**. The app **converts it into a petroglyph carving** and carves it into the real Bangudae rock wall (baked from a 3D scan), lit by a raking light. Visitors can play a timed drawing challenge and leave their carving on the shared digital rock wall as a guestbook.

This is a student team prototype for a local program. Favor simple, robust solutions over ambitious ones.

**Change of plan (2026-09-27):** we no longer build physical carving tools (peck / incise / weather on a procedural heightmap). The user draws. Carving is an automatic conversion step: drawing → carve layer → lit on the scanned wall.

## Hard constraints

- Web only. No native app, no install. Must work well in mobile Safari and Chrome on Android.
- Touch is the primary input. Mouse must also work.
- UI text in Korean.
- Never expose API keys in client code. All AI calls go through a small server-side proxy.
- Keep the first load light. Visitors are on mobile data at an outdoor site. The wall's first visit is 291 KB (budget 300 KB); the full-res wall (1.2 MB) loads only on zoom.

## Core flow

1. **Draw (그리기):** a simple drawing canvas. A small palette of a few flat colors, brush size, eraser, undo, clear. The look to aim for is the reference drawings in `ref/2d/drawing`: flat silhouettes and thick lines, like the Bangudae motif tracings.
2. **Carve (새기기):** convert the drawing into a carving and show it on the rock wall under raking light (측광). Let the user rotate the light. This conversion is the key visual moment.
3. **Leave it on the wall / share / score**, depending on the mode.

### Drawing → carving conversion

The algorithm is already prototyped and verified. See `WALL_ASSETS.md` → "User carvings" and `buildCarve()` in `tools/wall_bake/demo/index.html`.

- Drawing pixels become a mask. A soft bevel (gaussian, σ ≈ 3.8 mm) gives sloped walls.
- Height = −depth (≈ 12 mm), plus pecked craters inside the mask (pecking, the 면새김 look).
- The height turns into a carve normal layer (`nCarve`), blended onto the wall's normals in the shader, plus slight fresh-stone lightening.
- Defaults are in `public/wall/metadata.json` → `carving`: depth 12 mm, bevel 3.8 mm, peck roughness 0.79, drawing width 700 mm, lightening 0.38.
- Carvings need sloped walls. Hairline edges vanish when zoomed out.
- Colors → carving styles: TBD. The reference drawings use two colors: brown (the main figures) and purple (a second group, prototyped as shallower). Mapping each palette color to a depth or style is a natural option. Propose it before building.

## Primary reference: sudoaquarelle.com

Fetch and study https://sudoaquarelle.com/ before designing the UI. We want the same feeling: a material that looks physical, a calm tool panel, and playful "lab" toggles. We are NOT simulating watercolor, and we no longer simulate the carving process stroke by stroke. The material moment is the drawing turning into stone.

| sudoaquarelle | Our app | Notes |
|---|---|---|
| Brush | Drawing brush (flat color) | A few colors, size slider. |
| Lift | Eraser | |
| Paper | The rock wall | The real scanned Bangudae wall (`public/wall/`). |
| Light / Backlight | Raking light (측광) | Low-angle light that makes carvings pop, as real petroglyphs are photographed. Let the user rotate it. The default look was picked in the demo (az 36°, el 12°). |
| Lab toggles | Carve depth / bevel, rubbing view (탁본) | Rubbing view = the carved mask as a flat silhouette on paper, like the reference tracings. |
| Undo / Clear / Save | Same | Save exports a share image. |
| Film | Timelapse replay | Replays the drawing, then the carving. Low priority. |

Match its restraint: minimal chrome, small labels, the material is the star.

## Reference files (`/ref`)

- `ref/2d/original/`: photos of the real rock face (book pages). `original_Page_06.jpg` is the main visual reference for the stone look.
- `ref/2d/drawing/`: the same book cells as the photos (one page = one grid cell), with the figures painted as flat brown/purple silhouettes over a shaded render of the scan. These show the drawing style the app aims for and give challenge-prompt shapes.
- `ref/size_reference.png`: the book's grid key. The carved panel is about 10 × 6 cells. It gives the scale of real figures relative to the wall.
- `ref/3d/wall.ply`: the 3D scan (38.8 MB, not in git). Used only by the offline bake.
- A separate motif chart (whales, deer, human figures, …) was mentioned originally but is not in `/ref` yet. Ask if challenge prompts need it.

## Rendering

- Do not build a procedural rock heightmap. The rock is the baked wall in `public/wall/`: normal map + albedo + AO + a tiled grain texture, lit by one fragment shader. How to load and light it, the mm coordinate system and the carve layer are all in **`WALL_ASSETS.md`**.
- `tools/wall_bake/demo/index.html` is a working WebGL2 reference (wall shader + runtime drawing→carving). Its `assets/config.json` holds the look the user picked, and `export.py` baked that look into `public/wall/`. Reuse this code.
- Budget: at most 3 texture fetches + the carve layer, one directional light + hemisphere ambient.
- For a single carving view (the Draw/Carve screens), render a crop of the wall around where the carving sits. Build the carve layer at about 1 mm/px.
- Carving placements on the shared wall are stored in **mm** (origin top-left). Only place them where `placement_mask.png` allows.

## Game mode: timed challenge

Inspired by Google's Quick, Draw!.

1. Show a prompt drawn from Bangudae motifs: 고래, 새끼 업은 고래, 사슴, 호랑이, 사람, 배, 작살 든 사람, etc.
2. Timer (default 30 seconds; tune after playtesting). The user draws.
3. When time ends, send the drawing mask (rubbing view, flat silhouette PNG) to the scoring proxy, then show the carving.
4. Show score, the AI's guess ("이건... 멧돼지 같아요?"), and a replay.

### Scoring proxy

- One serverless endpoint. Calls a small, fast Claude vision model (e.g. Claude Haiku 4.5). Check current Anthropic API docs for the exact model string and image input format.
- Ask for JSON only:
  ```json
  { "match": 0-100, "guess": "short Korean label", "comment": "one playful Korean sentence", "flagged": false }
  ```
- `flagged` is true for obscene or offensive drawings. Flagged carvings get no score and never reach the shared wall.
- Strip code fences before parsing. On any error, fall back to a neutral result instead of breaking the UI.
- Add basic rate limiting per client.

## Guestbook: shared rock wall

- After drawing (free mode or challenge), the user can add a short message and "leave it on the wall". Their drawing is carved into the shared wall at a free spot.
- The wall shows carvings only. Messages are NOT shown on the wall; the message appears only on the user's own share image.
- Store each carving as its drawing mask (or strokes) + position in mm + size. The carving is rebuilt at render time, so its look can be retuned later.
- Posting to the wall requires being near the site: check browser geolocation against a configurable center point and radius (put coordinates in a config file with a TODO to verify the viewing deck location). Everyone can browse the wall from anywhere.
- Moderation: messages go through the same proxy for a text check; flagged carvings are rejected.
- Storage: pick the simplest hosted option (e.g. Supabase or a KV store). Propose a choice before implementing.

## Share image

A single PNG: the carving on the wall under raking light, the user's message, the date, and small "반구대 암각화" branding. Sized for Instagram stories and KakaoTalk.

## Build order

Build and verify each milestone before moving on. Show me a demo at each step.

0. **Done:** the scanned wall (`public/wall/`) and a WebGL demo of drawing→carving (`tools/wall_bake/demo/`).
1. **Draw + carve**: drawing canvas (few colors, touch), conversion to a carving, the wall render with a rotatable raking light. This alone should feel satisfying. Spend time here.
2. **Polish**: undo, clear, eraser, brush size, rubbing view, carve depth/bevel lab toggles.
3. **Challenge mode**: prompts, timer, scoring proxy, result screen.
4. **Share image** export.
5. **Shared wall** with placement, geolocation gate and moderation.
6. Optional: timelapse replay, more rock looks, weathering over time.

Milestones 1 to 3 are the must-have for the demo.

## Working style

- Before writing code, propose the stack and file structure in a short plan and wait for approval. Suggested default: Vite + TypeScript, no heavy UI framework.
- Test on a narrow mobile viewport (about 380px) at every milestone.
- Keep dependencies few. Explain any library you add.
- When a visual decision is uncertain, build two quick variants, or an interactive slider demo, and let me pick.

## Shared wall assets (already built)

- The wall is baked from the real scan into `public/wall/`. Usage guide: **`WALL_ASSETS.md`**.
- Pipeline, status, decisions and open TODOs: **`WALL_BAKE.md`** ("Status & handoff" at the top). Code in `tools/wall_bake/`.
- Open TODOs: the real wall width (`align.real_width_m`; a provisional 10 m is used).
