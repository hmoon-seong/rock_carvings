// The drawing as a flat silhouette PNG (the rubbing-view mask): dark figure on light paper,
// cropped to the figure. This is what the scoring proxy and the moderation see.

/** Bounding box [x0, y0, x1, y1) of mask pixels > 0.5 over all masks, in px; null if empty. */
export function maskBBox(masks: Float32Array[], w: number, h: number): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (masks.some((m) => m[k] > 0.5)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

const INK = [28, 26, 27], PAPER = [244, 239, 232];

/** data:image/png;base64 silhouette, longest side ≤ `maxSide`; null for an empty drawing. */
export function silhouettePNG(masks: Float32Array[], w: number, h: number, maxSide = 384): string | null {
  const bb = maskBBox(masks, w, h);
  if (!bb) return null;
  // Square-ish crop with a margin, so the model sees the figure's proportions with some air.
  const bw = bb[2] - bb[0], bh = bb[3] - bb[1];
  const side = Math.max(bw, bh) * 1.15 + 8;
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const cw = Math.round(Math.max(bw * 1.15 + 8, side * 0.6)), ch = Math.round(Math.max(bh * 1.15 + 8, side * 0.6));
  const ox = Math.round(cx - cw / 2), oy = Math.round(cy - ch / 2);

  const src = document.createElement("canvas");
  src.width = cw;
  src.height = ch;
  const sctx = src.getContext("2d")!;
  const img = sctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const sx = ox + x, sy = oy + y;
      let a = 0;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) for (const m of masks) a = Math.max(a, m[sy * w + sx]);
      const k = 4 * (y * cw + x);
      for (let c = 0; c < 3; c++) img.data[k + c] = Math.round(PAPER[c] + (INK[c] - PAPER[c]) * a);
      img.data[k + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);

  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cw * s));
  out.height = Math.max(1, Math.round(ch * s));
  const octx = out.getContext("2d")!;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(src, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
