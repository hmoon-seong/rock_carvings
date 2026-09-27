// Paints the 도면 (tracing) view: flat silhouettes on paper, at the carve layer resolution.

import { hexToRgb, PAPER_HEX, type PaletteColor } from "../config";

export function paintTracing(canvas: HTMLCanvasElement, labels: Int8Array, w: number, h: number, palette: PaletteColor[]) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const paper = hexToRgb(PAPER_HEX), cols = palette.map((p) => hexToRgb(p.hex));
  for (let i = 0; i < labels.length; i++) {
    const c = labels[i] < 0 ? paper : cols[labels[i]];
    img.data[4 * i] = c[0];
    img.data[4 * i + 1] = c[1];
    img.data[4 * i + 2] = c[2];
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
