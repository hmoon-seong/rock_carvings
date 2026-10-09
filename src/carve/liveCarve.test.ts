import { describe, expect, it } from "vitest";
import type { Rasterizer, Stroke } from "../draw/strokes";
import { carveHeight } from "./carve";
import { LiveCarve } from "./liveCarve";

const STYLES = [
  { depth_mm: 6.5, bevel_sigma_mm: 4.5, peck_roughness: 0.6 },
  { depth_mm: 2.5, bevel_sigma_mm: 3.5, peck_roughness: 0.4 },
];

/** Stand-in for the canvas rasterizer (none in node): hard discs of the brush size at each point. */
const discs: Rasterizer = (strokes, nColors, wMM, hMM, mmPerPx, _max = Infinity, ox = 0, oy = 0) => {
  const w = Math.max(1, Math.round(wMM / mmPerPx)), h = Math.max(1, Math.round(hMM / mmPerPx));
  const masks = Array.from({ length: nColors }, () => new Float32Array(w * h));
  for (const s of strokes) {
    const r = s.size / 2 / mmPerPx;
    for (let i = 0; i < s.points.length; i += 2) {
      const cx = (s.points[i] - ox) / mmPerPx, cy = (s.points[i + 1] - oy) / mmPerPx;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, Math.ceil(cx + r)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
          masks.forEach((m, c) => (m[y * w + x] = c === s.color ? 1 : 0));
        }
      }
    }
  }
  return { masks, w, h, used: masks.map((m) => m.some((v) => v > 0.5)) };
};

const line = (color: number, x0: number, y0: number, x1: number, y1: number, size = 16): Stroke => {
  const points: number[] = [];
  for (let t = 0; t <= 1; t += 0.05) points.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
  return { color, size, points, seed: 1 };
};

/** Height at wall pixel (x, y) of a carving, 0 outside its region. */
const heightAt = (c: LiveCarve, x: number, y: number) => {
  const [rx, ry] = c.rectMM;
  const i = x - rx, j = y - ry;
  return i < 0 || j < 0 || i >= c.w || j >= c.h ? 0 : c.height[j * c.w + i];
};

function expectSameCarving(a: LiveCarve, b: LiveCarve) {
  const [x, y, w, h] = a.rectMM;
  let worst = 0;
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) worst = Math.max(worst, Math.abs(heightAt(a, i, j) - heightAt(b, i, j)));
  expect(worst).toBeLessThan(1e-4);
}

describe("LiveCarve", () => {
  const strokes = [
    line(0, 3000, 2000, 3200, 2050),
    line(1, 3100, 1950, 3120, 2150, 10),
    line(-1, 3050, 2000, 3150, 2030, 12), // eraser across both
    line(0, 3180, 2100, 3400, 2300, 24), // grows the region
  ];

  it("carving stroke by stroke gives the same result as carving everything at once", () => {
    const live = new LiveCarve(2, 1, discs);
    for (let i = 0; i < strokes.length; i++) live.update(strokes.slice(0, i + 1), [strokes[i]], STYLES);
    const full = new LiveCarve(2, 1, discs);
    full.rebuild(strokes, STYLES);
    expectSameCarving(live, full);
    expectSameCarving(full, live);
    expect(live.height.reduce((a, b) => Math.min(a, b), 0)).toBeLessThan(-5);
  });

  it("undoing a stroke restores the carving without it", () => {
    const live = new LiveCarve(2, 1, discs);
    for (let i = 0; i < strokes.length; i++) live.update(strokes.slice(0, i + 1), [strokes[i]], STYLES);
    live.update(strokes.slice(0, 2), strokes.slice(2), STYLES);
    const full = new LiveCarve(2, 1, discs);
    full.rebuild(strokes.slice(0, 2), STYLES);
    expectSameCarving(live, full);
  });

  it("grows its region to cover new strokes and empties with the drawing", () => {
    const live = new LiveCarve(2, 1, discs);
    live.update([strokes[0]], [strokes[0]], STYLES);
    const v = live.version, [x, , w] = live.rectMM;
    live.update(strokes, strokes.slice(1), STYLES);
    expect(live.version).toBeGreaterThan(v);
    expect(live.rectMM[0] + live.rectMM[2]).toBeGreaterThan(x + w);
    expect(live.used).toEqual([true, true]);
    live.update([], strokes, STYLES);
    expect(live.empty).toBe(true);
  });
});

describe("carveHeight origin", () => {
  it("places pecks by grid position, so a shifted crop matches", () => {
    const w = 60, h = 40;
    const mask = new Float32Array(w * h).fill(1);
    const style = { depth_mm: 6, bevel_sigma_mm: 0, peck_roughness: 1.2 };
    const big = carveHeight([{ mask, style }], { w, h, mmPerPx: 1, origin: [100, 200] }).height;
    const crop = carveHeight([{ mask: new Float32Array(30 * 20).fill(1), style }], { w: 30, h: 20, mmPerPx: 1, origin: [115, 210] }).height;
    // Away from the crop's edges (craters reach ≤ 3 px) the pixels agree.
    for (let y = 4; y < 16; y++) for (let x = 4; x < 26; x++) expect(crop[y * 30 + x]).toBeCloseTo(big[(y + 10) * w + x + 15], 6);
  });
});
