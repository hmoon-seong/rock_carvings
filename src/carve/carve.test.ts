import { describe, expect, it } from "vitest";
import { gaussBlur } from "./blur";
import { buildCarve, carveHeight, type CarveStyle } from "./carve";

const DEEP: CarveStyle = { depth_mm: 12, bevel_sigma_mm: 3.8, peck_roughness: 0.79 };
const SHALLOW: CarveStyle = { depth_mm: 5, bevel_sigma_mm: 3.0, peck_roughness: 0.5 };

function square(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Float32Array {
  const m = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

describe("gaussBlur", () => {
  it("preserves total mass away from the borders", () => {
    const m = square(64, 64, 24, 24, 40, 40);
    const b = gaussBlur(m, 64, 64, 3.8);
    const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    expect(sum(b)).toBeCloseTo(sum(m), 2);
  });
});

describe("carveHeight", () => {
  it("is flat for an empty drawing", () => {
    const { height, soft } = carveHeight([{ mask: new Float32Array(100), style: DEEP }], { w: 10, h: 10, mmPerPx: 1 });
    expect(Math.min(...height)).toBeCloseTo(0, 9);
    expect(Math.max(...soft)).toBe(0);
  });

  it("reaches about the style depth in the middle of a large figure", () => {
    const w = 80, h = 80;
    const mask = square(w, h, 10, 10, 70, 70);
    const noPeck = { ...DEEP, peck_roughness: 0 };
    const { height } = carveHeight([{ mask, style: noPeck }], { w, h, mmPerPx: 1 });
    expect(height[40 * w + 40]).toBeCloseTo(-12, 1);
    expect(height[2 * w + 2]).toBeCloseTo(0, 2);
  });

  it("lets the deeper color win where colors overlap", () => {
    const w = 80, h = 80;
    const mask = square(w, h, 10, 10, 70, 70);
    const { height } = carveHeight(
      [
        { mask, style: { ...SHALLOW, peck_roughness: 0 } },
        { mask, style: { ...DEEP, peck_roughness: 0 } },
      ],
      { w, h, mmPerPx: 1 },
    );
    expect(height[40 * w + 40]).toBeCloseTo(-12, 1);
  });

  it("is deterministic for a seed", () => {
    const mask = square(40, 40, 5, 5, 35, 35);
    const a = carveHeight([{ mask, style: DEEP }], { w: 40, h: 40, mmPerPx: 1, seed: 7 }).height;
    const b = carveHeight([{ mask, style: DEEP }], { w: 40, h: 40, mmPerPx: 1, seed: 7 }).height;
    expect(a).toEqual(b);
  });
});

describe("buildCarve", () => {
  it("encodes flat normals as (128,128) with no shadow and zero alpha outside", () => {
    const { rgba: px } = buildCarve([{ mask: new Float32Array(16), style: DEEP }], { w: 4, h: 4, mmPerPx: 1 });
    expect([px[0], px[1], px[2], px[3]]).toEqual([128, 128, 0, 0]);
  });

  it("tilts the walls of a pit inward (+x on the left wall, +y up on the bottom wall)", () => {
    const w = 80, h = 80;
    const mask = square(w, h, 20, 20, 60, 60);
    const style = { ...DEEP, peck_roughness: 0 };
    const { rgba: px } = buildCarve([{ mask, style }], { w, h, mmPerPx: 1 });
    const at = (x: number, y: number) => 4 * (y * w + x);
    expect(px[at(20, 40)]).toBeGreaterThan(160); // left wall faces right
    expect(px[at(59, 40)]).toBeLessThan(96); // right wall faces left
    expect(px[at(40, 59) + 1]).toBeGreaterThan(160); // bottom wall faces up (+Y up)
    expect(px[at(40, 40) + 3]).toBe(255);
  });
});
