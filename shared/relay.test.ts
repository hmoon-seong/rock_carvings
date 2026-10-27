import { describe, expect, it } from "vitest";
import { chainStrip, cleanText, newHost, newRoom, normCode, RELAY, startGame, stepKind, tick, validateDrawing, type PlayerRow } from "./relay";
import { LIMITS, validateDraft } from "./wall";

const player = (id: string, joined: number, seen = 1000, watch = false): PlayerRow => ({ id, token: "t" + id, name: id, seat: -1, joined, seen, watch });
const three = () => [player("a", 1), player("b", 2), player("c", 3)];

describe("relay rules", () => {
  it("alternates write, draw, guess", () => {
    expect([0, 1, 2, 3, 4, 5].map(stepKind)).toEqual(["write", "draw", "guess", "draw", "guess", "draw"]);
  });

  it("starts with one writer at seat 0, the others shuffled, and a deadline", () => {
    const { state, seats } = startGame(newRoom("a"), three(), 10_000, () => 0.5);
    expect(state).toMatchObject({ phase: "play", step: 0, n: 3, game: 1, writers: ["a"] });
    expect(state.deadline).toBe(10_000 + (RELAY.leadSeconds + RELAY.seconds.write) * 1000);
    expect(seats.get("a")).toBe(0);
    expect([...seats.values()].sort()).toEqual([0, 1, 2]);
  });

  it("rotates the writer each game, then starts over", () => {
    const ps = three();
    let st = newRoom("a");
    const writers: string[] = [];
    for (let g = 0; g < 4; g++) {
      const { state, seats } = startGame({ ...st, phase: "lobby" }, ps, 0);
      writers.push([...seats].find(([, s]) => s === 0)![0]);
      st = state;
    }
    expect(writers).toEqual(["a", "b", "c", "a"]);
    expect(st.writers).toEqual(["a"]);
    // A newcomer writes before anyone writes a second time.
    const { seats } = startGame({ ...st, phase: "lobby" }, [...ps, player("d", 9)], 0);
    expect([...seats].find(([, s]) => s === 0)![0]).toBe("b");
  });

  it("advances when the step is done, after the deadline, or when its player is away", () => {
    const { state } = startGame(newRoom("a"), three(), 0);
    expect(tick(state, false, false, 1000)).toBeNull();
    const done = tick(state, true, false, 1000)!;
    expect(done.fill).toBeNull();
    expect(done.state).toMatchObject({ step: 1, phase: "play" });

    const late = tick(state, false, false, state.deadline + RELAY.graceSeconds * 1000 + 1, () => 0)!;
    expect(late.fill).toMatchObject({ chain: 0, step: 0, auto: true });
    expect(typeof late.fill!.text).toBe("string");
    // Within the grace period it still waits for the auto-submit.
    expect(tick(state, false, false, state.deadline + 1000)).toBeNull();
    // An away player gets a short while to come back, then is skipped.
    expect(tick(state, false, true, RELAY.awaySkipMs - 1)).toBeNull();
    expect(tick(state, false, true, RELAY.awaySkipMs)!.state.step).toBe(1);
  });

  it("goes to the reveal after the last step", () => {
    const st = { ...startGame(newRoom("a"), three(), 0).state, step: 2 };
    const t = tick(st, true, false, 5)!;
    expect(t.state).toMatchObject({ phase: "reveal", rv: 0, deadline: 0 });
  });

  it("fills a missing drawing with an empty one", () => {
    const st = { ...startGame(newRoom("a"), three(), 0).state, step: 1 };
    const t = tick(st, false, false, st.deadline + 60_000)!;
    expect(t.fill).toEqual({ chain: 0, step: 1, author: "", drawing: { w: 0, h: 0, strokes: [] }, auto: true });
  });

  it("hands the host role to the earliest present player", () => {
    const st = newRoom("a");
    const now = 100_000;
    expect(newHost(st, [player("a", 1, now), player("b", 2, now)], now)).toBeNull();
    expect(newHost(st, [player("a", 1, 0), player("c", 3, now), player("b", 2, now)], now)).toBe("b");
    expect(newHost(st, [player("a", 1, 0)], now)).toBeNull();
    // Never a watcher.
    expect(newHost(st, [player("a", 1, 0), player("w", 2, now, true), player("c", 3, now)], now)).toBe("c");
  });

  it("cleans text and codes", () => {
    expect(cleanText("  고래가\n\t춤을   춰요 ")).toBe("고래가 춤을 춰요");
    expect(cleanText("a​b")).toBe("a b");
    expect([...cleanText("가".repeat(60))].length).toBe(RELAY.textMax);
    expect(cleanText(42)).toBe("");
    expect(normCode(" ab-cd9e ")).toBe("ABCD");
  });

  it("validates drawings", () => {
    expect(validateDrawing({ w: 0, h: 0, strokes: [] })).toBeNull();
    expect(validateDrawing({ w: 300, h: 200, strokes: [{ c: 0, s: 20, seed: 1, p: [0, 0, 10, 10] }] })).toBeNull();
    expect(validateDrawing({ w: 0, h: 0, strokes: [{ c: 0, s: 20, seed: 1, p: [0, 0] }] })).toBe("size");
    expect(validateDrawing({ w: 300, h: 200, strokes: [{ c: 9, s: 20, seed: 1, p: [0, 0] }] })).toBe("stroke.c");
    expect(validateDrawing(null)).toBe("drawing");
  });
});

describe("chainStrip", () => {
  const big = { w: 1200, h: 600, strokes: [{ c: 0, s: 40, seed: 1, p: [0, 0, 1200, 600] }] };
  const small = { w: 300, h: 300, strokes: [{ c: 1, s: 20, seed: 2, p: [0, 0, 300, 300] }] };

  it("puts drawings in a row, scaled to the cell and centred", () => {
    const s = chainStrip([big, { w: 0, h: 0, strokes: [] }, small])!;
    // big is halved (1200 → 600 wide, 300 tall); small keeps its size
    expect(s.w).toBe(600 + RELAY.stripGap + 300);
    expect(s.h).toBe(300);
    expect(s.strokes[0]).toEqual({ c: 0, s: 20, seed: 1, p: [0, 0, 600, 300] });
    expect(s.strokes[1]).toEqual({ c: 1, s: 20, seed: 2, p: [700, 0, 1000, 300] });
  });

  it("is null when every drawing is empty", () => {
    expect(chainStrip([{ w: 0, h: 0, strokes: [] }])).toBeNull();
  });

  it("makes a valid wall row", () => {
    const s = chainStrip([big, small, big, small])!;
    const draft = { x_mm: 100, y_mm: 100, w_mm: s.w, h_mm: s.h, src_w: s.w, src_h: s.h, strokes: s.strokes, relay: 8 };
    expect(validateDraft(draft)).toBeNull();
    expect(s.w).toBeLessThanOrEqual(LIMITS.maxSize);
  });
});
