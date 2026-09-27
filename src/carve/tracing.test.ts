import { describe, expect, it } from "vitest";
import { tracingLabels } from "./tracing";

function square(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Float32Array {
  const m = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

describe("tracingLabels", () => {
  const w = 60, h = 40;

  it("labels each color's shape and leaves paper elsewhere", () => {
    const a = square(w, h, 5, 5, 25, 35), b = square(w, h, 35, 5, 55, 35);
    const L = tracingLabels([a, b], [2, 2], w, h);
    expect(L[20 * w + 15]).toBe(0);
    expect(L[20 * w + 45]).toBe(1);
    expect(L[20 * w + 30]).toBe(-1);
    expect(L[1 * w + 1]).toBe(-1);
  });

  it("drops strokes thinner than the bevel can carve", () => {
    const hair = square(w, h, 10, 20, 50, 21); // 1 px line
    const L = tracingLabels([hair], [3.8], w, h);
    expect(L.every((v) => v === -1)).toBe(true);
  });
});
