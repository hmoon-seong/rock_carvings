// Stroke model. Points are mm relative to the drawing rectangle's top-left,
// so a drawing can be re-rasterized at any resolution and placed anywhere on the wall.

/** `Stroke.color` of an eraser stroke. */
export const ERASER = -1;

export interface Stroke {
  color: number; // palette index, or ERASER
  size: number; // brush diameter, mm
  points: number[]; // flat [x0, y0, x1, y1, ...] in mm
}

/** Traces a stroke as a smooth path (midpoint quadratics). `scale` = px per mm. */
export function strokePath(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: Stroke, scale: number) {
  const p = s.points;
  ctx.lineWidth = s.size * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (p.length <= 2) {
    ctx.arc(p[0] * scale, p[1] * scale, (s.size * scale) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(p[0] * scale, p[1] * scale);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    ctx.quadraticCurveTo(p[i] * scale, p[i + 1] * scale, mx * scale, my * scale);
  }
  ctx.lineTo(p[p.length - 2] * scale, p[p.length - 1] * scale);
  ctx.stroke();
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
export function rasterizeMasks(strokes: readonly Stroke[], nColors: number, wMM: number, hMM: number, mmPerPx: number) {
  const w = Math.max(1, Math.round(wMM / mmPerPx)), h = Math.max(1, Math.round(hMM / mmPerPx));
  const ctxs = Array.from({ length: nColors }, () => canvas2d(w, h));
  for (const ctx of ctxs) {
    ctx.fillStyle = ctx.strokeStyle = "#fff";
  }
  for (const s of strokes) {
    ctxs.forEach((ctx, c) => {
      ctx.globalCompositeOperation = c === s.color ? "source-over" : "destination-out";
      strokePath(ctx, s, 1 / mmPerPx);
    });
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
