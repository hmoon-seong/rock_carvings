// /api/room — 이어 그리기 rooms. One POST endpoint, { action, … }:
//
//   create { name }                     → { code, id, token }
//   join   { code, name, watch? }       → { code, id, token }       | { error: "nope" | "started" | "full" }
//          (watch = 관전: allowed at any phase; a player can only join in the lobby)
// With { code, id, token } (the player's own credentials):
//   state  { have? }                    → RoomView (polled every 1–2 s)
//   role   { watch }                    (lobby, not the host: switch between playing and watching)
//   start                               (host, lobby, ≥ minPlayers)
//   submit { step, text? | drawing?, final? }   → RoomView | { error: "text" } (rewrite it)
//   chain  { chain }                    → { entries } (done: everyone; watchers also while playing)
//   again                               (host, done: 한 판 더, same players)
//   leave                               (the last one out deletes the room)
//
// The room moves on lazily: every request first settles it (see shared/relay.ts → tick).
// Every request may also sweep away old and empty rooms (at most once a minute per instance).

import { mockTextFlagged } from "../shared/moderation.ts";
import {
  chainFor, cleanText, fillEntry, newHost, newRoom, normCode, randomCode, RELAY, startGame, stepKind, tick, validateDrawing,
  type Entry, type PlayerRow, type RelayDrawing, type RoomState,
} from "../shared/relay.ts";
import { clientKey, json, readJson, type Env } from "./http.ts";
import { moderateText, qwenConfig } from "./qwen.ts";
import { allow, RateLimiter } from "./rateLimit.ts";
import { roomStore, type RoomRecord, type RoomStore } from "./roomStore.ts";

// Several phones of one group often share an IP (site Wi-Fi, carrier NAT): generous limits.
const perMinute = new RateLimiter(900, 60_000);
const creates = new RateLimiter(10, 10 * 60_000);

let lastSweep = 0;
/** Deletes old and empty rooms, at most once a minute (not awaited: no request waits for it). */
function sweep(store: RoomStore, now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  store.cleanup(now).catch((err) => console.warn("room cleanup failed", err));
}

export interface PlayerView {
  id: string;
  name: string;
  seat: number;
  away: boolean;
  /** 관전 (not in the game). */
  watch: boolean;
  /** Has submitted the current step. */
  done: boolean;
}

export interface Task {
  step: number;
  kind: "write" | "draw" | "guess";
  chain: number;
  done: boolean;
  /** What to draw or guess (omitted when the client already has it: `have`). */
  input?: { key: string; text?: string | null; drawing?: RelayDrawing | null; from: string };
}

export interface RoomView {
  code: string;
  me: string;
  /** Server clock (ms), for the countdown on phones with a wrong clock. */
  now: number;
  state: RoomState;
  players: PlayerView[];
  task?: Task;
  /** "memory" rooms only live in this server process (local development). */
  store: "memory" | "supabase";
}

export interface ChainEntry extends Entry {
  name: string;
}

const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const token = () => crypto.randomUUID().replace(/-/g, "");
const cleanName = (n: unknown, taken: string[]) => {
  let name = cleanText(n, RELAY.nameMax) || `손님${taken.length + 1}`;
  for (let k = 2; taken.includes(name); k++) name = `${cleanText(n, RELAY.nameMax - 2) || "손님"}${k}`;
  return name;
};

interface Ctx {
  store: RoomStore;
  code: string;
  rec: RoomRecord;
  players: PlayerRow[];
  now: number;
}

/**
 * Brings the room up to date: drops players who left the lobby, hands the host role on, and
 * advances a finished or overdue step. Compare-and-set, retried when another request won.
 */
async function settle(c: Ctx): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const st = c.rec.state;
    let next: RoomState | null = null;
    let fill: Entry[] = [];

    if (st.phase === "lobby") {
      const gone = c.players.filter((p) => c.now - p.seen > RELAY.awayMs && p.id !== st.host);
      for (const p of gone) await c.store.removePlayer(c.code, p.id);
      if (gone.length) c.players = c.players.filter((p) => !gone.includes(p));
    }
    const host = newHost(st, c.players, c.now);
    if (host) next = { ...st, host };
    if (st.phase === "play") {
      const done = new Set((await c.store.entries(c.code, st.game, { step: st.step }, false)).map((e) => e.chain));
      const here = new Set(c.players.filter((p) => p.seat >= 0 && !p.watch && c.now - p.seen <= RELAY.awayMs).map((p) => p.seat));
      const away = new Set(Array.from({ length: st.n }, (_, s) => s).filter((s) => !here.has(s)));
      const t = tick(next ?? st, done, away, c.now);
      if (t) {
        next = t.state;
        fill = t.fill;
      }
    }
    if (!next) return;
    if (fill.length) await c.store.addEntries(c.code, st.game, fill);
    if (await c.store.casRoom(c.code, c.rec.version, next)) {
      c.rec = { ...c.rec, state: next, version: c.rec.version + 1 };
      return;
    }
    const fresh = await c.store.getRoom(c.code);
    if (!fresh) return;
    c.rec = fresh;
    c.players = await c.store.players(c.code);
  }
}

