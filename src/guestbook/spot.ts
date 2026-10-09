// Where a new carving goes on the shared wall: the visitor's own spot if it is free,
// otherwise the nearest free spots allowed by placement_mask.png.

import { overlaps, type Rect } from "../../shared/wall";

export interface SpotOptions {
  wallW: number;
  wallH: number;
  /** Is this rectangle on allowed wall (placement_mask.png)? */
  allowed: (r: Rect) => boolean;
  /** Existing carvings. */
  taken: readonly Rect[];
  /** Free space kept around carvings, mm. */
  gap?: number;
  /** Grid step of the search, mm. */
  step?: number;
  /** How many spots to return (for 다른 자리). */
  max?: number;
}

export const isFree = (r: Rect, o: SpotOptions) => o.allowed(r) && !o.taken.some((t) => overlaps(r, t, o.gap ?? 40));

/**
 * Free spots for a w × h carving, nearest to `preferred` (its top-left, mm) first.
 * The returned spots are at least one carving width apart, so 다른 자리 really moves.
 */
export function findSpots(w: number, h: number, preferred: [number, number], o: SpotOptions): Rect[] {
  const step = o.step ?? 60, max = o.max ?? 6;
  const out: Rect[] = [];
  const first: Rect = [preferred[0], preferred[1], w, h];
  if (isFree(first, o)) out.push(first);
  const cands: [number, number, number][] = [];
  for (let y = 0; y + h <= o.wallH; y += step) {
    for (let x = 0; x + w <= o.wallW; x += step) cands.push([x, y, (x - preferred[0]) ** 2 + (y - preferred[1]) ** 2]);
  }
  cands.sort((a, b) => a[2] - b[2]);
  const apart = Math.max(w, h) ** 2;
  for (const [x, y] of cands) {
    if (out.length >= max) break;
    if (out.some((r) => (r[0] - x) ** 2 + (r[1] - y) ** 2 < apart)) continue;
    const r: Rect = [x, y, w, h];
    if (isFree(r, o)) out.push(r);
  }
  return out;
}
