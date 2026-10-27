// 이어 그리기 (a Gartic Phone-style relay): the rules, shared by the server and the client.
//
// N players, N chains, N steps. Each player starts one chain by writing a prompt (step 0);
// then the chains move one seat on per step, alternating 새기기 (draw the text you got) and
// 맞히기 (guess the drawing you got). At step s, chain c is with seat (c + s) mod N, so nobody
// sees their own chain again until the end, where everyone gets the album of their own chain.
// Watchers (관전) are in the room but not in the game; they follow the chains as they grow.
//
// The server is the only writer of the room state. It has no timers: every request runs
// `tick()`, which moves to the next step once everyone has submitted, the deadline (plus a
// grace period for the auto-submit to arrive) has passed, or everyone still missing is away,
// filling in for absent players.

import { MOTIFS } from "./challenge.ts";
import { fitPoints, LIMITS, validateStrokes, type Rect, type WallStroke } from "./wall.ts";

export const RELAY = {
  minPlayers: 3,
  maxPlayers: 8,
  /** Seconds per step kind. */
  seconds: { write: 40, draw: 60, guess: 30 } as Record<StepKind, number>,
  /** Extra seconds before a new step's clock starts (time to load it on every phone). */
  leadSeconds: 2,
  /** After the deadline, wait this long for the clients' auto-submits. */
  graceSeconds: 5,
  /** Prompt / guess length (characters). */
  textMax: 40,
  nameMax: 10,
  /** Polling interval of the clients (ms). */
  pollMs: 2000,
  /** A player not heard from for this long is "away" (and dropped while in the lobby). */
  awayMs: 20_000,
  /** When everyone still missing is away, the step is filled in after this long (they may come back). */
  awaySkipMs: 15_000,
  /** Watchers per room (not counted in min / maxPlayers). */
  maxWatchers: 20,
  /** A room nobody (players or watchers) has been heard from for this long is deleted. */
  emptyMs: 120_000,
  /** Rooms are kept at least this long after creation (the creator is added just after). */
  newRoomMs: 60_000,
  /** One drawing of a chain fits in this box on the wall (mm); the strip keeps this gap. */
  stripCell: 600,
  stripGap: 100,
};

export type Phase = "lobby" | "play" | "done";
export type StepKind = "write" | "draw" | "guess";

export const stepKind = (step: number): StepKind => (step === 0 ? "write" : step % 2 ? "draw" : "guess");
/** Seat that works on `chain` at `step`. */
export const seatFor = (chain: number, step: number, n: number) => (chain + step) % n;
/** Chain that `seat` works on at `step` (at step 0, seat s starts chain s). */
export const chainFor = (seat: number, step: number, n: number) => (((seat - step) % n) + n) % n;

/** A drawing in its own frame: strokes in mm of a w × h box (like a wall row's stroke frame). */
export interface RelayDrawing {
  w: number;
  h: number;
  strokes: WallStroke[];
}

export interface Entry {
  chain: number;
  step: number;
  /** Player id (empty for a filled-in entry). */
  author: string;
  text?: string | null;
  drawing?: RelayDrawing | null;
  /** Filled in by the server (absent player) or auto-submitted empty. */
  auto?: boolean;
}

export type CarveMark = Rect | "flagged" | "empty";

export interface RoomState {
  phase: Phase;
  /** Current step while playing. */
  step: number;
  /** Number of players (= chains = steps), fixed at the start. */
  n: number;
  /** End of the current step (ms epoch); 0 outside play. */
  deadline: number;
  host: string;
  /** Chains sent to the shared wall: chain → where it was carved (mm), or why not. */
  carved: Record<number, CarveMark>;
  /** Bumped by 한 판 더, so old entries / submits never mix with a new game. */
  game: number;
}

export interface PlayerRow {
  id: string;
  /** Secret: proves a request comes from this player. Never sent to other players. */
  token: string;
  name: string;
  /** −1 until the game starts (and always for watchers). */
  seat: number;
  joined: number;
  seen: number;
  /** 관전: in the room, but not in the game. */
  watch: boolean;
}

export function newRoom(host: string): RoomState {
  return { phase: "lobby", step: 0, n: 0, deadline: 0, host, carved: {}, game: 0 };
}

/** Room codes: 4 letters without look-alikes (I, O, L…). */
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
export function randomCode(rnd: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_LETTERS[Math.floor(rnd() * CODE_LETTERS.length)];
  return s;
}
export const normCode = (c: unknown) => (typeof c === "string" ? c.trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) : "");

/** One line of text: no control characters, single spaces, at most `max` characters. */
export function cleanText(t: unknown, max: number = RELAY.textMax): string {
  if (typeof t !== "string") return "";
  const s = t.replace(/[\x00-\x1f\x7f\u{200b}-\u{200f}\u{2028}-\u{202e}]/gu, " ").replace(/\s+/g, " ").trim();
  return [...s].slice(0, max).join("");
}

