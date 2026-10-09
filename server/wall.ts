// /api/wall — the shared rock wall (guestbook).
//
// GET  ?x=&y=&w=&h=[&rects=1]     → { mode: "supabase", carvings } or { mode: "mock" }
// POST { draft, image, message }  → moderation (drawing + message), then insert.
//      → { ok: true, mode: "supabase", carving } | { ok: true, mode: "mock" }   (mock: the client stores it locally)
//      → { ok: false, reason: "flagged" | "message" | "limited" | "invalid" | "error" }
//
// The message is only moderated, never stored.

import { mockTextFlagged, MESSAGE_MAX } from "../shared/moderation.ts";
import { validateDraft, type CarvingDraft, type Rect } from "../shared/wall.ts";
import { moderatePost, type Moderation } from "./claude.ts";
import { clientKey, json, pngBase64, readJson, type Env } from "./http.ts";
import { allow, RateLimiter } from "./rateLimit.ts";
import { ALL_COLUMNS, insertCarving, listCarvings, RECT_COLUMNS, supabaseConf } from "./supabase.ts";

const readLimit = new RateLimiter(120, 60_000);
const postShort = new RateLimiter(3, 10 * 60_000);
const postDay = new RateLimiter(20, 24 * 3_600_000);

export async function handleWall(req: Request, env: Env, ip?: string): Promise<Response> {
  const who = clientKey(req, ip);
  const db = supabaseConf(env);

  if (req.method === "GET") {
    if (!db) return json({ mode: "mock" });
    if (!allow(who, readLimit)) return json({ error: "limited" }, 429);
    const q = new URL(req.url).searchParams;
    const n = (k: string, d: number) => (Number.isFinite(+(q.get(k) ?? "x")) ? +q.get(k)! : d);
    const rect: Rect = [n("x", 0), n("y", 0), n("w", 1e6), n("h", 1e6)];
    const rects = q.get("rects") === "1";
    try {
      const carvings = await listCarvings(db, rect, rects ? RECT_COLUMNS : ALL_COLUMNS, rects ? 2000 : 300);
      return json({ mode: "supabase", carvings });
    } catch (err) {
      console.error(err);
      return json({ error: "storage" }, 502);
    }
  }

  if (req.method !== "POST") return json({ error: "method" }, 405);
  const body = await readJson<{ draft?: CarvingDraft; image?: string; message?: string }>(req, 900_000);
  const png = pngBase64(body?.image);
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, MESSAGE_MAX) : "";
  if (!body || !png || validateDraft(body.draft)) return json({ ok: false, reason: "invalid", detail: body && validateDraft(body.draft) }, 400);
  if (!allow(who, postShort, postDay)) return json({ ok: false, reason: "limited" }, 429);

  // Moderation. Without an API key only the message gets the small word list; if the AI
  // check itself fails, nothing is stored (fail closed: this wall is public).
  let mod: Moderation = { flagged: false, message_flagged: mockTextFlagged(message) };
  if (env.ANTHROPIC_API_KEY) {
    try {
      mod = await moderatePost(env.ANTHROPIC_API_KEY, png, message);
      mod.message_flagged ||= mockTextFlagged(message);
    } catch (err) {
      console.error("moderation failed", err);
      return json({ ok: false, reason: "error" }, 502);
    }
  }
  if (mod.flagged) return json({ ok: false, reason: "flagged" });
  if (mod.message_flagged) return json({ ok: false, reason: "message" });

  if (!db) return json({ ok: true, mode: "mock", moderated: Boolean(env.ANTHROPIC_API_KEY) });
  try {
    const carving = await insertCarving(db, body.draft!);
    return json({ ok: true, mode: "supabase", carving });
  } catch (err) {
    console.error(err);
    return json({ ok: false, reason: "error" }, 502);
  }
}
