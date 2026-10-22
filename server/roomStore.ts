// Storage of 이어 그리기 rooms: in memory (local dev, tests) or Supabase (deployed).
//
// Supabase tables (supabase/relay.sql) are written only by the server with the service-role
// key; row-level security with no policies keeps them closed to the anon key, since player
// rows hold secret tokens. The room state is one JSON value with a version number, so two
// requests that advance the same room at once cannot both win (compare-and-set).
//
// In memory only works while one process serves every request (`npm run dev` / `preview`).
// Netlify functions run as many short-lived instances, so a deployed site needs Supabase.

import type { Entry, PlayerRow, RoomState } from "../shared/relay.ts";
import type { Env } from "./http.ts";
import { projectUrl } from "./supabase.ts";

export interface RoomRecord {
  state: RoomState;
  version: number;
  created: number;
}

export interface RoomStore {
  readonly kind: "memory" | "supabase";
  /** False if the code is taken. */
  createRoom(code: string, state: RoomState, now: number): Promise<boolean>;
  getRoom(code: string): Promise<RoomRecord | null>;
  /** Writes `state` only if the room is still at `version`; false if someone else won. */
  casRoom(code: string, version: number, state: RoomState): Promise<boolean>;
  players(code: string): Promise<PlayerRow[]>;
  addPlayer(code: string, p: PlayerRow): Promise<void>;
  updatePlayer(code: string, id: string, patch: Partial<Pick<PlayerRow, "seat" | "seen" | "name">>): Promise<void>;
  removePlayer(code: string, id: string): Promise<void>;
  /** Entries of the current game, optionally of one step or one chain. `full` = with text and drawing. */
  entries(code: string, game: number, q: { step?: number; chain?: number }, full: boolean): Promise<Entry[]>;
  /** Inserts entries; an entry that already exists (same chain + step) is kept. */
  addEntries(code: string, game: number, list: Entry[]): Promise<void>;
  /** Deletes rooms (with their players and entries) created before `before` (ms). */
  cleanup(before: number): Promise<void>;
}

// ---------------------------------------------------------------- memory

interface MemRoom extends RoomRecord {
  players: PlayerRow[];
  entries: Map<string, Entry & { game: number }>;
}

export class MemoryRoomStore implements RoomStore {
  readonly kind = "memory";
  private rooms = new Map<string, MemRoom>();

  async createRoom(code: string, state: RoomState, now: number) {
    if (this.rooms.has(code)) return false;
    this.rooms.set(code, { state: structuredClone(state), version: 0, created: now, players: [], entries: new Map() });
    return true;
  }
  async getRoom(code: string) {
    const r = this.rooms.get(code);
    return r ? { state: structuredClone(r.state), version: r.version, created: r.created } : null;
  }
  async casRoom(code: string, version: number, state: RoomState) {
    const r = this.rooms.get(code);
    if (!r || r.version !== version) return false;
    r.state = structuredClone(state);
    r.version++;
    return true;
  }
  async players(code: string) {
    return (this.rooms.get(code)?.players ?? []).map((p) => ({ ...p }));
  }
  async addPlayer(code: string, p: PlayerRow) {
    this.rooms.get(code)?.players.push({ ...p });
  }
  async updatePlayer(code: string, id: string, patch: Partial<PlayerRow>) {
    const p = this.rooms.get(code)?.players.find((p) => p.id === id);
    if (p) Object.assign(p, patch);
  }
  async removePlayer(code: string, id: string) {
    const r = this.rooms.get(code);
    if (r) r.players = r.players.filter((p) => p.id !== id);
  }
  async entries(code: string, game: number, q: { step?: number; chain?: number }, full: boolean) {
    const r = this.rooms.get(code);
    if (!r) return [];
    return [...r.entries.values()]
      .filter((e) => e.game === game && (q.step == null || e.step === q.step) && (q.chain == null || e.chain === q.chain))
      .sort((a, b) => a.chain - b.chain || a.step - b.step)
      .map(({ game: _g, ...e }) => (full ? structuredClone(e) : { chain: e.chain, step: e.step, author: e.author, auto: e.auto }));
  }
  async addEntries(code: string, game: number, list: Entry[]) {
    const r = this.rooms.get(code);
    if (!r) return;
    for (const e of list) {
      const key = `${game}:${e.chain}:${e.step}`;
      if (!r.entries.has(key)) r.entries.set(key, { ...structuredClone(e), game });
    }
  }
  async cleanup(before: number) {
    for (const [code, r] of this.rooms) if (r.created < before) this.rooms.delete(code);
  }
}

