import { describe, expect, it } from "vitest";
import { MOTIFS, pickMotif } from "./challenge";
import { mockScore, parseScore, stripFences } from "./score";

describe("stripFences", () => {
  it("removes code fences and surrounding text", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('Here you go: {"a": {"b": 2}} thanks')).toBe('{"a": {"b": 2}}');
  });
});

describe("parseScore", () => {
  it("parses and clamps", () => {
    const r = parseScore('```json\n{"match": 140, "guess": "고래", "comment": "멋져요!", "flagged": false}\n```');
    expect(r).toEqual({ match: 100, guess: "고래", comment: "멋져요!", flagged: false });
  });
  it("gives no score to flagged drawings", () => {
    expect(parseScore('{"match": 80, "guess": "x", "comment": "", "flagged": true}')?.match).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseScore("I cannot do that")).toBeNull();
    expect(parseScore('{"guess": "고래"}')).toBeNull();
  });
});

describe("mockScore", () => {
  it("is deterministic and in range", () => {
    const a = mockScore("iVBORw0KGgoAAAAabc", "whale"), b = mockScore("iVBORw0KGgoAAAAabc", "whale");
    expect(a).toEqual(b);
    expect(a.mock).toBe(true);
    for (let i = 0; i < 50; i++) {
      const r = mockScore("img" + i, "deer");
      expect(r.match).toBeGreaterThanOrEqual(35);
      expect(r.match).toBeLessThanOrEqual(95);
      expect(r.comment.length).toBeGreaterThan(0);
    }
  });
});

describe("pickMotif", () => {
  it("never repeats the excluded prompt", () => {
    for (let i = 0; i < 100; i++) expect(pickMotif("whale").id).not.toBe("whale");
    expect(MOTIFS.length).toBe(10);
  });
});
