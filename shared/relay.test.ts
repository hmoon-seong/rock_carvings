import { describe, expect, it } from "vitest";
import { chainFor, cleanText, newHost, newRoom, normCode, RELAY, seatFor, startGame, stepKind, tick, validateDrawing, type PlayerRow } from "./relay";

const player = (id: string, joined: number, seen = 1000, watch = false): PlayerRow => ({ id, token: "t" + id, name: id, seat: -1, joined, seen, watch });
const three = () => [player("a", 1), player("b", 2), player("c", 3)];
const none = new Set<number>();

describe("relay rules", () => {
  it("alternates write, draw, guess", () => {
    expect([0, 1, 2, 3, 4, 5].map(stepKind)).toEqual(["write", "draw", "guess", "draw", "guess", "draw"]);
  });

  it("gives every seat a different chain each step, and never its own chain after step 0", () => {
    for (let n = RELAY.minPlayers; n <= RELAY.maxPlayers; n++) {
      for (let step = 0; step < n; step++) {
        const chains = new Set<number>();
        for (let seat = 0; seat < n; seat++) {
          const c = chainFor(seat, step, n);
          expect(seatFor(c, step, n)).toBe(seat);
          if (step > 0) expect(c).not.toBe(seat);
          chains.add(c);
        }
        expect(chains.size).toBe(n);
      }
      // Each seat works on each chain exactly once over the game.
      for (let seat = 0; seat < n; seat++) {
        expect(new Set(Array.from({ length: n }, (_, s) => chainFor(seat, s, n))).size).toBe(n);
      }
    }
  });

  it("starts with shuffled seats and a deadline", () => {
    const { state, seats } = startGame(newRoom("a"), three(), 10_000, () => 0.5);
    expect(state).toMatchObject({ phase: "play", step: 0, n: 3, game: 1 });
    expect(state.deadline).toBe(10_000 + (RELAY.leadSeconds + RELAY.seconds.write) * 1000);
    expect([...seats.values()].sort()).toEqual([0, 1, 2]);
  });

  it("advances when everyone has submitted, or after the deadline with fill-ins", () => {
    const { state } = startGame(newRoom("a"), three(), 0);
    expect(tick(state, new Set([0, 1]), none, 1000)).toBeNull();
    const all = tick(state, new Set([0, 1, 2]), none, 1000)!;
    expect(all.fill).toEqual([]);
    expect(all.state).toMatchObject({ step: 1, phase: "play" });

    const late = tick(state, new Set([1]), none, state.deadline + RELAY.graceSeconds * 1000 + 1, () => 0)!;
    expect(late.fill.map((e) => e.chain)).toEqual([0, 2]);
    expect(late.fill.every((e) => e.auto && typeof e.text === "string" && e.text.length > 0)).toBe(true);
    // Within the grace period it still waits for the auto-submits.
    expect(tick(state, new Set([1]), none, state.deadline + 1000)).toBeNull();
  });

  it("skips ahead when everyone still missing is away", () => {
    const st = { ...startGame(newRoom("a"), three(), 0).state, step: 1 };
    const start = st.deadline - (RELAY.leadSeconds + RELAY.seconds.draw) * 1000;
    // Step 1: chain 2 is with seat 0 (away); chain 1 with seat 2 (here).
    expect(seatFor(2, 1, 3)).toBe(0);
    expect(tick(st, new Set([0, 1]), new Set([0]), start + RELAY.awaySkipMs - 1)).toBeNull();
    expect(tick(st, new Set([0, 1]), new Set([0]), start + RELAY.awaySkipMs)!.fill.map((e) => e.chain)).toEqual([2]);
    // Someone present is still missing: wait for them.
    expect(tick(st, new Set([0]), new Set([0]), start + RELAY.awaySkipMs)).toBeNull();
  });

  it("ends after the last step", () => {
    const st = { ...startGame(newRoom("a"), three(), 0).state, step: 2 };
    const t = tick(st, new Set([0, 1, 2]), none, 5)!;
    expect(t.state).toMatchObject({ phase: "done", deadline: 0 });
  });

  it("fills a missing drawing with an empty one", () => {
    const st = { ...startGame(newRoom("a"), three(), 0).state, step: 1 };
    const t = tick(st, new Set([0, 1]), none, st.deadline + 60_000)!;
    expect(t.fill).toEqual([{ chain: 2, step: 1, author: "", drawing: { w: 0, h: 0, strokes: [] }, auto: true }]);
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
