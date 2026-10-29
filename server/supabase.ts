// The carvings table through Supabase's REST API (PostgREST), with the anon key.
// Row-level security allows anonymous select + insert only (supabase/schema.sql).

import { overlaps, rectOf, WALL_MAX, type Carving, type CarvingDraft, type Rect } from "../shared/wall.ts";
import type { Env } from "./http.ts";

export interface SupabaseConf {
  url: string;
  key: string;
}

/** The project URL, also when it was pasted as the REST endpoint (https://<ref>.supabase.co/rest/v1/). */
export const projectUrl = (u: string) => u.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");

export function supabaseConf(env: Env): SupabaseConf | null {
  const url = env.SUPABASE_URL, key = env.SUPABASE_ANON_KEY;
  return url && key ? { url: projectUrl(url), key } : null;
}

const headers = (c: SupabaseConf) => ({ apikey: c.key, authorization: `Bearer ${c.key}`, "content-type": "application/json" });

export const RECT_COLUMNS = "id,x_mm,y_mm,w_mm,h_mm";
export const ALL_COLUMNS = "id,created_at,x_mm,y_mm,w_mm,h_mm,src_w,src_h,strokes,prompt,score,relay";

/**
 * Carvings overlapping the rectangle (newest first), among the WALL_MAX newest on the whole
 * wall: the schema's trigger deletes older rows, and this keeps the same rule if it is missing.
 */
export async function listCarvings(c: SupabaseConf, [x, y, w, h]: Rect, columns: string): Promise<Carving[]> {
  const q = new URLSearchParams({ select: columns, order: "created_at.desc", limit: String(WALL_MAX) });
  const res = await fetch(`${c.url}/rest/v1/carvings?${q}`, { headers: headers(c) });
  if (!res.ok) throw new Error(`supabase list ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Carving[];
  // Only the ones in view go to the phone.
  return rows.filter((r) => overlaps(rectOf(r), [x, y, w, h]));
}

export async function insertCarving(c: SupabaseConf, d: CarvingDraft): Promise<Carving> {
  const row = {
    x_mm: d.x_mm, y_mm: d.y_mm, w_mm: d.w_mm, h_mm: d.h_mm, src_w: d.src_w, src_h: d.src_h,
    strokes: d.strokes, prompt: d.prompt ?? null, score: d.score ?? null,
  };
  const res = await fetch(`${c.url}/rest/v1/carvings?select=${ALL_COLUMNS}`, {
    method: "POST",
    headers: { ...headers(c), prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase insert ${res.status}: ${await res.text()}`);
  return ((await res.json()) as Carving[])[0];
}