// ---------------------------------------------------------------- Supabase (PostgREST)

interface Conf {
  url: string;
  key: string;
}

export class SupabaseRoomStore implements RoomStore {
  readonly kind = "supabase";
  private c: Conf;

  constructor(c: Conf) {
    this.c = c;
  }

  private async req(path: string, init: RequestInit & { prefer?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: this.c.key, authorization: `Bearer ${this.c.key}`, "content-type": "application/json",
    };
    if (init.prefer) headers.prefer = init.prefer;
    const res = await fetch(`${this.c.url}/rest/v1/${path}`, { ...init, headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`supabase ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async createRoom(code: string, state: RoomState) {
    try {
      await this.req("relay_rooms", { method: "POST", body: JSON.stringify({ code, state, version: 0 }) });
      return true;
    } catch (err) {
      if (String(err).includes(" 409")) return false; // duplicate code
      throw err;
    }
  }
  async getRoom(code: string) {
    const rows = (await this.req(`relay_rooms?code=eq.${code}&select=state,version,created_at`)) as { state: RoomState; version: number; created_at: string }[];
    const r = rows[0];
    return r ? { state: r.state, version: r.version, created: Date.parse(r.created_at) } : null;
  }
  async casRoom(code: string, version: number, state: RoomState) {
    const rows = (await this.req(`relay_rooms?code=eq.${code}&version=eq.${version}`, {
      method: "PATCH", prefer: "return=representation", body: JSON.stringify({ state, version: version + 1 }),
    })) as unknown[];
    return rows.length === 1;
  }
  async players(code: string) {
    return (await this.req(`relay_players?room=eq.${code}&select=id,token,name,seat,joined,seen&order=joined`)) as PlayerRow[];
  }
  async addPlayer(code: string, p: PlayerRow) {
    await this.req("relay_players", { method: "POST", body: JSON.stringify({ room: code, ...p }) });
  }
  async updatePlayer(code: string, id: string, patch: Partial<PlayerRow>) {
    await this.req(`relay_players?room=eq.${code}&id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }
  async removePlayer(code: string, id: string) {
    await this.req(`relay_players?room=eq.${code}&id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async entries(code: string, game: number, q: { step?: number; chain?: number }, full: boolean) {
    const cols = full ? "chain,step,author,text,drawing,auto" : "chain,step,author,auto";
    let path = `relay_entries?room=eq.${code}&game=eq.${game}&select=${cols}&order=chain,step`;
    if (q.step != null) path += `&step=eq.${q.step}`;
    if (q.chain != null) path += `&chain=eq.${q.chain}`;
    return (await this.req(path)) as Entry[];
  }
  async addEntries(code: string, game: number, list: Entry[]) {
    if (!list.length) return;
    const rows = list.map((e) => ({
      room: code, game, chain: e.chain, step: e.step, author: e.author, text: e.text ?? null, drawing: e.drawing ?? null, auto: e.auto ?? false,
    }));
    await this.req("relay_entries?on_conflict=room,game,chain,step", { method: "POST", prefer: "resolution=ignore-duplicates", body: JSON.stringify(rows) });
  }
  async cleanup(before: number) {
    await this.req(`relay_rooms?created_at=lt.${new Date(before).toISOString()}`, { method: "DELETE" });
  }
}

let memory: MemoryRoomStore | null = null;

/** Supabase with the service-role key when configured, else the process's memory. */
export function roomStore(env: Env): RoomStore {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return new SupabaseRoomStore({ url: projectUrl(url), key });
  return (memory ??= new MemoryRoomStore());
}
