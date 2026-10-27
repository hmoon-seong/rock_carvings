// Client side of /api/room: the player's credentials (kept on the device so a reload rejoins
// the game) and the polling loop. Polling pauses while the page is hidden.

import { RELAY, type RelayDrawing } from "../../shared/relay";
import type { ChainEntry, RoomView } from "../../server/room";
import { API_BASE } from "../challenge/score";

export type { ChainEntry, RoomView };

export interface Session {
  code: string;
  id: string;
  token: string;
}

const SESSION_KEY = "amgakhwamon.relay.v1";
const NAME_KEY = "amgakhwamon.name.v1";

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // private mode: the session lasts as long as the page
  }
}

export const savedName = () => read<string>(NAME_KEY) ?? "";
export const saveName = (n: string) => write(NAME_KEY, n);

/** A request that reached the server and was refused: `code` is the server's error. */
export class RoomError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class RelayApi {
  session: Session | null = read<Session>(SESSION_KEY);
  /** Server clock − device clock (ms). */
  offset = 0;
  onView: (v: RoomView) => void = () => {};
  /** The room is gone or we are no longer in it. */
  onLost: () => void = () => {};
  /** Polling failed several times in a row (true) or recovered (false). */
  onTrouble: (bad: boolean) => void = () => {};
  /** Input key the client already holds (sent as `have`, so the server skips it). */
  have = "";

  private timer = 0;
  private polling = false;
  private inflight = false;
  private failures = 0;

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.polling) this.pollNow();
    });
  }

  now = () => Date.now() + this.offset;

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}room`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!(res.headers.get("content-type") ?? "").includes("json")) throw new RoomError(res.status === 404 ? "noserver" : "network");
    const out = (await res.json()) as T & { error?: string };
    if (out.error) throw new RoomError(out.error);
    return out;
  }

  private as<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
    const s = this.session;
    if (!s) return Promise.reject(new RoomError("nope"));
    return this.post<T>({ action, code: s.code, id: s.id, token: s.token, ...extra });
  }

  private setSession(s: Session | null) {
    this.session = s;
    write(SESSION_KEY, s);
  }

  async create(name: string) {
    this.setSession(await this.post<Session>({ action: "create", name }));
  }

  /** `watch` = 관전 (the only way into a room that has started). */
  async join(code: string, name: string, watch = false) {
    this.setSession(await this.post<Session>({ action: "join", code, name, watch }));
  }

  /** Fetches the room now (and reports it through onView). */
  async state(): Promise<RoomView> {
    const v = await this.as<RoomView>("state", { have: this.have });
    this.view(v);
    return v;
  }

  private view(v: RoomView) {
    this.offset = v.now - Date.now();
    this.onView(v);
  }

  /** Sends the current step's text or drawing; returns "text" when the text must be rewritten. */
  async submit(step: number, payload: { text?: string; drawing?: RelayDrawing }, final: boolean): Promise<"ok" | "text"> {
    try {
      this.view(await this.as<RoomView>("submit", { step, ...payload, final, have: this.have }));
      return "ok";
    } catch (err) {
      if (err instanceof RoomError && err.code === "text") return "text";
      throw err;
    }
  }

  async act(action: "start" | "again" | "role", extra: Record<string, unknown> = {}) {
    this.view(await this.as<RoomView>(action, extra));
  }

  /** One chain so far (done: everyone; watchers also while playing). */
  chain(chain: number) {
    return this.as<{ entries: ChainEntry[] }>("chain", { chain }).then((r) => r.entries);
  }

  carve(chain: number, rect: [number, number, number, number], image: string) {
    const [x_mm, y_mm, w_mm, h_mm] = rect;
    return this.as<{ ok: boolean; reason?: string; mode?: string; draft?: import("../../shared/wall").CarvingDraft }>("carve", {
      chain, x_mm, y_mm, w_mm, h_mm, image,
    });
  }

  async leave() {
    this.stop();
    const s = this.session;
    this.setSession(null);
    this.have = "";
    if (s) await this.post({ action: "leave", ...s }).catch(() => {});
  }

  // ---- polling
  start() {
    this.polling = true;
    this.pollNow();
  }

  stop() {
    this.polling = false;
    clearTimeout(this.timer);
  }

  pollNow() {
    clearTimeout(this.timer);
    void this.poll();
  }

  private async poll() {
    if (!this.polling || this.inflight) return;
    if (document.hidden) return; // resumes on visibilitychange
    this.inflight = true;
    try {
      await this.state();
      if (this.failures >= 3) this.onTrouble(false);
      this.failures = 0;
    } catch (err) {
      if (err instanceof RoomError && err.code === "nope") {
        this.inflight = false;
        this.stop();
        this.setSession(null);
        this.onLost();
        return;
      }
      if (++this.failures === 3) this.onTrouble(true);
    }
    this.inflight = false;
    if (this.polling) this.timer = window.setTimeout(() => this.poll(), RELAY.pollMs);
  }
}
