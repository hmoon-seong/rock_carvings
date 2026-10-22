// The carvings table through Supabase's REST API (PostgREST), with the anon key.
// Row-level security allows anonymous select + insert only (supabase/schema.sql).

import { LIMITS, overlaps, rectOf, type Carving, type CarvingDraft, type Rect } from "../shared/wall.ts";
import type { Env } from "./http.ts";

export interface SupabaseConf {
  url: string;
  key: string;
}

export function supabaseConf(env: Env): SupabaseConf | null {
  const url = env.SUPABASE_URL, key = env.SUPABASE_ANON_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

const headers = (c: SupabaseConf) => ({ apikey: c.key, authorization: `Bearer ${c.key}`, "content-type": "application/json" });

export const RECT_COLUMNS = "id,x_mm,y_mm,w_mm,h_mm";
export const ALL_COLUMNS = "id,created_at,x_mm,y_mm,w_mm,h_mm,src_w,src_h,strokes,prompt,score,relay";

/** Carvings overlapping the rectangle (newest first). */
export async function listCarvings(c: SupabaseConf, [x, y, w, h]: Rect, columns: string, limit: number): Promise<Carving[]> {
  const q = new URLSearchParams({ select: columns, order: "created_at.desc", limit: String(limit) });
  q.append("x_mm", `lt.${x + w}`);
  q.append("x_mm", `gt.${x - LIMITS.maxSize}`);
  q.append("y_mm", `lt.${y + h}`);
  q.append("y_mm", `gt.${y - LIMITS.maxSize}`);
  const res = await fetch(`${c.url}/rest/v1/carvings?${q}`, { headers: headers(c) });
  if (!res.ok) throw new Error(`supabase list ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Carving[];
  // Exact overlap test (the query only bounds the start corner).
  return rows.filter((r) => overlaps(rectOf(r), [x, y, w, h]));
}

export async function insertCarving(c: SupabaseConf, d: CarvingDraft): Promise<Carving> {
  const row = {
    x_mm: d.x_mm, y_mm: d.y_mm, w_mm: d.w_mm, h_mm: d.h_mm, src_w: d.src_w, src_h: d.src_h,
    strokes: d.strokes, prompt: d.prompt ?? null, score: d.score ?? null, relay: d.relay ?? null,
  };
  const res = await fetch(`${c.url}/rest/v1/carvings?select=${ALL_COLUMNS}`, {
    method: "POST",
    headers: { ...headers(c), prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase insert ${res.status}: ${await res.text()}`);
  return ((await res.json()) as Carving[])[0];
}