/** Changes the room state with compare-and-set; `change` returns null to give up. */
async function update(c: Ctx, change: (st: RoomState) => RoomState | null): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = change(c.rec.state);
    if (!next) return false;
    if (await c.store.casRoom(c.code, c.rec.version, next)) {
      c.rec = { ...c.rec, state: next, version: c.rec.version + 1 };
      return true;
    }
    const fresh = await c.store.getRoom(c.code);
    if (!fresh) return false;
    c.rec = fresh;
  }
  return false;
}

async function view(c: Ctx, me: PlayerRow, have?: string): Promise<RoomView> {
  const st = c.rec.state;
  const now = c.now;
  const playing = st.phase === "play";
  const stepEntries = playing ? await c.store.entries(c.code, st.game, { step: st.step }, false) : [];
  const doneBy = new Set(stepEntries.map((e) => e.author));
  const v: RoomView = {
    code: c.code, me: me.id, now, state: st, store: c.store.kind,
    players: c.players
      .slice()
      .sort((a, b) => Number(a.watch) - Number(b.watch) || (a.seat - b.seat) || (a.joined - b.joined))
      .map((p) => ({ id: p.id, name: p.name, seat: p.seat, watch: p.watch, away: now - p.seen > RELAY.awayMs, done: playing && doneBy.has(p.id) })),
  };
  if (playing && !me.watch && me.seat >= 0) {
    const chain = chainFor(me.seat, st.step, st.n);
    const task: Task = { step: st.step, kind: stepKind(st.step), chain, done: stepEntries.some((e) => e.chain === chain) };
    if (st.step > 0 && !task.done) {
      const key = `${st.game}:${chain}:${st.step - 1}`;
      if (have !== key) {
        const [prev] = await c.store.entries(c.code, st.game, { chain, step: st.step - 1 }, true);
        if (prev) task.input = { key, text: prev.text, drawing: prev.drawing, from: c.players.find((p) => p.id === prev.author)?.name ?? "" };
      } else task.input = { key, from: "" };
    }
    v.task = task;
  }
  return v;
}

/** Text after moderation: the word list, then Qwen (if configured; a failure lets it through, as it is not public). */
async function checkText(env: Env, text: string): Promise<boolean> {
  if (mockTextFlagged(text)) return true;
  const ai = qwenConfig(env);
  if (!ai) return false;
  try {
    return await moderateText(ai, text);
  } catch (err) {
    console.warn("text moderation failed, letting it through", err);
    return false;
  }
}

type Body = {
  action?: string; code?: string; id?: string; token?: string; name?: string; have?: string;
  step?: number; text?: string; drawing?: RelayDrawing; final?: boolean; chain?: number; watch?: boolean;
};

