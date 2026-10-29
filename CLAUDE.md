# 암각화몬 (Amgakhwamon): Petroglyph Carving Web App

## What we are building

A mobile-first web app for visitors to the Bangudae Petroglyphs (반구대 암각화, Ulsan, Korea). A visitor makes a **simple drawing with a few flat colors**. The app **converts it into a petroglyph carving** and carves it into the real Bangudae rock wall (baked from a 3D scan), lit by a raking light. Visitors can leave their carving on the shared digital rock wall as a guestbook, or play 이어 그리기 with friends.

This is a student team prototype for a local program. Favor simple, robust solutions over ambitious ones.

**Change of plan (2026-09-27):** we no longer build physical carving tools (peck / incise / weather on a procedural heightmap). The user draws. Carving is an automatic conversion step: drawing → carve layer → lit on the scanned wall.

**Change of plan (2026-10-09):** no more paper view and no 자리 고르기. The user draws straight on the rock, and each stroke is carved the moment the finger lifts (실시간 새김; its paint fades into the fresh cut). Every drawing (each visit, each relay step) starts at a random free spot on the wall. Other visitors' carvings are not shown while drawing (later, maybe).

**Change of plan (2026-10-27):** removed the timed challenge (도전: prompt, timer, AI score, `/api/score`) and the share image (공유하기 sheet). The modes are now 자유 | 이어 그리기. The relay album's 이미지 저장 and the room invite share stay. Old wall rows may still hold `prompt` / `score`; they are no longer written or shown.

**Change of plan (2026-10-29):** the shared wall keeps only the **30 newest carvings** (`WALL_MAX` in `shared/wall.ts`; a trigger in `supabase/schema.sql` deletes older rows on each insert, and reads only return the newest 30). Only free-mode (자유) drawings go on the wall: 이어 그리기 chains no longer do (the `carve` room action, its chain moderation and the 벽에 남기기 / 모두의 벽 buttons in the album are removed). Why: a permanent wall fills up (then nobody can post) and its download grows without bound on mobile data.

## Hard constraints

- Web only. No native app, no install. Must work well in mobile Safari and Chrome on Android.
- Touch is the primary input. Mouse must also work.
- UI text in Korean.
- Never expose API keys in client code. All AI calls go through a small server-side proxy.
- Keep the first load light. Visitors are on mobile data at an outdoor site. The wall's first visit is 291 KB (budget 300 KB); the full-res wall (1.2 MB) loads only on zoom.

## Core flow

1. **Draw (그리기):** draw on the rock itself: one finger draws, two fingers pan / zoom (right-drag pans with a mouse). Strokes are stored in wall mm and carved live (`src/carve/liveCarve.ts`: only the area a stroke touches is re-carved; pecks are placed by wall position, so the result equals a full carve). A small palette of a few flat colors, brush size, eraser, undo, clear. The look to aim for is the reference drawings in `ref/2d/drawing`: flat silhouettes and thick lines, like the Bangudae motif tracings.
2. **Carve (완성 → 새김 보기):** the finished carving under raking light (측광); the user rotates the light, switches 바위 / 탁본 / 도면, replays the timelapse, or goes back with 더 그리기. The paint sinking into stone on every stroke is the key visual moment.
3. **Leave it on the wall** (free mode only), or the album (이어 그리기).

### Drawing → carving conversion

The algorithm is already prototyped and verified. See `WALL_ASSETS.md` → "User carvings" and `buildCarve()` in `tools/wall_bake/demo/index.html`.

- Drawing pixels become a mask. A soft bevel (gaussian, σ ≈ 3.8 mm) gives sloped walls.
- Height = −depth (≈ 12 mm), plus pecked craters inside the mask (pecking, the 면새김 look).
- The height turns into a carve normal layer (`nCarve`), blended onto the wall's normals in the shader, plus a darkening of the carved stone (`carve_darkening`).
- App defaults (2026-10-10) are in `src/look.json`: brush roughness 2.15, depth 11.5 mm, bevel 3.1 mm, peck roughness 0.52, purple depth ×0.39, carve darkening 0.6, plus the light (sun 2.52, warmth 0.61, shade 0.05, exposure 1.17, grain 0.24, az 36°, el 12°). Paste a "설정 복사" JSON there to change them. `metadata.json` → `carving` keeps the bake-time values; drawing width 700 mm still comes from there.
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
| Undo / Clear | Same | |
| Film | Timelapse replay | Replays the drawing, then the carving. Low priority. |

Match its restraint: minimal chrome, small labels, the material is the star.

## Reference files (`/ref`)

- `ref/2d/original/`: photos of the real rock face (book pages). `original_Page_06.jpg` is the main visual reference for the stone look.
- `ref/2d/drawing/`: the same book cells as the photos (one page = one grid cell), with the figures painted as flat brown/purple silhouettes over a shaded render of the scan. These show the drawing style the app aims for.
- `ref/size_reference.png`: the book's grid key. The carved panel is about 10 × 6 cells. It gives the scale of real figures relative to the wall.
- `ref/3d/wall.ply`: the 3D scan (38.8 MB, not in git). Used only by the offline bake.

## Rendering

