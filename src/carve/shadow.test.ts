import { describe, expect, it } from "vitest";
import { castShadow, writeShadow } from "./shadow";

// A 12 mm deep square pit (vertical walls) in a flat wall, 1 mm/px.
function pit(w: number, h: number, x0: number, y0: number, x1: number, y1: number, depth = 12): Float32Array {
  const m = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = -depth;
  return m;
}

describe("castShadow", () => {
  const w = 200, h = 200;
  const height = pit(w, h, 50, 50, 150, 150);
  const at = (s: Float32Array, x: number, y: number) => s[y * w + x];

  it("shades the floor just inside the rim facing away from a light from the top", () => {
    // el 12°: a 12 mm wall throws a 12 / tan(12°) ≈ 56 mm shadow.
    const s = castShadow(height, w, h, 1, 0, 12);
    expect(at(s, 100, 55)).toBe(1); // near the top rim: shadowed
    expect(at(s, 100, 100)).toBe(1); // 50 mm in: still shadowed
    expect(at(s, 100, 115)).toBe(0); // 65 mm in: lit
    expect(at(s, 100, 145)).toBe(0); // near the bottom rim: lit
    expect(at(s, 100, 20)).toBe(0); // the wall surface outside: lit
    expect(at(s, 100, 170)).toBe(0);
  });

  it("follows the light around (from the right: shadow along the right rim)", () => {
    const s = castShadow(height, w, h, 1, 90, 12);
    expect(at(s, 145, 100)).toBe(1);
    expect(at(s, 55, 100)).toBe(0);
  });

  it("handles diagonal light", () => {
    const s = castShadow(height, w, h, 1, 45, 20); // from the top-right
    expect(at(s, 140, 60)).toBe(1); // top-right corner of the floor
    expect(at(s, 60, 140)).toBe(0); // bottom-left corner
  });

  it("casts nothing when the light is high enough", () => {
    const s = castShadow(height, w, h, 1, 0, 89);
    expect(at(s, 100, 51)).toBeLessThan(0.1);
  });
});

describe("writeShadow", () => {
  it("fills the blue channel at coarse resolution", () => {
    const w = 200, h = 200, height = new Float32Array(w * h);
    for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) height[y * w + x] = -12;
    const rgba = new Uint8Array(w * h * 4);
    writeShadow(rgba, height, w, h, 1, 0, 12);
    expect(rgba[4 * (70 * w + 100) + 2]).toBe(255);
    expect(rgba[4 * (140 * w + 100) + 2]).toBe(0);
    expect(rgba[4 * (20 * w + 100) + 2]).toBe(0);
  });
});
