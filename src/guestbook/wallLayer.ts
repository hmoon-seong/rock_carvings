// One carve layer for a window of the shared wall: every stored carving in the window is
// rebuilt from its strokes (so its look follows the current settings), at a resolution
// that matches the zoom (1 mm/px close up … 8 mm/px for the whole wall).

import type { Carving, Rect } from "../../shared/wall";
import { carveHeight, heightToRgba, type CarveStyle } from "../carve/carve";
import { rasterizeMasks } from "../draw/strokes";
import { hashString } from "../../shared/score";
import { fromWallStrokes } from "./serialize";

export interface WallWindow {
  rect: Rect; // mm, aligned to the grid
  mmPerPx: number;
  w: number;
  h: number;
}

export interface WallLayerResult extends WallWindow {
  rgba: Uint8Array;
  height: Float32Array;
}

/** Carve resolution for a zoom: about one carve pixel per device pixel, a power of two in [1, 8] mm/px. */
export function layerResolution(mmPerDevicePx: number): number {
  const p = 2 ** Math.floor(Math.log2(Math.max(1, mmPerDevicePx)));
  return Math.min(8, p);
}

/** The window for a view: the view plus a margin, clipped to the wall, at most `maxPx` per side. */
export function windowFor(view: Rect, wallW: number, wallH: number, mmPerPx: number, maxPx = 2048): WallWindow {
  let r = mmPerPx;
  const [vx, vy, vw, vh] = view;
  const mx = vw * 0.3, my = vh * 0.3;
  const x0 = Math.max(0, vx - mx), y0 = Math.max(0, vy - my);
  const x1 = Math.min(wallW, vx + vw + mx), y1 = Math.min(wallH, vy + vh + my);
  while ((x1 - x0) / r > maxPx || (y1 - y0) / r > maxPx) r *= 2;
  const gx0 = Math.floor(x0 / r) * r, gy0 = Math.floor(y0 / r) * r;
  const w = Math.max(1, Math.ceil((x1 - gx0) / r)), h = Math.max(1, Math.ceil((y1 - gy0) / r));
  return { rect: [gx0, gy0, w * r, h * r], mmPerPx: r, w, h };
}

/** Does window `a` still serve `view` at resolution `r`? */
export const windowCovers = (a: WallWindow, view: Rect, r: number) =>
  a.mmPerPx === r && view[0] >= a.rect[0] && view[1] >= a.rect[1] && view[0] + view[2] <= a.rect[0] + a.rect[2] && view[1] + view[3] <= a.rect[1] + a.rect[3];

interface Built {
  height: Float32Array;
  soft: Float32Array;
  w: number;
  h: number;
}

export class WallLayer {
  private cache = new Map<string, Built>();
  /** Bump when the carve look or brush changes (cached carvings are rebuilt). */
  lookVersion = 0;

  constructor(private nColors: number) {}

  private carving(c: Carving, r: number, styles: CarveStyle[]): Built {
    const key = `${c.id}@${r}@${this.lookVersion}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const scale = c.w_mm / c.src_w;
    const { masks, w, h, used } = rasterizeMasks(fromWallStrokes(c.strokes), this.nColors, c.src_w, c.src_h, r / scale);
    const layers = masks.flatMap((mask, i) => (used[i] ? [{ mask, style: styles[i] }] : []));
    const { height, soft } = carveHeight(layers, { w, h, mmPerPx: r, seed: hashString(c.id) });
    const built = { height, soft, w, h };
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(key, built);
    return built;
  }

  build(carvings: readonly Carving[], win: WallWindow, styles: CarveStyle[]): WallLayerResult {
    const { w, h, mmPerPx: r } = win;
    const H = new Float32Array(w * h), S = new Float32Array(w * h);
    for (const c of carvings) {
      const b = this.carving(c, r, styles);
      const ox = Math.round((c.x_mm - win.rect[0]) / r), oy = Math.round((c.y_mm - win.rect[1]) / r);
      for (let y = Math.max(0, -oy); y < b.h && y + oy < h; y++) {
        const row = (y + oy) * w + ox, src = y * b.w;
        for (let x = Math.max(0, -ox); x < b.w && x + ox < w; x++) {
          const k = row + x;
          if (b.height[src + x] < H[k]) H[k] = b.height[src + x];
          if (b.soft[src + x] > S[k]) S[k] = b.soft[src + x];
        }
      }
    }
    return { ...win, rgba: heightToRgba(H, S, w, h, r), height: H };
  }
}
