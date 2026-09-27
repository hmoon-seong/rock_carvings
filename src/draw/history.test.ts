import { describe, expect, it } from "vitest";
import { StrokeHistory } from "./history";

const s = (color: number) => ({ color, size: 10, points: [0, 0], seed: 1 });

describe("StrokeHistory", () => {
  it("undoes strokes one at a time", () => {
    const h = new StrokeHistory();
    h.add(s(0));
    h.add(s(1));
    h.undo();
    expect(h.strokes.map((x) => x.color)).toEqual([0]);
    h.undo();
    expect(h.strokes).toEqual([]);
    expect(h.canUndo).toBe(false);
  });

  it("brings back a cleared drawing", () => {
    const h = new StrokeHistory();
    h.add(s(0));
    h.add(s(1));
    h.clear();
    expect(h.strokes).toEqual([]);
    h.undo();
    expect(h.strokes.length).toBe(2);
  });

  it("does not record clearing an empty drawing", () => {
    const h = new StrokeHistory();
    h.clear();
    expect(h.canUndo).toBe(false);
  });
});
