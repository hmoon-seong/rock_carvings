// Separable box blur; three passes approximate a gaussian (same as the wall_bake demo).

export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * k;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * k;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}

const boxRadius = (sigma: number) => Math.max(0, Math.round((Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2));

/** How far (px) a value spreads under gaussBlur: pixels farther apart never affect each other. */
export const blurReach = (sigma: number) => 3 * boxRadius(sigma);

/** Gaussian blur with standard deviation `sigma` in pixels (three box passes). */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = boxRadius(sigma);
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}