export async function handleRoom(req: Request, env: Env, ip?: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const who = clientKey(req, ip);
  if (!allow(who, perMinute)) return json({ error: "limited" }, 429);
  const b = await readJson<Body>(req, 600_000);
  if (!b || typeof b.action !== "string") return json({ error: "invalid" }, 400);
  const store = roomStore(env);
  const now = Date.now();
  sweep(store, now);

  try {
    if (b.action === "create") {
      if (!allow(who, creates)) return json({ error: "limited" }, 429);
      const me: PlayerRow = { id: id(), token: token(), name: cleanName(b.name, []), seat: -1, joined: now, seen: now, watch: false };
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        if (await store.createRoom(code, newRoom(me.id), now)) {
          await store.addPlayer(code, me);
          return json({ code, id: me.id, token: me.token });
        }
      }
      return json({ error: "busy" }, 503);
    }

    const code = normCode(b.code);
    const rec = code.length === 4 ? await store.getRoom(code) : null;
    if (!rec) return json({ error: "nope" }, 404);
    const c: Ctx = { store, code, rec, players: await store.players(code), now };

    const counts = () => ({ play: c.players.filter((p) => !p.watch).length, watch: c.players.filter((p) => p.watch).length });

    if (b.action === "join") {
      await settle(c);
      const watch = b.watch === true;
      if (!watch && c.rec.state.phase !== "lobby") return json({ error: "started" }, 409);
      if (watch ? counts().watch >= RELAY.maxWatchers : counts().play >= RELAY.maxPlayers) return json({ error: "full" }, 409);
      const me: PlayerRow = { id: id(), token: token(), name: cleanName(b.name, c.players.map((p) => p.name)), seat: -1, joined: now, seen: now, watch };
      await store.addPlayer(code, me);
      return json({ code, id: me.id, token: me.token });
    }

    const me = c.players.find((p) => p.id === b.id && p.token === b.token);
    if (!me) return json({ error: "nope" }, 404);
    if (now - me.seen > 4000) {
      me.seen = now;
      await store.updatePlayer(code, me.id, { seen: now });
    }
    const isHost = () => c.rec.state.host === me.id;

    switch (b.action) {
      case "state":
        await settle(c);
        return json(await view(c, me, b.have));

      case "leave":
        c.players = c.players.filter((p) => p.id !== me.id);
        if (!c.players.some((p) => now - p.seen <= RELAY.emptyMs)) {
          await store.deleteRoom(code); // the last one out: the room is empty
          return json({ ok: true });
        }
        if (c.rec.state.phase === "lobby" || me.watch) await store.removePlayer(code, me.id);
        else await store.updatePlayer(code, me.id, { seen: 0 });
        await settle(c);
        return json({ ok: true });

      case "role": {
        await settle(c);
        const watch = b.watch === true;
        if (c.rec.state.phase !== "lobby" || (watch && isHost())) return json({ error: "state" }, 409);
        if (watch !== me.watch) {
          if (watch ? counts().watch >= RELAY.maxWatchers : counts().play >= RELAY.maxPlayers) return json({ error: "full" }, 409);
          await store.updatePlayer(code, me.id, { watch });
          for (const p of c.players) if (p.id === me.id) p.watch = watch;
          me.watch = watch;
        }
        return json(await view(c, me));
      }

      case "start": {
        await settle(c);
        const here = c.players.filter((p) => !p.watch && (now - p.seen <= RELAY.awayMs || p.id === me.id));
        if (!isHost() || c.rec.state.phase !== "lobby") return json({ error: "state" }, 409);
        if (here.length < RELAY.minPlayers) return json({ error: "few" }, 409);
        const { state, seats } = startGame(c.rec.state, here, now);
        for (const p of c.players) {
          if (p.watch) continue;
          const seat = seats.get(p.id) ?? -1;
          if (seat < 0 && p.id !== me.id) await store.removePlayer(code, p.id); // away in the lobby: not in this game
          else await store.updatePlayer(code, p.id, { seat });
          p.seat = seat;
        }
        c.players = c.players.filter((p) => p.seat >= 0 || p.watch);
        if (!(await update(c, (st) => (st.phase === "lobby" ? state : null)))) return json({ error: "state" }, 409);
        return json(await view(c, me));
      }

      case "submit": {
        const st = c.rec.state;
        if (st.phase !== "play" || me.watch || me.seat < 0 || b.step !== st.step) {
          await settle(c);
          return json(await view(c, me));
        }
        const chain = chainFor(me.seat, st.step, st.n);
        const kind = stepKind(st.step);
        let entry: Entry;
        if (kind === "draw") {
          if (validateDrawing(b.drawing)) return json({ error: "invalid" }, 400);
          const d = b.drawing!;
          entry = d.strokes.length ? { chain, step: st.step, author: me.id, drawing: d } : { ...fillEntry(chain, st.step), author: me.id };
        } else {
          const text = cleanText(b.text);
          if (!text) entry = { ...fillEntry(chain, st.step), author: me.id };
          else if (await checkText(env, text)) {
            // At the deadline there is no time to rewrite it.
            if (!b.final) return json({ error: "text" });
            entry = { ...fillEntry(chain, st.step), author: me.id };
          } else entry = { chain, step: st.step, author: me.id, text };
        }
        await store.addEntries(code, st.game, [entry]);
        await settle(c);
        return json(await view(c, me));
      }

      case "chain": {
        // Players see the chains at the end; watchers, who are not in the game, as they grow.
        await settle(c);
        const st = c.rec.state;
        const chain = Number(b.chain);
        const live = me.watch && st.phase === "play";
        if ((st.phase !== "done" && !live) || !Number.isInteger(chain) || chain < 0 || chain >= st.n) return json({ error: "state" }, 409);
        const names = new Map(c.players.map((p) => [p.id, p.name]));
        const entries: ChainEntry[] = (await store.entries(code, st.game, { chain }, true)).map((e) => ({ ...e, name: names.get(e.author) ?? "" }));
        return json({ entries });
      }

      case "again": {
        if (!isHost() || c.rec.state.phase !== "done") return json({ error: "state" }, 409);
        for (const p of c.players) if (p.seat >= 0) await store.updatePlayer(code, p.id, { seat: -1 });
        await update(c, (st) => (st.phase === "done" ? { ...newRoom(st.host), game: st.game } : null));
        c.players = c.players.map((p) => ({ ...p, seat: -1 }));
        return json(await view(c, { ...me, seat: -1 }));
      }
    }
    return json({ error: "invalid" }, 400);
  } catch (err) {
    console.error("room", err);
    return json({ error: "storage" }, 502);
  }
}
