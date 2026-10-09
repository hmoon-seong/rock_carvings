// Drawing masks → carve normal layer (WALL_ASSETS.md → "User carvings").
// Each palette color is its own mask with its own carving style; the deepest one wins.

import { gaussBlur } from "./blur";

export interface CarveStyle {
  depth_mm: number;
  bevel_sigma_mm: number;
  peck_roughness: number;
}

export interface CarveLayer {
  mask: Float32Array; // 0..1, row-major, w × h
  style: CarveStyle;
  /** Keeps a layer's pecks stable when other layers come and go (default: its index). */
  key?: number;
}

export interface CarveOptions {
  w: number;
  h: number;
  mmPerPx: number;
  seed?: number;
  /**
   * Pixel offset of this buffer in a larger grid. Pecks are placed by grid position, so
   * re-carving a part of a carving (with enough margin) gives exactly the same pixels.
   */
  origin?: [number, number];
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform [0, 1) hash of a grid pixel, a seed and a channel (pecks are placed by position). */
function hash01(x: number, y: number, seed: number, ch: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1) ^ Math.imul(ch + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Height field in mm (≤ 0) and the soft coverage used as the carve alpha. */
export function carveHeight(layers: CarveLayer[], opts: CarveOptions): { height: Float32Array; soft: Float32Array } {
  const { w, h, mmPerPx } = opts;
  const n = w * h;
  const base = new Float32Array(n);
  const coverage = new Float32Array(n);
  const softs: Float32Array[] = [];
  for (const { mask, style } of layers) {
    const soft = gaussBlur(mask, w, h, style.bevel_sigma_mm / mmPerPx);
    softs.push(soft);
    for (let i = 0; i < n; i++) {
      base[i] = Math.min(base[i], -style.depth_mm * soft[i]);
      coverage[i] = Math.max(coverage[i], soft[i]);
    }
  }

  // Pecks: dense overlapping craters inside each mask (the 면새김 texture). Each mask pixel
  // holds a crater with a probability set by the roughness, placed by its grid position.
  const height = base.slice();
  const seed = opts.seed ?? 1234;
  const [ox, oy] = opts.origin ?? [0, 0];
  layers.forEach(({ mask, style, key }, li) => {
    const rough = Math.min(style.peck_roughness, 1.5);
    const rate = mmPerPx * mmPerPx * 0.15 * rough; // craters per pixel
    if (rate <= 0) return;
    const ch = (key ?? li) * 16;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (mask[cy * w + cx] <= 0.5) continue;
        const gx = cx + ox, gy = cy + oy;
        const count = Math.floor(rate) + (hash01(gx, gy, seed, ch) < rate % 1 ? 1 : 0);
        for (let p = 0; p < count; p++) {
          const c2 = ch + 1 + 2 * p;
          const r = (1.0 + hash01(gx, gy, seed, c2) * 1.5) / mmPerPx;
          const dep = (0.5 + hash01(gx, gy, seed, c2 + 1)) * rough;
          const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
          const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
          for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
              const q = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
              if (q < 1) {
                const k = y * w + x;
                height[k] = Math.min(height[k], base[k] - dep * (1 - q));
              }
            }
          }
        }
      }
    }
  });
  return { height, soft: coverage };
}

/**
 * RGBA8 carve layer: rg = normal.xy * 0.5 + 0.5 (OpenGL, +Y up), b = cast shadow
 * (0 here; filled per light by `writeShadow`), a = soft mask.
 * Normals are in mm units: n = normalize(-dh/dx, +dh/drow, 1).
 * Returns the height field too, for the shadow.
 */
export function buildCarve(layers: CarveLayer[], opts: CarveOptions): { rgba: Uint8Array; height: Float32Array } {
  const { height, soft } = carveHeight(layers, opts);
  return { rgba: heightToRgba(height, soft, opts.w, opts.h, opts.mmPerPx), height };
}

/** The RGBA8 carve layer of a height field (mm) and its soft coverage (see buildCarve). */
export function heightToRgba(height: Float32Array, soft: Float32Array, w: number, h: number, mmPerPx: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const dx = (height[y * w + Math.min(x + 1, w - 1)] - height[y * w + Math.max(x - 1, 0)]) / (2 * mmPerPx);
      const dr = (height[Math.min(y + 1, h - 1) * w + x] - height[Math.max(y - 1, 0) * w + x]) / (2 * mmPerPx);
      const l = Math.hypot(dx, dr, 1);
      px[4 * k] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      px[4 * k + 1] = Math.round((dr / l * 0.5 + 0.5) * 255);
      px[4 * k + 3] = Math.round(Math.min(1, soft[k] * 1.5) * 255);
    }
  }
  return px;
}
