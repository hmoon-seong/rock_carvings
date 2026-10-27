// 이어 그리기 (a Gartic Phone-style relay): the rules, shared by the server and the client.
//
// One story per game, passed along like the original telephone game: one player writes the
// sentence (step 0), then each player in turn gets only the previous step and either draws it
// (새기기) or guesses the drawing (맞히기). Seat s plays step s, so N players make N steps and
// everyone plays exactly once. The writer rotates: each 한 판 더 the next player who has not
// written yet gets seat 0. Players waiting for their turn see nothing of the story (no
// spoilers); watchers (관전), who are not in the story, see each step as it is submitted.
//
// The server is the only writer of the room state. It has no timers: every request runs
// `tick()`, which moves to the next step once the step's player has submitted, the deadline
// (plus a grace period for the auto-submit to arrive) has passed, or the player is away.

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
  /** A step whose player is away is filled in after this long (they may still come back). */
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

export type Phase = "lobby" | "play" | "reveal" | "done";
export type StepKind = "write" | "draw" | "guess";

export const stepKind = (step: number): StepKind => (step === 0 ? "write" : step % 2 ? "draw" : "guess");
/** The one story of a game is chain 0 (entries keep the chain column for storage). */
export const CHAIN = 0;

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
  /** Current step while playing (= the seat whose turn it is). */
  step: number;
  /** Number of players (= steps), fixed at the start. */
  n: number;
  /** End of the current step (ms epoch); 0 outside play. */
  deadline: number;
  host: string;
  /** Reveal position: the step being shown. */
  rv: number;
  /** The story sent to the shared wall: chain → where it was carved (mm), or why not. */
  carved: Record<number, CarveMark>;
  /** Bumped by 한 판 더, so old entries / submits never mix with a new game. */
  game: number;
  /** Players who wrote the sentence in earlier games, oldest first (the writer rotates). */
  writers: string[];
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
  return { phase: "lobby", step: 0, n: 0, deadline: 0, host, rv: 0, carved: {}, game: 0, writers: [] };
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

/**
 * Starts the game. Seat 0 (the writer) is the earliest-joined player who has not written yet
 * (when everyone has, the rotation starts over); the other seats are in a random order.
 * `players` are the players taking part (not watchers). Returns the seat of each player id.
 */
export function startGame(st: RoomState, players: readonly PlayerRow[], now: number, rnd: () => number = Math.random) {
  const byJoin = players.slice().sort((a, b) => a.joined - b.joined);
  const fresh = byJoin.filter((p) => !(st.writers ?? []).includes(p.id));
  const writer = (fresh[0] ?? byJoin[0]).id;
  const writers = fresh.length ? [...(st.writers ?? []), writer] : [writer];
  const order = byJoin.map((p) => p.id).filter((id) => id !== writer);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.unshift(writer);
  const seats = new Map(order.map((id, i) => [id, i]));
  const state: RoomState = {
    ...st, phase: "play", step: 0, n: order.length, deadline: deadlineFor(0, now), rv: 0, carved: {}, game: st.game + 1, writers,
  };
  return { state, seats };
}

/** What an absent player's entry becomes. */
export function fillEntry(step: number, rnd: () => number = Math.random): Entry {
  const kind = stepKind(step);
  if (kind === "write") return { chain: CHAIN, step, author: "", text: MOTIFS[Math.floor(rnd() * MOTIFS.length)].label, auto: true };
  if (kind === "draw") return { chain: CHAIN, step, author: "", drawing: { w: 0, h: 0, strokes: [] }, auto: true };
  return { chain: CHAIN, step, author: "", text: "???", auto: true };
}

/**
 * Advances a playing room if the current step is done, overdue, or its player is away (for
 * awaySkipMs into the step). Returns the new state and the entry to fill in, or null.
 */
export function tick(st: RoomState, done: boolean, away: boolean, now: number, rnd: () => number = Math.random) {
  if (st.phase !== "play") return null;
  const overdue = now > st.deadline + RELAY.graceSeconds * 1000;
  const skip = away && now >= st.deadline - stepMs(st.step) + RELAY.awaySkipMs;
  if (!done && !overdue && !skip) return null;
  const fill = done ? null : fillEntry(st.step, rnd);
  const next = st.step + 1;
  const state: RoomState =
    next < st.n ? { ...st, step: next, deadline: deadlineFor(next, now) } : { ...st, phase: "reveal", deadline: 0, rv: 0 };
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
