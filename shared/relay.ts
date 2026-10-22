// 이어 그리기 (a Gartic Phone-style relay): the rules, shared by the server and the client.
//
// N players, N chains, N steps. Each player starts one chain by writing a prompt (step 0);
// then the chains move one seat on per step, alternating 새기기 (draw the text you got) and
// 맞히기 (guess the drawing you got). At step s, chain c is with seat (c + s) mod N, so nobody
// sees their own chain again until the reveal (돌려 보기).
//
// The server is the only writer of the room state. It has no timers: every request runs
// `tick()`, which moves to the next step once everyone has submitted or the deadline (plus a
// grace period for the auto-submit to arrive) has passed, filling in for absent players.

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
  /** Polling interval of the clients (ms); faster during the reveal, which the host drives. */
  pollMs: 2000,
  revealPollMs: 1000,
  /** A player not heard from for this long is "away" (and dropped while in the lobby). */
  awayMs: 20_000,
  /** One drawing of a chain fits in this box on the wall (mm); the strip keeps this gap. */
  stripCell: 600,
  stripGap: 100,
};

export type Phase = "lobby" | "play" | "reveal" | "done";
export type StepKind = "write" | "draw" | "guess";

export const stepKind = (step: number): StepKind => (step === 0 ? "write" : step % 2 ? "draw" : "guess");
/** Seat that works on `chain` at `step`. */
export const seatFor = (chain: number, step: number, n: number) => (chain + step) % n;
/** Chain that `seat` works on at `step`. */
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
  /** Reveal position: chain = floor(rv / n), step = rv % n. */
  rv: number;
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
  /** −1 until the game starts. */
  seat: number;
  joined: number;
  seen: number;
}

export function newRoom(host: string): RoomState {
  return { phase: "lobby", step: 0, n: 0, deadline: 0, host, rv: 0, carved: {}, game: 0 };
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

const deadlineFor = (step: number, now: number) => now + (RELAY.leadSeconds + RELAY.seconds[stepKind(step)]) * 1000;

/** Starts the game: seats in a random order, step 0. Returns the seat of each player id. */
export function startGame(st: RoomState, players: readonly PlayerRow[], now: number, rnd: () => number = Math.random) {
  const order = players.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const seats = new Map(order.map((id, i) => [id, i]));
  const state: RoomState = { ...st, phase: "play", step: 0, n: order.length, deadline: deadlineFor(0, now), rv: 0, carved: {}, game: st.game + 1 };
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
 * Advances a playing room if the current step is complete or overdue. `done` = chains that have
 * an entry for the current step. Returns the new state and the entries to fill in, or null.
 */
export function tick(st: RoomState, done: ReadonlySet<number>, now: number, rnd: () => number = Math.random) {
  if (st.phase !== "play") return null;
  const overdue = now > st.deadline + RELAY.graceSeconds * 1000;
  if (done.size < st.n && !overdue) return null;
  const fill: Entry[] = [];
  for (let c = 0; c < st.n; c++) if (!done.has(c)) fill.push(fillEntry(c, st.step, rnd));
  const next = st.step + 1;
  const state: RoomState =
    next < st.n ? { ...st, step: next, deadline: deadlineFor(next, now) } : { ...st, phase: "reveal", deadline: 0, rv: 0 };
  return { state, fill };
}

/** If the host has gone away, the earliest-joined present player becomes host (else null). */
export function newHost(st: RoomState, players: readonly PlayerRow[], now: number): string | null {
  const here = (p: PlayerRow) => now - p.seen < RELAY.awayMs;
  const host = players.find((p) => p.id === st.host);
  if (host && here(host)) return null;
  const next = players.filter(here).sort((a, b) => a.joined - b.joined)[0];
  return next && next.id !== st.host ? next.id : null;
}

/** The reveal position as [chain, step]. */
export const revealAt = (st: RoomState): [number, number] => [Math.floor(st.rv / st.n), st.rv % st.n];

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
 * A chain's drawings side by side in one stroke frame (for the shared wall): each drawing is
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
