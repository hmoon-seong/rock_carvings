import { describe, expect, it } from "vitest";
import { overlaps, validateDraft, type CarvingDraft, type Rect } from "../../shared/wall";
import { fromWallStrokes, toWallStrokes } from "./serialize";
import { findSpots } from "./spot";
import { layerResolution, windowCovers, windowFor } from "./wallLayer";
import { SAMPLES } from "./samples";

const WALL = { wallW: 10000, wallH: 4000 };
const anywhere = { ...WALL, allowed: () => true };

describe("findSpots", () => {
  it("keeps the visitor's spot when it is free", () => {
    expect(findSpots(500, 400, [1000, 1000], { ...anywhere, taken: [] })[0]).toEqual([1000, 1000, 500, 400]);
  });
  it("moves to the nearest free spot that does not overlap", () => {
    const taken: Rect[] = [[900, 900, 700, 600]];
    const spots = findSpots(500, 400, [1000, 1000], { ...anywhere, taken });
    expect(spots.length).toBeGreaterThan(1);
    for (const s of spots) expect(overlaps(s, taken[0], 40)).toBe(false);
    const d = Math.hypot(spots[0][0] - 1000, spots[0][1] - 1000);
    expect(d).toBeLessThan(1000);
  });
  it("respects the placement mask and returns spots apart from each other", () => {
    const allowed = (r: Rect) => r[0] >= 5000; // right half only
    const spots = findSpots(400, 300, [100, 100], { ...WALL, allowed, taken: [] });
    expect(spots.every((s) => s[0] >= 5000)).toBe(true);
    for (let i = 1; i < spots.length; i++) expect(Math.hypot(spots[i][0] - spots[0][0], spots[i][1] - spots[0][1])).toBeGreaterThanOrEqual(400);
  });
  it("finds nothing on a full wall", () => {
    expect(findSpots(400, 300, [0, 0], { ...WALL, allowed: () => true, taken: [[0, 0, 10000, 4000]] })).toEqual([]);
  });
});

describe("serialize", () => {
  it("round-trips strokes, moved to the crop origin", () => {
    const s = [{ color: 1, size: 22.3, seed: 7, points: [100.2, 50.1, 110.7, 60.4, 110.6, 60.3] }];
    const w = toWallStrokes(s, 100, 50);
    expect(w[0]).toEqual({ c: 1, s: 22.5, seed: 7, p: [0, 0, 10.5, 10.5] });
    expect(fromWallStrokes(w)[0]).toEqual({ color: 1, size: 22.5, seed: 7, points: [0, 0, 10.5, 10.5] });
  });
});

describe("validateDraft", () => {
  const ok: CarvingDraft = { x_mm: 1, y_mm: 2, w_mm: 300, h_mm: 200, src_w: 300, src_h: 200, strokes: [{ c: 0, s: 20, seed: 1, p: [0, 0, 5, 5] }] };
  it("accepts a normal draft and the samples", () => {
    expect(validateDraft(ok)).toBeNull();
    for (const c of SAMPLES) expect(validateDraft(c)).toBeNull();
  });
  it("rejects bad input", () => {
    expect(validateDraft({ ...ok, w_mm: 5 })).toBe("size");
    expect(validateDraft({ ...ok, strokes: [] })).toBe("strokes");
    expect(validateDraft({ ...ok, strokes: [{ c: 0, s: 20, seed: 1, p: [0, 0, 5] }] })).toBe("stroke.p");
    expect(validateDraft({ ...ok, score: 120 })).toBe("score");
    expect(validateDraft({ ...ok, relay: 3 })).toBe("relay"); // relay chains no longer go on the wall
    expect(validateDraft(null)).toBe("body");
  });
});

describe("wall layer window", () => {
  it("picks a power-of-two resolution in [1, 8]", () => {
    expect(layerResolution(0.3)).toBe(1);
    expect(layerResolution(2.9)).toBe(2);
    expect(layerResolution(30)).toBe(8);
  });
  it("covers the view with a margin and stays under the pixel cap", () => {
    const view: Rect = [2000, 1000, 1000, 2000];
    const win = windowFor(view, 10000, 4000, 1);
    expect(windowCovers(win, view, win.mmPerPx)).toBe(true);
    expect(win.w).toBeLessThanOrEqual(2048);
    expect(win.h).toBeLessThanOrEqual(2048);
    expect(win.rect[0] % win.mmPerPx).toBe(0);
  });
});
