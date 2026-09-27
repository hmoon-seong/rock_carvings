// Stroke model. Points are mm relative to the drawing rectangle's top-left,
// so a drawing can be re-rasterized at any resolution and placed anywhere on the wall.

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

export function countStamps(strokes: readonly Stroke[]): number {
  return strokes.reduce((n, s) => n + strokeStamps(s).length, 0);
}

/**
 * Paints a stroke's peck marks with the current fill style. `scale` = px per mm.
 * Paints at most `budget` marks and returns how many it painted.
 */
export function paintStroke(ctx: Ctx2D, s: Stroke, scale: number, budget = Infinity): number {
  const marks = strokeStamps(s);
  const n = Math.min(marks.length, budget);
  ctx.beginPath();
  for (let m = 0; m < n; m++) {
    const v = stampOutline(marks[m]);
    // Smooth closed blob through the midpoints of its lumpy outline.
    const k = v.length;
    ctx.moveTo(((v[k - 2] + v[0]) / 2) * scale, ((v[k - 1] + v[1]) / 2) * scale);
    for (let i = 0; i < k; i += 2) {
      const j = (i + 2) % k;
      ctx.quadraticCurveTo(v[i] * scale, v[i + 1] * scale, ((v[i] + v[j]) / 2) * scale, ((v[i + 1] + v[j + 1]) / 2) * scale);
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

/**
 * One mask per palette color, like flat paint: a later stroke covers earlier strokes
 * of other colors, and eraser strokes clear all colors. `mmPerPx` sets the mask resolution.
 * `used[c]` is false when color c has nothing left to carve.
 */
export function rasterizeMasks(
  strokes: readonly Stroke[],
  nColors: number,
  wMM: number,
  hMM: number,
  mmPerPx: number,
  maxStamps = Infinity, // the timelapse carves the first N marks only
) {
  const w = Math.max(1, Math.round(wMM / mmPerPx)), h = Math.max(1, Math.round(hMM / mmPerPx));
  const ctxs = Array.from({ length: nColors }, () => canvas2d(w, h));
  for (const ctx of ctxs) {
    ctx.fillStyle = "#fff";
  }
  let budget = maxStamps;
  for (const s of strokes) {
    if (budget <= 0) break;
    let painted = 0;
    ctxs.forEach((ctx, c) => {
      ctx.globalCompositeOperation = c === s.color ? "source-over" : "destination-out";
      painted = paintStroke(ctx, s, 1 / mmPerPx, budget);
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
