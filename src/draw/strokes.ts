// Stroke model. Points are wall mm (origin top-left of the wall) while drawing; stored
// carvings move them to their own frame (guestbook/serialize.ts). A drawing can be
// re-rasterized at any resolution and placed anywhere on the wall.

import { stampOutline, stamps, type Stamp } from "./brush";

/** `Stroke.color` of an eraser stroke. */
export const ERASER = -1;

export interface Stroke {
  color: number; // palette index, or ERASER
  size: number; // brush diameter, mm (the marks wander around it)
  points: number[]; // flat [x0, y0, x1, y1, ...] in mm
  seed: number; // brush randomness
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Brush roughness for all strokes (the lab's 붓 거칠기); strokes keep only their seed. */
let roughness = 1;
export function setBrushRoughness(v: number) {
  roughness = v;
}

// Marks are cached per stroke; a growing stroke or a new roughness recomputes them
// (earlier marks of a growing stroke stay the same).
const cache = new WeakMap<Stroke, { n: number; rough: number; marks: Stamp[] }>();
export function strokeStamps(s: Stroke): Stamp[] {
  const hit = cache.get(s);
  if (hit && hit.n === s.points.length && hit.rough === roughness) return hit.marks;
  const marks = stamps(s.points, s.size, s.seed, roughness);
  cache.set(s, { n: s.points.length, rough: roughness, marks });
  return marks;
}

/** Bounding box [x0, y0, x1, y1] (mm) of everything a stroke can paint, at any roughness ≤ 2.5. */
export function strokeBounds(s: Stroke): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = s.points;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  // Marks wander, jitter sideways and get lumpy: up to ~3.8 × the brush radius at roughness 2.5.
  const r = (s.size / 2) * (1 + 1.2 * Math.min(2.5, roughness)) + 1;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

export function countStamps(strokes: readonly Stroke[]): number {
  return strokes.reduce((n, s) => n + strokeStamps(s).length, 0);
}

/**
 * Paints a stroke's peck marks with the current fill style. `scale` = px per mm; the mm
 * point (ox, oy) lands on pixel (0, 0). Paints at most `budget` marks and returns how many it painted.
 */
export function paintStroke(ctx: Ctx2D, s: Stroke, scale: number, budget = Infinity, ox = 0, oy = 0): number {
  const marks = strokeStamps(s);
  const n = Math.min(marks.length, budget);
  const X = (v: number) => (v - ox) * scale, Y = (v: number) => (v - oy) * scale;
  ctx.beginPath();
  for (let m = 0; m < n; m++) {
    const v = stampOutline(marks[m]);
    // Smooth closed blob through the midpoints of its lumpy outline.
    const k = v.length;
    ctx.moveTo(X((v[k - 2] + v[0]) / 2), Y((v[k - 1] + v[1]) / 2));
    for (let i = 0; i < k; i += 2) {
      const j = (i + 2) % k;
      ctx.quadraticCurveTo(X(v[i]), Y(v[i + 1]), X((v[i] + v[j]) / 2), Y((v[i + 1] + v[j + 1]) / 2));
    }
    ctx.closePath();
  }
  ctx.fill("nonzero");
  return n;
}

function canvas2d(w: number, h: number): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h).getContext("2d")!;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d")!;
}

export type Rasterizer = typeof rasterizeMasks;

/**
 * One mask per palette color, like flat paint: a later stroke covers earlier strokes
 * of other colors, and eraser strokes clear all colors. The masks cover the mm rectangle
 * (ox, oy, wMM, hMM); `mmPerPx` sets their resolution.
 * `used[c]` is false when color c has nothing left to carve.
 */
export function rasterizeMasks(
  strokes: readonly Stroke[],
  nColors: number,
  wMM: number,
  hMM: number,
  mmPerPx: number,
  maxStamps = Infinity, // the timelapse carves the first N marks only
  ox = 0,
  oy = 0,
) {
  const w = Math.max(1, Math.round(wMM / mmPerPx)), h = Math.max(1, Math.round(hMM / mmPerPx));
  const ctxs = Array.from({ length: nColors }, () => canvas2d(w, h));
  for (const ctx of ctxs) {
    ctx.fillStyle = "#fff";
  }
  let budget = maxStamps;
  const ex = ox + w * mmPerPx, ey = oy + h * mmPerPx;
  for (const s of strokes) {
    if (budget <= 0) break;
    if (budget === Infinity) {
      const b = strokeBounds(s);
      if (b[0] > ex || b[1] > ey || b[2] < ox || b[3] < oy) continue; // nothing to paint here
    }
    let painted = 0;
    ctxs.forEach((ctx, c) => {
      ctx.globalCompositeOperation = c === s.color ? "source-over" : "destination-out";
      painted = paintStroke(ctx, s, 1 / mmPerPx, budget, ox, oy);
    });
    budget -= painted;
  }
  const used: boolean[] = [];
  const masks = ctxs.map((ctx) => {
    const d = ctx.getImageData(0, 0, w, h).data;
    const m = new Float32Array(w * h);
    let any = false;
    for (let i = 0; i < m.length; i++) {
      m[i] = d[4 * i + 3] / 255;
      if (m[i] > 0.5) any = true;
    }
    used.push(any);
    return m;
  });
  return { masks, w, h, used };
}
