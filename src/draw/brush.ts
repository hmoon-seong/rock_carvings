// Pecking brush: a stroke becomes a chain of lumpy, overlapping peck marks whose size wanders
// along the stroke, so the carved outline is scalloped and irregular like a real petroglyph.
// Everything is seeded per stroke: a drawing always re-renders and re-carves the same way, and
// marks already laid down never change while the stroke grows.

import { mulberry32 } from "../carve/carve";

export interface Stamp {
  x: number; // mm
  y: number;
  r: number; // mean radius, mm
  seed: number;
  lump: number; // outline radius noise (0 = circle)
}

/** Brush character at roughness 1. Radii are relative to the chosen brush radius. */
export const BRUSH = {
  spacing: 0.38, // distance between marks, × mark radius
  sizeWander: 0.24, // slow size change along the stroke (±)
  sizeWavelength: 3.5, // × brush radius
  sizeJitter: 0.1, // per-mark size noise (±)
  sideJitter: 0.16, // sideways offset of each mark (±, × radius)
  lumps: 9, // outline vertices per mark
  lumpDepth: 0.28, // outline radius noise (0 = circle)
};

/** Smooth 1D value noise in [−1, 1], seeded; knots are hashed by index so it is stable. */
function valueNoise(seed: number, t: number): number {
  const i = Math.floor(t), f = t - i;
  const knot = (k: number) => mulberry32((seed * 7919) ^ (k * 104729))() * 2 - 1;
  const u = (1 - Math.cos(f * Math.PI)) / 2;
  return knot(i) * (1 - u) + knot(i + 1) * u;
}

/**
 * Peck marks for a stroke of brush diameter `size` through `points` (flat mm pairs).
 * `roughness` scales all irregularity: 0 = even round groove, 1 = default, 2.5 = very rough.
 */
export function stamps(points: number[], size: number, seed: number, roughness = 1): Stamp[] {
  const R = size / 2, k = Math.max(0, roughness);
  const rnd = mulberry32(seed);
  const out: Stamp[] = [];
  const place = (x: number, y: number, tx: number, ty: number, arc: number) => {
    // Wander is capped so marks never shrink to nothing at high roughness.
    const wander = Math.max(0.35, 1 + k * BRUSH.sizeWander * valueNoise(seed, arc / (BRUSH.sizeWavelength * R)));
    const r = R * wander * Math.max(0.5, 1 + k * BRUSH.sizeJitter * (rnd() * 2 - 1));
    const side = k * BRUSH.sideJitter * R * (rnd() * 2 - 1);
    out.push({ x: x - ty * side, y: y + tx * side, r, seed: (rnd() * 2 ** 31) | 0, lump: Math.min(0.7, k * BRUSH.lumpDepth) });
    return r;
  };

  if (points.length <= 2) {
    place(points[0], points[1], 1, 0, 0);
    return out;
  }
  let arc = 0, next = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const x0 = points[i], y0 = points[i + 1], x1 = points[i + 2], y1 = points[i + 3];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) continue;
    const tx = (x1 - x0) / len, ty = (y1 - y0) / len;
    while (next <= arc + len) {
      const t = (next - arc) / len;
      const r = place(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, tx, ty, next);
      next += Math.max(0.5, BRUSH.spacing * r);
    }
    arc += len;
  }
  if (out.length === 0) place(points[0], points[1], 1, 0, 0);
  return out;
}

/** Outline of one mark as `lumps` vertices (flat mm pairs): a circle with seeded bumps. */
export function stampOutline(s: Stamp): number[] {
  const rnd = mulberry32(s.seed);
  const n = BRUSH.lumps, rot = rnd() * Math.PI * 2, v: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * Math.PI * 2;
    const r = s.r * (1 + s.lump * (rnd() * 2 - 1));
    v.push(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r);
  }
  return v;
}
