// /api/room — 이어 그리기 rooms. One POST endpoint, { action, … }:
//
//   create { name }                     → { code, id, token }
//   join   { code, name }               → { code, id, token }       | { error: "nope" | "started" | "full" }
// With { code, id, token } (the player's own credentials):
//   state  { have? }                    → RoomView (polled every 1–2 s)
//   start                               (host, lobby, ≥ minPlayers)
//   submit { step, text? | drawing?, final? }   → RoomView | { error: "text" } (rewrite it)
//   reveal { rv }                       (host: the reveal position everyone follows)
//   chain  { chain }                    → { entries } (reveal / done)
//   carve  { chain, x_mm, y_mm, w_mm, h_mm, image }   (host, done: the chain's drawings → shared wall)
//   again                               (host, done: 한 판 더, same players)
//   leave
//
// The room moves on lazily: every request first settles it (see shared/relay.ts → tick).

import { mockTextFlagged } from "../shared/moderation.ts";
import {
  chainFor, chainStrip, cleanText, fillEntry, newHost, newRoom, normCode, randomCode, RELAY, revealAt, startGame, stepKind, tick, validateDrawing,
  type CarveMark, type Entry, type PlayerRow, type RelayDrawing, type RoomState,
} from "../shared/relay.ts";
import { validateDraft, type CarvingDraft } from "../shared/wall.ts";
import { clientKey, json, pngBase64, readJson, type Env } from "./http.ts";
import { moderatePost, moderateText, qwenConfig } from "./qwen.ts";
import { allow, RateLimiter } from "./rateLimit.ts";
import { roomStore, type RoomRecord, type RoomStore } from "./roomStore.ts";
import { insertCarving, supabaseConf } from "./supabase.ts";

// Several phones of one group often share an IP (site Wi-Fi, carrier NAT): generous limits.
const perMinute = new RateLimiter(900, 60_000);
const creates = new RateLimiter(10, 10 * 60_000);

