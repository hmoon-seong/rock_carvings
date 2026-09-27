// Where a drawing may go: public/wall/placement_mask.png (255 = allowed; a 150 mm margin
// from the wall edges, and the flat cap shard at the top right is excluded).

import { WALL_DIR, type WallMeta } from "../config";
import { loadBitmap } from "./textures";

export interface PlacementMask {
  data: Uint8Array; // 1 = allowed
  w: number;
  h: number;
  wallW: number; // mm covered by the mask
  wallH: number;
}

/** Share of the frame that must be on allowed wall (its centre must be allowed too). */
export const MIN_ALLOWED = 0.9;

/** Loads the mask at 1/4 resolution (~13 mm/px): plenty for checking a 700 mm frame. */
export async function loadPlacementMask(meta: WallMeta): Promise<PlacementMask> {
  const img = await loadBitmap(WALL_DIR + meta.images.placement_mask.file);
  const w = Math.round(img.width / 4), h = Math.round(img.height / 4);
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = px[4 * i] > 127 ? 1 : 0;
  return { data, w, h, wallW: meta.width_mm, wallH: meta.height_mm };
}

function allowedAt(m: PlacementMask, xmm: number, ymm: number): boolean {
  const x = Math.floor((xmm / m.wallW) * m.w), y = Math.floor((ymm / m.wallH) * m.h);
  return x >= 0 && y >= 0 && x < m.w && y < m.h && m.data[y * m.w + x] === 1;
}

/** Fraction of the rectangle [x, y, w, h] (mm) on allowed wall, sampled on a grid. */
export function allowedFraction(m: PlacementMask, [x, y, w, h]: [number, number, number, number], n = 16): number {
  let ok = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) if (allowedAt(m, x + ((i + 0.5) / n) * w, y + ((j + 0.5) / n) * h)) ok++;
  }
  return ok / (n * n);
}

export function placementOK(m: PlacementMask, rect: [number, number, number, number]): boolean {
  const [x, y, w, h] = rect;
  return allowedAt(m, x + w / 2, y + h / 2) && allowedFraction(m, rect) >= MIN_ALLOWED;
}