- Do not build a procedural rock heightmap. The rock is the baked wall in `public/wall/`: normal map + albedo + AO + a tiled grain texture, lit by one fragment shader. How to load and light it, the mm coordinate system and the carve layer are all in **`WALL_ASSETS.md`**.
- `tools/wall_bake/demo/index.html` is a working WebGL2 reference (wall shader + runtime drawing→carving). Its `assets/config.json` holds the look the user picked, and `export.py` baked that look into `public/wall/`. Reuse this code.
- Budget: at most 3 texture fetches + the carve layer, one directional light + hemisphere ambient.
- For a single carving view (the Draw/Carve screens), render a crop of the wall around where the carving sits. Build the carve layer at about 1 mm/px.
- Carving placements on the shared wall are stored in **mm** (origin top-left). Only place them where `placement_mask.png` allows.

## AI proxy (moderation only)

- Calls a small, fast Qwen vision model through Alibaba Cloud DashScope (Model Studio), using its OpenAI-compatible chat API with plain `fetch` (`server/qwen.ts`). Default model `qwen3-vl-plus` (`qwen3-vl-flash` is not enabled for our key). Env vars: `DASHSCOPE_API_KEY`, plus optional `DASHSCOPE_BASE_URL` (default: the international endpoint) and `QWEN_MODEL`. Without a key, messages and texts are checked with a word list only (`shared/moderation.ts`).
- Used by `/api/wall` (drawing silhouette PNG + message before a carving is stored) and `/api/room` (in-game text). Ask for JSON only; strip code fences before parsing.
- Basic rate limiting per client.

## Game mode: 이어 그리기 (relay, Gartic Phone style)

Added 2026-10-22 as a mode next to 자유 (자유 | 이어 그리기 since the challenge was removed on 2026-10-27). 3–8 players, each on their own phone, in one room (4-letter code + QR). Step 0 everyone writes a free-text prompt; then the chains rotate one seat per step, alternating draw (on the rock, live carving) and guess. (A one-story-per-game variant was tried on 2026-10-27 and dropped: too much waiting.) When everyone still missing is away, the step is filled in after 15 s. **관전 (watchers):** join at any time (the only way into a started room), are not counted as players, follow a chosen chain step by step, and can switch to playing in the lobby. **End (no host-driven reveal since 2026-10-27):** each player gets the album of the chain they started (`src/relay/album.ts`): prompt → drawing → guess…, drawings photographed carved on the rock under the raking light (made on the device, one at a time), tabs for the other chains, 이미지 저장 = one tall JPEG. A 4-card tutorial (`src/relay/tutorial.ts`) opens the first time. Qwen does not play; it only moderates in-game text. Chains do not go on the shared wall (since 2026-10-29). Empty rooms (nobody seen for 2 min) and day-old rooms are deleted automatically; the last one to leave deletes the room.

- Rules: `shared/relay.ts`. Server: `server/room.ts` (`POST /api/room`), storage `server/roomStore.ts` (memory for local dev; Supabase `supabase/relay.sql` with `SUPABASE_SERVICE_ROLE_KEY` when deployed). Client: `src/relay/`.
- No server timers: every request settles the room (advance when all submitted or the deadline + grace passed, filling in absent players). Clients poll every 2 s.

## Guestbook: shared rock wall

- After drawing (free mode only), the user can add a short message and "leave it on the wall". Their drawing is carved into the shared wall at a free spot.
- The wall holds the 30 newest carvings (`WALL_MAX`); each new one pushes out the oldest.
- The wall shows carvings only. Messages are NOT shown or stored; they are only moderated.
- Store each carving as its drawing mask (or strokes) + position in mm + size. The carving is rebuilt at render time, so its look can be retuned later.
- Posting to the wall requires being near the site: check browser geolocation against a configurable center point and radius (put coordinates in a config file with a TODO to verify the viewing deck location). Everyone can browse the wall from anywhere.
- Moderation: messages go through the same proxy for a text check; flagged carvings are rejected.
- Storage: pick the simplest hosted option (e.g. Supabase or a KV store). Propose a choice before implementing.

## Build order

Build and verify each milestone before moving on. Show me a demo at each step.

0. **Done:** the scanned wall (`public/wall/`) and a WebGL demo of drawing→carving (`tools/wall_bake/demo/`).
1. **Draw + carve**: drawing canvas (few colors, touch), conversion to a carving, the wall render with a rotatable raking light. This alone should feel satisfying. Spend time here.
2. **Polish**: undo, clear, eraser, brush size, rubbing view, carve depth/bevel lab toggles.
3. ~~Challenge mode~~ and 4. ~~Share image~~: built, then removed (2026-10-27).
5. **Shared wall** with placement, geolocation gate and moderation.
6. Optional: timelapse replay, more rock looks, weathering over time.
7. **이어 그리기** (relay game).

## Working style

- Before writing code, propose the stack and file structure in a short plan and wait for approval. Suggested default: Vite + TypeScript, no heavy UI framework.
- Test on a narrow mobile viewport (about 380px) at every milestone.
- Keep dependencies few. Explain any library you add.
- When a visual decision is uncertain, build two quick variants, or an interactive slider demo, and let me pick.

## Shared wall assets (already built)

- The wall is baked from the real scan into `public/wall/`. Usage guide: **`WALL_ASSETS.md`**.
- Pipeline, status, decisions and open TODOs: **`WALL_BAKE.md`** ("Status & handoff" at the top). Code in `tools/wall_bake/`.
- Open TODOs: the real wall width (`align.real_width_m`; a provisional 10 m is used).
