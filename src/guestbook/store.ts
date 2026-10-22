// The shared wall's storage, seen from the client.
// Remote (Supabase behind /api/wall) when the server has it; otherwise a localStorage wall
// with a few sample carvings ("mock mode"), so the wall works with no accounts at all.

import { mockTextFlagged } from "../../shared/moderation";
import { overlaps, type Carving, type CarvingDraft, type Rect } from "../../shared/wall";
import { API_BASE } from "../challenge/score";
import { SAMPLES } from "./samples";

export type PostResult = { ok: true; carving: Carving } | { ok: false; reason: "flagged" | "message" | "limited" | "invalid" | "error" };
export type WallMode = "remote" | "local";

const LOCAL_KEY = "amgakhwamon.wall.v1";
const MINE_KEY = "amgakhwamon.mine.v1";

function readLocal<T>(key: string, dflt: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return dflt;
  }
}
function writeLocal(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // private mode / full: the carving stays for this session only
  }
}

const isJson = (r: Response) => (r.headers.get("content-type") ?? "").includes("json");

export class Guestbook {
  mode: WallMode | null = null;
  private memory: Carving[] = []; // local carvings if localStorage is unavailable

  private localAll(): Carving[] {
    const saved = readLocal<Carving[]>(LOCAL_KEY, []);
    return [...SAMPLES, ...(Array.isArray(saved) ? saved : []), ...this.memory];
  }

  /** Carvings overlapping `rect` (mm). `rectsOnly` skips the strokes (for finding free spots). */
  async list(rect: Rect, rectsOnly = false): Promise<Carving[]> {
    if (this.mode !== "local") {
      const q = new URLSearchParams({ x: String(rect[0]), y: String(rect[1]), w: String(rect[2]), h: String(rect[3]) });
      if (rectsOnly) q.set("rects", "1");
      let res: Response | null = null;
      try {
        res = await fetch(`${API_BASE}wall?${q}`);
      } catch {
        res = null;
      }
      if (res && res.status !== 404 && isJson(res)) {
        const body = (await res.json()) as { mode?: string; carvings?: Carving[] };
        if (res.ok && body.mode === "supabase" && body.carvings) {
          this.mode = "remote";
          return body.carvings;
        }
        if (!(res.ok && body.mode === "mock")) throw new Error(`wall ${res.status}`);
      } else if (this.mode === "remote") throw new Error("wall unreachable");
      this.mode = "local"; // no proxy, or a proxy without Supabase
    }
    return this.localAll().filter((c) => overlaps([c.x_mm, c.y_mm, c.w_mm, c.h_mm], rect));
  }

  /** Moderates (drawing + message) and stores. The message itself is never stored. */
  async post(draft: CarvingDraft, png: string, message: string): Promise<PostResult> {
    let body: { ok: boolean; mode?: string; reason?: string; carving?: Carving } | null = null;
    try {
      const res = await fetch(`${API_BASE}wall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, image: png, message }),
      });
      if (isJson(res)) body = await res.json();
      else if (res.status !== 404 && !res.ok) return { ok: false, reason: "error" };
    } catch {
      body = null; // no proxy: local mock mode
    }
    if (!body && this.mode === "remote") return { ok: false, reason: "error" };
    if (body && !body.ok) return { ok: false, reason: (body.reason as "error") ?? "error" };
    if (body?.mode === "supabase" && body.carving) {
      this.markMine(body.carving.id);
      return { ok: true, carving: body.carving };
    }
    // Mock mode: the server moderated without storage, or there is no server (word list only).
    if (!body && mockTextFlagged(message)) return { ok: false, reason: "message" };
    return { ok: true, carving: this.saveLocal(draft) };
  }

  /** Keeps a (moderated) carving on this device's wall: mock mode, no shared storage. */
  saveLocal(draft: CarvingDraft): Carving {
    const carving: Carving = { ...draft, id: `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, created_at: new Date().toISOString() };
    const saved = readLocal<Carving[]>(LOCAL_KEY, []);
    const list = Array.isArray(saved) ? saved : [];
    list.push(carving);
    writeLocal(LOCAL_KEY, list);
    if (!readLocal<Carving[] | null>(LOCAL_KEY, null)?.some((c) => c.id === carving.id)) this.memory.push(carving);
    this.markMine(carving.id);
    this.mode ??= "local";
    return carving;
  }

  mine(): Set<string> {
    const ids = readLocal<string[]>(MINE_KEY, []);
    return new Set(Array.isArray(ids) ? ids : []);
  }

  private markMine(id: string) {
    writeLocal(MINE_KEY, [...this.mine(), id].slice(-50));
  }
}