const stepMs = (step: number) => (RELAY.leadSeconds + RELAY.seconds[stepKind(step)]) * 1000;
const deadlineFor = (step: number, now: number) => now + stepMs(step);

/** Starts the game: seats in a random order, step 0. Returns the seat of each player id. */
export function startGame(st: RoomState, players: readonly PlayerRow[], now: number, rnd: () => number = Math.random) {
  const order = players.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const seats = new Map(order.map((id, i) => [id, i]));
  const state: RoomState = { ...st, phase: "play", step: 0, n: order.length, deadline: deadlineFor(0, now), carved: {}, game: st.game + 1 };
  return { state, seats };
}

/** What an absent player's entry becomes. */
export function fillEntry(chain: number, step: number, rnd: () => number = Math.random): Entry {
  const kind = stepKind(step);
  if (kind === "write") return { chain, step, author: "", text: MOTIFS[Math.floor(rnd() * MOTIFS.length)].label, auto: true };
  if (kind === "draw") return { chain, step, author: "", drawing: { w: 0, h: 0, strokes: [] }, auto: true };
  return { chain, step, author: "", text: "???", auto: true };
}

/**
 * Advances a playing room if the current step is complete, overdue, or everyone still missing
 * is away (for awaySkipMs into the step). `done` = chains that have an entry for the current
 * step; `away` = seats whose player is away. Returns the new state and the entries to fill in.
 */
export function tick(st: RoomState, done: ReadonlySet<number>, away: ReadonlySet<number>, now: number, rnd: () => number = Math.random) {
  if (st.phase !== "play") return null;
  const missing = Array.from({ length: st.n }, (_, c) => c).filter((c) => !done.has(c));
  const overdue = now > st.deadline + RELAY.graceSeconds * 1000;
  const allAway = missing.length > 0 && missing.every((c) => away.has(seatFor(c, st.step, st.n)));
  const skip = allAway && now >= st.deadline - stepMs(st.step) + RELAY.awaySkipMs;
  if (missing.length && !overdue && !skip) return null;
  const fill = missing.map((c) => fillEntry(c, st.step, rnd));
  const next = st.step + 1;
  const state: RoomState = next < st.n ? { ...st, step: next, deadline: deadlineFor(next, now) } : { ...st, phase: "done", deadline: 0 };
  return { state, fill };
}

/** If the host has gone away, the earliest-joined present player (not a watcher) becomes host. */
export function newHost(st: RoomState, players: readonly PlayerRow[], now: number): string | null {
  const here = (p: PlayerRow) => now - p.seen < RELAY.awayMs;
  const host = players.find((p) => p.id === st.host);
  if (host && !host.watch && here(host)) return null;
  const next = players.filter((p) => here(p) && !p.watch).sort((a, b) => a.joined - b.joined)[0];
  return next && next.id !== st.host ? next.id : null;
}

/** Checks a submitted drawing (may be empty). */
export function validateDrawing(d: unknown): string | null {
  const o = d as RelayDrawing;
  if (!o || typeof o !== "object") return "drawing";
  if (typeof o.w !== "number" || typeof o.h !== "number" || !(o.w >= 0 && o.w <= 2000 && o.h >= 0 && o.h <= 2000)) return "size";
  if (!Array.isArray(o.strokes)) return "strokes";
  if (o.strokes.length && (o.w < 1 || o.h < 1)) return "size";
  return validateStrokes(o.strokes);
}

const r05 = (v: number) => Math.round(v * 2) / 2;

/**
 * A story's drawings side by side in one stroke frame (for the shared wall): each drawing is
 * scaled down to fit the strip cell, vertically centred, in step order. Null if all are empty.
 * (A strip holds at most maxPlayers / 2 = 4 drawings: up to 4 × LIMITS.maxStrokes strokes.)
 */
export function chainStrip(drawings: readonly RelayDrawing[]): RelayDrawing | null {
  const cell = RELAY.stripCell, gap = RELAY.stripGap;
  const parts = drawings.filter((d) => d.strokes.length && d.w > 0 && d.h > 0);
  if (!parts.length) return null;
  const sized = parts.map((d) => ({ d, k: Math.min(1, cell / Math.max(d.w, d.h)) }));
  const h = Math.max(LIMITS.minSize, ...sized.map(({ d, k }) => d.h * k));
  const strokes: WallStroke[] = [];
  let x = 0;
  for (const { d, k } of sized) {
    const oy = (h - d.h * k) / 2;
    for (const s of d.strokes) {
      const p = s.p.map((v, i) => r05(i % 2 ? oy + v * k : x + v * k));
      strokes.push({ c: s.c, s: Math.max(1, r05(s.s * k)), seed: s.seed, p });
    }
    x += d.w * k + gap;
  }
  const w = Math.max(LIMITS.minSize, x - gap);
  return { w, h, strokes: fitPoints(strokes) };
}
