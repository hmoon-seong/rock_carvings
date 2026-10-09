import { describe, expect, it } from "vitest";
import { Camera, fitScale, niceLength } from "./camera";

const lim = { wallW: 10412, wallH: 4650, minScale: 0.45 };
const VW = 380, VH = 650;

describe("Camera", () => {
  it("maps the viewport to a mm rectangle around its centre", () => {
    const c = new Camera(3000, 1800, 2);
    expect(c.rect(VW, VH)).toEqual([3000 - 380, 1800 - 650, 760, 1300]);
    expect(c.toMM(VW / 2, VH / 2, VW, VH)).toEqual([3000, 1800]);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const c = new Camera(3000, 1800, 2);
    const before = c.toMM(50, 100, VW, VH);
    c.zoomAt(2, 50, 100, VW, VH, lim);
    expect(c.scale).toBeCloseTo(1);
    const after = c.toMM(50, 100, VW, VH);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it("stops at the zoom-in limit and at the whole wall", () => {
    const c = new Camera(3000, 1800, 1);
    c.zoomAt(100, VW / 2, VH / 2, VW, VH, lim);
    expect(c.scale).toBe(0.45);
    c.zoomAt(1 / 1000, VW / 2, VH / 2, VW, VH, lim);
    expect(c.scale).toBeCloseTo(fitScale(VW, VH, lim));
    expect(c.scale * VW).toBeGreaterThanOrEqual(lim.wallW); // portrait phone: width is the limit
  });

  it("pans opposite to the finger and keeps the centre on the wall", () => {
    const c = new Camera(3000, 1800, 2);
    c.pan(10, -5);
    expect([c.cx, c.cy]).toEqual([2980, 1810]);
    c.pan(1e6, 1e6);
    c.clamp(VW, VH, lim);
    expect([c.cx, c.cy]).toEqual([0, 0]);
  });
});

describe("niceLength", () => {
  it("rounds to 1/2/5 steps", () => {
    expect(niceLength(130)).toBe(100);
    expect(niceLength(260)).toBe(200);
    expect(niceLength(740)).toBe(500);
    expect(niceLength(1800)).toBe(1000);
  });
});

describe("Camera limits", () => {
  it("never zooms out past maxScale", () => {
    const c = new Camera(3000, 1800, 2);
    c.zoomAt(0.1, VW / 2, VH / 2, VW, VH, { ...lim, maxScale: 3 });
    expect(c.scale).toBe(3);
  });
});
