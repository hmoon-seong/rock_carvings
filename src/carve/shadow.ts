// Cast shadow of the carve height field under the directional light.
// A carving reads as cut *in* mostly through this shadow: at raking light a 12 mm deep
// cut throws a ~56 mm shadow across its floor, which local normal shading alone can't show.
//
// Linear-time sweep: each pixel takes the shadow-casting height of its neighbour one step
// toward the light, S(p) = max(h(up), S(up)) − step · tan(el), and is shadowed where S > h.
// Outside the carve rectangle the wall is flat at height 0.

/**
 * @param height carve heights in mm (≤ 0), row-major w × h
 * @param azDeg light azimuth, 0 = from the top of the image, 90 = from the right
 * @param elDeg light elevation above the wall
 * @param penumbraMM soft edge width of the shadow, in mm of height
 * @returns 0 = lit … 1 = in shadow
 */
export function castShadow(
  height: Float32Array,
  w: number,
  h: number,
  mmPerPx: number,
  azDeg: number,
  elDeg: number,
  penumbraMM = 1,
): Float32Array {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  const lx = Math.sin(az), ly = -Math.cos(az); // toward the light, image coords (y down)
  const alongX = Math.abs(lx) >= Math.abs(ly);
  // Walk the major axis one pixel at a time; the minor axis moves by a fraction `f`.
  const major = alongX ? lx : ly, minor = alongX ? ly : lx;
  const nMajor = alongX ? w : h, nMinor = alongX ? h : w;
  const idx = alongX ? (a: number, b: number) => b * w + a : (a: number, b: number) => a * w + b;
  const s = Math.sign(major) || 1;
  const f = minor / Math.abs(major);
  const drop = (mmPerPx / Math.abs(major)) * Math.tan(el);

  const S = new Float32Array(w * h); // highest occluder ray height seen from each pixel
  const out = new Float32Array(w * h);
  const NONE = -1e9;
  const first = s > 0 ? nMajor - 1 : 0;
  for (let a = first; a >= 0 && a < nMajor; a -= s) {
    const up = a + s;
    for (let b = 0; b < nMinor; b++) {
      let occ: number;
      if (up < 0 || up >= nMajor) {
        occ = 0 - drop; // flat wall just outside the rectangle
      } else {
        // Linear interpolation between the two upstream pixels b0, b0 + 1.
        const bb = b + f, b0 = Math.floor(bb), t = bb - b0;
        const in0 = b0 >= 0 && b0 < nMinor, in1 = b0 + 1 >= 0 && b0 + 1 < nMinor;
        const k0 = in0 ? idx(up, b0) : 0, k1 = in1 ? idx(up, b0 + 1) : 0;
        const hu = (1 - t) * (in0 ? height[k0] : 0) + t * (in1 ? height[k1] : 0);
        const su = (1 - t) * (in0 ? S[k0] : NONE) + t * (in1 ? S[k1] : NONE);
        occ = Math.max(hu, su) - drop;
      }
      const k = idx(a, b);
      S[k] = occ;
      out[k] = Math.min(1, Math.max(0, (occ - height[k]) / penumbraMM));
    }
  }
  return out;
}

/**
 * Writes the cast shadow into the carve layer's blue channel (0 = lit, 255 = shadow).
 * Computed at `factor`× coarser resolution to stay cheap while the light is dragged.
 */
export function writeShadow(
  rgba: Uint8Array,
  height: Float32Array,
  w: number,
  h: number,
  mmPerPx: number,
  azDeg: number,
  elDeg: number,
  factor = 2,
) {
  const cw = Math.ceil(w / factor), ch = Math.ceil(h / factor);
  const coarse = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const row = ((y / factor) | 0) * cw;
    for (let x = 0; x < w; x++) coarse[row + ((x / factor) | 0)] += height[y * w + x];
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const n = (Math.min(factor, w - cx * factor)) * (Math.min(factor, h - cy * factor));
      coarse[cy * cw + cx] /= n;
    }
  }
  const s = castShadow(coarse, cw, ch, mmPerPx * factor, azDeg, elDeg);
  // Bilinear upsample (coarse pixel centres at (i + 0.5) · factor).
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max((y + 0.5) / factor - 0.5, 0), ch - 1);
    const y0 = fy | 0, y1 = Math.min(y0 + 1, ch - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max((x + 0.5) / factor - 0.5, 0), cw - 1);
      const x0 = fx | 0, x1 = Math.min(x0 + 1, cw - 1), tx = fx - x0;
      const top = s[y0 * cw + x0] * (1 - tx) + s[y0 * cw + x1] * tx;
      const bot = s[y1 * cw + x0] * (1 - tx) + s[y1 * cw + x1] * tx;
      rgba[4 * (y * w + x) + 2] = Math.round((top * (1 - ty) + bot * ty) * 255);
    }
  }
}
