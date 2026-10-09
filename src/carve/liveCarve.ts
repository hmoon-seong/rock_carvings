// The visitor's carving, kept up to date while they draw (실시간 새김). A new or undone stroke
// re-carves only the area it touches, with enough margin around it that the result is
// exactly what carving the whole drawing at once would give (pecks are placed by position).

import { rasterizeMasks, strokeBounds, type Rasterizer, type Stroke } from "../draw/strokes";
import { blurReach } from "./blur";
import { carveHeight, heightToRgba, type CarveStyle } from "./carve";

type Box = [number, number, number, number]; // x0, y0, x1, y1 in carve pixels (wall grid)

/** The region grows in steps of this many mm, so it is not reallocated on every stroke. */
const GROW_MM = 64;
const SEED = 1234;
const PECK_MM = 2.5; // largest crater radius (carve.ts)

export class LiveCarve {
  /** Region on the wall grid, px: carving pixel (x, y) is wall mm ((X + x) · mmPerPx, …). */
  private X = 0;
  private Y = 0;
  w = 0;
  h = 0;
  masks: Float32Array[] = [];
  used: boolean[] = [];
  height = new Float32Array(0);
  /** RGBA8 carve layer (carve.ts); the blue channel (shadow) is written by the caller. */
  rgba = new Uint8Array(0);
  /** Bumped whenever the region (and so the layer size) changes. */
  version = 0;

  constructor(
    private nColors: number,
    readonly mmPerPx = 1,
    private raster: Rasterizer = rasterizeMasks,
  ) {}

  get empty(): boolean {
    return this.w === 0;
  }

  /** The region in wall mm: [x, y, w, h]. */
  get rectMM(): [number, number, number, number] {
    const k = this.mmPerPx;
    return [this.X * k, this.Y * k, this.w * k, this.h * k];
  }

  reset() {
    this.X = this.Y = this.w = this.h = 0;
    this.masks = [];
    this.used = [];
    this.height = new Float32Array(0);
    this.rgba = new Uint8Array(0);
    this.version++;
  }

  /** Bounding box (mm) of everything the strokes would carve, or null for none. */
  carveBounds(strokes: readonly Stroke[], styles: CarveStyle[]): [number, number, number, number] | null {
    const b = this.pxBounds(strokes, styles);
    if (!b) return null;
    const k = this.mmPerPx;
    return [b[0] * k, b[1] * k, b[2] * k, b[3] * k];
  }

  /** Re-carves after `changed` strokes were added to or removed from `strokes`. */
  update(strokes: readonly Stroke[], changed: readonly Stroke[], styles: CarveStyle[]) {
    if (strokes.length === 0) return this.reset();
    const dirty = this.pxBounds(changed, styles);
    if (!dirty) return;
    this.cover(dirty);
    this.carveArea(strokes, dirty, styles);
  }

  /** Carves the whole drawing from scratch (the look or the brush changed). */
  rebuild(strokes: readonly Stroke[], styles: CarveStyle[]) {
    this.reset();
    const all = this.pxBounds(strokes, styles);
    if (!all) return;
    this.cover(all);
    this.carveArea(strokes, [this.X, this.Y, this.X + this.w, this.Y + this.h], styles);
  }

  /** Pixels a carving reaches beyond its mask: the bevel blur, a crater, the normal's neighbour. */
  private reach(styles: CarveStyle[]): number {
    const sigma = Math.max(0, ...styles.map((s) => s.bevel_sigma_mm)) / this.mmPerPx;
    return blurReach(sigma) + Math.ceil(PECK_MM / this.mmPerPx) + 1;
  }

  private pxBounds(strokes: readonly Stroke[], styles: CarveStyle[]): Box | null {
    if (strokes.length === 0) return null;
    const k = this.mmPerPx, pad = this.reach(styles);
    let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of strokes) {
      const [x0, y0, x1, y1] = strokeBounds(s);
      b = [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)];
    }
    return [Math.floor(b[0] / k) - pad, Math.floor(b[1] / k) - pad, Math.ceil(b[2] / k) + pad, Math.ceil(b[3] / k) + pad];
  }

  /** Grows the region (keeping what is carved) until it covers `b`. */
  private cover(b: Box) {
    const g = Math.max(1, Math.round(GROW_MM / this.mmPerPx));
    if (!this.empty && b[0] >= this.X && b[1] >= this.Y && b[2] <= this.X + this.w && b[3] <= this.Y + this.h) return;
    const u: Box = this.empty ? b : [Math.min(b[0], this.X), Math.min(b[1], this.Y), Math.max(b[2], this.X + this.w), Math.max(b[3], this.Y + this.h)];
    const X = Math.floor(u[0] / g) * g, Y = Math.floor(u[1] / g) * g;
    const w = Math.ceil(u[2] / g) * g - X, h = Math.ceil(u[3] / g) * g - Y;
    const masks = Array.from({ length: this.nColors }, () => new Float32Array(w * h));
    const height = new Float32Array(w * h);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[4 * i] = rgba[4 * i + 1] = 128; // flat normal, no coverage
    }
    const dx = this.X - X, dy = this.Y - Y;
    for (let y = 0; y < this.h; y++) {
      const src = y * this.w, dst = (y + dy) * w + dx;
      masks.forEach((m, c) => m.set(this.masks[c].subarray(src, src + this.w), dst));
      height.set(this.height.subarray(src, src + this.w), dst);
      rgba.set(this.rgba.subarray(4 * src, 4 * (src + this.w)), 4 * dst);
    }
    Object.assign(this, { X, Y, w, h, masks, height, rgba });
    this.used = this.masks.map((m) => m.some((v) => v > 0.5));
    this.version++;
  }

  /** Carves the box `a` (inside the region) from a buffer with a margin all around. */
  private carveArea(strokes: readonly Stroke[], a: Box, styles: CarveStyle[]) {
    const k = this.mmPerPx, m = this.reach(styles) + 1;
    const ex = a[0] - m, ey = a[1] - m, ew = a[2] - a[0] + 2 * m, eh = a[3] - a[1] + 2 * m;
    const { masks } = this.raster(strokes, this.nColors, ew * k, eh * k, k, Infinity, ex * k, ey * k);
    const layers = masks.flatMap((mask, c) => (mask.some((v) => v > 0) ? [{ mask, style: styles[c], key: c }] : []));
    const { height, soft } = carveHeight(layers, { w: ew, h: eh, mmPerPx: k, seed: SEED, origin: [ex, ey] });
    const rgba = heightToRgba(height, soft, ew, eh, k);
    // Copy the inner box back into the region.
    const x0 = Math.max(a[0], this.X), x1 = Math.min(a[2], this.X + this.w);
    const y0 = Math.max(a[1], this.Y), y1 = Math.min(a[3], this.Y + this.h);
    if (x1 <= x0 || y1 <= y0) return;
    const n = x1 - x0;
    for (let y = y0; y < y1; y++) {
      const src = (y - ey) * ew + (x0 - ex), dst = (y - this.Y) * this.w + (x0 - this.X);
      this.masks.forEach((mm, c) => mm.set(masks[c].subarray(src, src + n), dst));
      this.height.set(height.subarray(src, src + n), dst);
      this.rgba.set(rgba.subarray(4 * src, 4 * (src + n)), 4 * dst);
    }
    this.used = this.masks.map((mm) => mm.some((v) => v > 0.5));
  }
}