export interface PlayerView {
  id: string;
  name: string;
  seat: number;
  away: boolean;
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
      const t = tick(next ?? st, done, c.now);
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
  const stepEntries = st.phase === "play" ? await c.store.entries(c.code, st.game, { step: st.step }, false) : [];
  const doneBy = new Set(stepEntries.map((e) => e.author));
  const v: RoomView = {
    code: c.code, me: me.id, now, state: st, store: c.store.kind,
    players: c.players
      .slice()
      .sort((a, b) => (a.seat - b.seat) || (a.joined - b.joined))
      .map((p) => ({ id: p.id, name: p.name, seat: p.seat, away: now - p.seen > RELAY.awayMs, done: doneBy.has(p.id) })),
  };
  if (st.phase === "play" && me.seat >= 0) {
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
  step?: number; text?: string; drawing?: RelayDrawing; final?: boolean; rv?: number; chain?: number;
  x_mm?: number; y_mm?: number; w_mm?: number; h_mm?: number; image?: string;
};

export async function handleRoom(req: Request, env: Env, ip?: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const who = clientKey(req, ip);
  if (!allow(who, perMinute)) return json({ error: "limited" }, 429);
  const b = await readJson<Body>(req, 600_000);
  if (!b || typeof b.action !== "string") return json({ error: "invalid" }, 400);
  const store = roomStore(env);
  const now = Date.now();

  try {
    if (b.action === "create") {
      if (!allow(who, creates)) return json({ error: "limited" }, 429);
      store.cleanup(now - 24 * 3_600_000).catch((err) => console.warn("room cleanup failed", err));
      const me: PlayerRow = { id: id(), token: token(), name: cleanName(b.name, []), seat: -1, joined: now, seen: now };
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

    if (b.action === "join") {
      await settle(c);
      if (c.rec.state.phase !== "lobby") return json({ error: "started" }, 409);
      if (c.players.length >= RELAY.maxPlayers) return json({ error: "full" }, 409);
      const me: PlayerRow = { id: id(), token: token(), name: cleanName(b.name, c.players.map((p) => p.name)), seat: -1, joined: now, seen: now };
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
        if (c.rec.state.phase === "lobby") await store.removePlayer(code, me.id);
        else await store.updatePlayer(code, me.id, { seen: 0 });
        c.players = c.players.filter((p) => p.id !== me.id);
        await settle(c);
        return json({ ok: true });

      case "start": {
        await settle(c);
        const here = c.players.filter((p) => now - p.seen <= RELAY.awayMs || p.id === me.id);
        if (!isHost() || c.rec.state.phase !== "lobby") return json({ error: "state" }, 409);
        if (here.length < RELAY.minPlayers) return json({ error: "few" }, 409);
        const { state, seats } = startGame(c.rec.state, here, now);
        for (const p of c.players) {
          const seat = seats.get(p.id) ?? -1;
          if (seat < 0 && p.id !== me.id) await store.removePlayer(code, p.id); // away in the lobby: not in this game
          else await store.updatePlayer(code, p.id, { seat });
          p.seat = seat;
        }
        c.players = c.players.filter((p) => p.seat >= 0);
        if (!(await update(c, (st) => (st.phase === "lobby" ? state : null)))) return json({ error: "state" }, 409);
        return json(await view(c, me));
      }

      case "submit": {
        const st = c.rec.state;
        if (st.phase !== "play" || me.seat < 0 || b.step !== st.step) {
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

      case "reveal": {
        if (!isHost() || !["reveal", "done"].includes(c.rec.state.phase)) return json({ error: "state" }, 409);
        const rv = Math.round(Number(b.rv));
        if (!Number.isFinite(rv)) return json({ error: "invalid" }, 400);
        await update(c, (st) => {
          const end = st.n * st.n;
          return rv >= end ? { ...st, phase: "done", rv: end - 1 } : { ...st, phase: "reveal", rv: Math.max(0, rv) };
        });
        return json(await view(c, me));
      }

      case "chain": {
        const st = c.rec.state;
        const chain = Number(b.chain);
        if (!["reveal", "done"].includes(st.phase) || !Number.isInteger(chain) || chain < 0 || chain >= st.n) return json({ error: "state" }, 409);
        if (st.phase === "reveal" && chain > revealAt(st)[0]) return json({ error: "state" }, 409);
        const names = new Map(c.players.map((p) => [p.id, p.name]));
        const entries: ChainEntry[] = (await store.entries(code, st.game, { chain }, true)).map((e) => ({ ...e, name: names.get(e.author) ?? "" }));
        return json({ entries });
      }

      case "carve":
        return json(...(await carve(c, env, isHost(), b)));

      case "again": {
        if (!isHost() || c.rec.state.phase !== "done") return json({ error: "state" }, 409);
        for (const p of c.players) await store.updatePlayer(code, p.id, { seat: -1 });
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

/**
 * Carves one chain into the shared wall: its drawings side by side (built here, from the
 * stored entries) at the spot the host's phone found, after moderating the strip image and
 * the chain's texts together. The texts themselves are not stored on the wall.
 */
async function carve(c: Ctx, env: Env, isHost: boolean, b: Body): Promise<[unknown, number?]> {
  const st = c.rec.state;
  const chain = Number(b.chain);
  if (!isHost || st.phase !== "done" || !Number.isInteger(chain) || chain < 0 || chain >= st.n) return [{ error: "state" }, 409];
  if (st.carved[chain]) return [{ ok: false, reason: "done" }];
  const entries = await c.store.entries(c.code, st.game, { chain }, true);
  const strip = chainStrip(entries.flatMap((e) => (e.drawing ? [e.drawing] : [])));
  const mark = (v: CarveMark) => update(c, (s) => (s.carved[chain] ? null : { ...s, carved: { ...s.carved, [chain]: v } }));
  if (!strip) {
    await mark("empty");
    return [{ ok: false, reason: "empty" }];
  }
  const draft: CarvingDraft = {
    x_mm: Number(b.x_mm), y_mm: Number(b.y_mm), w_mm: Number(b.w_mm), h_mm: Number(b.h_mm),
    src_w: strip.w, src_h: strip.h, strokes: strip.strokes, prompt: null, score: null, relay: st.n,
  };
  const bad = validateDraft(draft);
  const png = pngBase64(b.image, 600_000);
  if (bad || !png) return [{ ok: false, reason: "invalid", detail: bad }, 400];

  // Fail closed: the wall is public.
  const texts = entries.filter((e) => e.text && !e.auto).map((e) => e.text!).join(" / ");
  let flagged = mockTextFlagged(texts);
  const ai = qwenConfig(env);
  if (ai && !flagged) {
    try {
      const m = await moderatePost(ai, png, texts);
      flagged = m.flagged || m.message_flagged;
    } catch (err) {
      console.error("chain moderation failed", err);
      return [{ ok: false, reason: "error" }, 502];
    }
  }
  if (flagged) {
    await mark("flagged");
    return [{ ok: false, reason: "flagged" }];
  }
  const db = supabaseConf(env);
  if (!(await mark([draft.x_mm, draft.y_mm, draft.w_mm, draft.h_mm]))) return [{ ok: false, reason: "done" }];
  if (!db) return [{ ok: true, mode: "mock", draft }];
  try {
    return [{ ok: true, mode: "supabase", carving: await insertCarving(db, draft) }];
  } catch (err) {
    console.error(err);
    await update(c, (s) => ({ ...s, carved: Object.fromEntries(Object.entries(s.carved).filter(([k]) => k !== String(chain))) }));
    return [{ ok: false, reason: "error" }, 502];
  }
}
