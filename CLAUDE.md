# 암각화몬 (Amgakhwamon): Petroglyph Carving Web App

## What we are building

A mobile-first web app where visitors to the Bangudae Petroglyphs (반구대 암각화, Ulsan, Korea) carve their own petroglyph into a simulated rock surface, play a timed carving challenge, and leave their carving on a shared digital rock wall as a guestbook.

This is a student team prototype for a local program. Favor simple, robust solutions over ambitious ones.

## Hard constraints

- Web only. No native app, no install. Must work well in mobile Safari and Chrome on Android.
- Touch is the primary input. Mouse must also work.
- UI text in Korean.
- Never expose API keys in client code. All AI calls go through a small server-side proxy.
- Keep the first load light. Visitors are on mobile data at an outdoor site.

## Primary reference: sudoaquarelle.com

Fetch and study https://sudoaquarelle.com/ before designing the UI. It is a browser watercolor simulator based on real physics (Curtis et al., SIGGRAPH 1997). We want the same feeling: a material that behaves physically, a calm tool panel, and playful "lab" toggles. We are NOT simulating watercolor. We are simulating stone being pecked and incised.

Map its concepts to ours:

| sudoaquarelle | Our app | Notes |
|---|---|---|
| Brush | Peck (쪼기) | Each tap chips a small crater into the rock. Repeated taps deepen and widen it. This is how 면새김 (area carving) was made. |
| Water / drag strokes | Incise (선새김) | Dragging scratches a thin groove. Repeated passes deepen it. |
| Lift | Weather (풍화) | Softens / partially fills carved areas. Acts as a soft eraser. |
| Size, Water sliders | Tool size, Force | Force controls depth per hit. |
| Paper | Rock type | 2 to 3 rock textures (e.g. the pinkish-grey shale of Bangudae). |
| Light / Backlight | Raking light (측광) | Low-angle directional light that makes carvings pop. This is the key visual trick and mirrors how real petroglyphs are photographed. Let the user rotate the light angle. |
| Alive: Rain, Breathing | Time passes (optional) | Slow weathering, moss, water level. Low priority. |
| Lab: X-ray | Rubbing view (탁본) | High-contrast view showing only the carved regions as solid color, like the reference motif chart. Also used as the scoring input. |
| Undo / Clear / Save | Same | Save exports a share image. |
| Film | Timelapse replay | Replays the carving process. Nice for sharing. Low priority. |

Match its restraint: minimal chrome, small labels, the material is the star.

## Reference images

Images live in `/ref`. Read them before building visuals.

- Motif chart of the major Bangudae figures (whales, whaling scenes, carnivores, deer, human figures). Use it for challenge prompts and for the rubbing view's look.
- Photo of the actual rock face (reddish-grey sedimentary cliff with layered fractures). Use it for the rock texture and color palette.
- Any other files in `/ref` are references too. Ask if something is unclear.

## Rendering approach (suggested)

- Represent the rock as a heightmap (Float32 grid, e.g. 512x512, scaled to the canvas).
- Base height = procedural noise plus layered fracture lines resembling the reference photo.
- Peck: subtract a small randomized crater stamp at the touch point. Add jitter so repeated pecks look hand-made, not smooth.
- Incise: subtract a narrow stamp along the stroke path with slight wobble.
- Weather: blur and partially restore height in a radius.
- Shading: compute normals from the heightmap and light it with one directional light (angle and elevation adjustable). Carved areas should also be slightly lighter in albedo, like fresh stone.
- Rubbing view: threshold carved depth into a flat single-color silhouette on a paper background.
- Start with Canvas2D if performance is fine. Move shading to WebGL only if needed on mid-range phones.
- Keep an operation log (tool, position, force, time) so undo and timelapse are easy.

## Game mode: timed challenge

Inspired by Google's Quick, Draw!.

1. Show a prompt drawn from Bangudae motifs: 고래, 새끼 업은 고래, 사슴, 호랑이, 사람, 배, 작살 든 사람, etc.
2. Timer (default 30 seconds; tune after playtesting).
3. When time ends, export the rubbing view as PNG and send it to the scoring proxy.
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

- After carving (free mode or challenge), the user can add a short message and "leave it on the wall".
- The wall shows carvings only, placed on a large shared rock surface. Messages are NOT shown on the wall. The message appears only on the user's own share image.
- Posting to the wall requires being near the site: check browser geolocation against a configurable center point and radius (put coordinates in a config file with a TODO to verify the viewing deck location). Everyone can browse the wall from anywhere.
- Moderation: messages go through the same proxy for a text check; flagged carvings are rejected.
- Storage: pick the simplest hosted option (e.g. Supabase or a KV store). Propose a choice before implementing.

## Share image

A single PNG: the carving under raking light, the user's message, the date, and small "반구대 암각화" branding. Sized for Instagram stories and KakaoTalk.

## Build order

Build and verify each milestone before moving on. Show me a demo at each step.

1. **Rock canvas**: heightmap, peck tool, raking light with adjustable angle. This alone should feel satisfying. Spend time here.
2. **Tools**: incise, weather, size/force, undo, clear, rubbing view.
3. **Challenge mode**: prompts, timer, scoring proxy, result screen.
4. **Share image** export.
5. **Shared wall** with geolocation gate and moderation.
6. Optional: timelapse replay, rock types, weathering over time.

Milestones 1 to 3 are the must-have for the demo.

## Working style

- Before writing code, propose the stack and file structure in a short plan and wait for approval. Suggested default: Vite + TypeScript, no heavy UI framework.
- Test on a narrow mobile viewport (about 380px) at every milestone.
- Keep dependencies few. Explain any library you add.
- When a visual decision is uncertain, build two quick variants and let me pick.

## Shared wall assets (already built)

- The shared rock wall is baked from the real scan (`ref/3d/wall.ply`) into `public/wall/`. How to load it, the lighting shader contract, mm coordinates and the carve layer are in **`WALL_ASSETS.md`**.
- Pipeline, status, decisions and open TODOs are in **`WALL_BAKE.md`** (see "Status & handoff" at the top). Code is in `tools/wall_bake/`.
- `tools/wall_bake/demo/index.html` is a working WebGL2 reference (wall shader + runtime carving). Its `assets/config.json` holds the look the user picked. Reuse it for the rock canvas and the shared wall.
