import { describe, expect, it } from "vitest";
import { allowedFraction, placementOK, type PlacementMask } from "./placement";

// 10 × 5 mask over a 10,000 × 5,000 mm wall (1 px = 1 m); allowed everywhere except
// a 1 px border and the top-right 3 × 2 block.
function mask(): PlacementMask {
  const w = 10, h = 5, data = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) data[y * w + x] = x >= 7 && y < 2 ? 0 : 1;
  return { data, w, h, wallW: 10000, wallH: 5000 };
}

describe("placement", () => {
  const m = mask();

  it("accepts a frame fully on allowed wall", () => {
    expect(allowedFraction(m, [2000, 1500, 700, 1000])).toBe(1);
    expect(placementOK(m, [2000, 1500, 700, 1000])).toBe(true);
  });

  it("rejects a frame hanging over the wall edge", () => {
    expect(placementOK(m, [500, 1500, 700, 1000])).toBe(false);
    expect(placementOK(m, [-2000, 1500, 700, 1000])).toBe(false);
  });

  it("rejects the excluded block", () => {
    expect(placementOK(m, [7500, 1000, 700, 800])).toBe(false);
  });

  it("measures partial overlap", () => {
    const f = allowedFraction(m, [500, 1500, 1000, 1000]); // left half on the 1 m border
    expect(f).toBeCloseTo(0.5, 1);
  });
});
