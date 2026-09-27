import { describe, expect, it } from "vitest";
import { BRUSH, stampOutline, stamps } from "./brush";

const line = (len: number, step = 1) => {
  const p: number[] = [];
  for (let x = 0; x <= len; x += step) p.push(x, 0);
  return p;
};

describe("stamps", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(stamps(line(200), 22, 5)).toEqual(stamps(line(200), 22, 5));
    expect(stamps(line(200), 22, 5)).not.toEqual(stamps(line(200), 22, 6));
  });

  it("keeps earlier marks unchanged while the stroke grows", () => {
    const short = stamps(line(100), 22, 9), long = stamps(line(200), 22, 9);
    expect(long.slice(0, short.length - 1)).toEqual(short.slice(0, -1));
  });

  it("overlaps marks densely enough to read as one groove", () => {
    const s = stamps(line(300), 22, 1);
    for (let i = 1; i < s.length; i++) {
      const gap = Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
      expect(gap).toBeLessThan(Math.min(s[i].r, s[i - 1].r));
    }
  });

  it("varies the size around the chosen brush, within bounds", () => {
    const rs = stamps(line(600), 22, 3).map((s) => s.r);
    const lo = 11 * (1 - BRUSH.sizeWander) * (1 - BRUSH.sizeJitter), hi = 11 * (1 + BRUSH.sizeWander) * (1 + BRUSH.sizeJitter);
    expect(Math.min(...rs)).toBeGreaterThanOrEqual(lo);
    expect(Math.max(...rs)).toBeLessThanOrEqual(hi);
    expect(Math.max(...rs) - Math.min(...rs)).toBeGreaterThan(11 * 0.2); // noticeably uneven
  });

  it("makes one mark for a tap", () => {
    expect(stamps([10, 20], 22, 1)).toHaveLength(1);
  });
});

describe("stampOutline", () => {
  it("is a lumpy circle around the mark", () => {
    const st = { x: 50, y: 50, r: 10, seed: 42, lump: BRUSH.lumpDepth };
    const v = stampOutline(st);
    expect(v).toHaveLength(BRUSH.lumps * 2);
    const radii = [];
    for (let i = 0; i < v.length; i += 2) radii.push(Math.hypot(v[i] - 50, v[i + 1] - 50));
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(10 * (1 - BRUSH.lumpDepth) - 1e-9);
    expect(Math.max(...radii)).toBeLessThanOrEqual(10 * (1 + BRUSH.lumpDepth) + 1e-9);
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(1);
  });
});

describe("brush roughness", () => {
  const spread = (rough: number) => {
    const rs = stamps(line(600), 22, 3, rough).map((s) => s.r);
    return Math.max(...rs) - Math.min(...rs);
  };

  it("gives an even round groove at 0", () => {
    const s = stamps(line(300), 22, 3, 0);
    expect(s.every((m) => m.r === 11 && m.y === 0 && m.lump === 0)).toBe(true);
    const v = stampOutline(s[0]);
    for (let i = 0; i < v.length; i += 2) expect(Math.hypot(v[i] - s[0].x, v[i + 1] - s[0].y)).toBeCloseTo(11);
  });

  it("gets more irregular as it rises, without marks vanishing", () => {
    expect(spread(2)).toBeGreaterThan(spread(1));
    expect(spread(1)).toBeGreaterThan(spread(0.3));
    const rs = stamps(line(600), 22, 3, 2.5).map((s) => s.r);
    expect(Math.min(...rs)).toBeGreaterThan(11 * 0.35 * 0.5 - 1e-9);
  });
});
