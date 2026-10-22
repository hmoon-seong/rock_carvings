// Shared wall rows. A carving is stored as its strokes (not pixels), so it is rebuilt at
// render time and its look can be retuned later. The visitor's message is never stored.

export interface WallStroke {
  c: number; // palette index, or -1 = eraser
  s: number; // brush diameter, mm (in the stroke frame)
  seed: number;
  p: number[]; // flat [x0, y0, x1, y1, …] mm in the stroke frame, 0.5 mm steps
}

export interface CarvingDraft {
  /** Where it sits on the wall, mm, origin top-left. */
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  /** Size of the stroke frame in mm; scale on the wall = w_mm / src_w. */
  src_w: number;
  src_h: number;
  strokes: WallStroke[];
  prompt?: string | null;
  score?: number | null;
  /** 이어 그리기: a chain's drawings in a row; the number of players (null otherwise). */
  relay?: number | null;
}

export interface Carving extends CarvingDraft {
  id: string;
  created_at: string;
}

export type Rect = [number, number, number, number]; // x, y, w, h (mm)

export const LIMITS = {
  maxStrokes: 400,
  maxPoints: 40000, // numbers over all strokes
  minSize: 40,
  /** Also the margin of bbox queries: a carving overlapping x0 starts after x0 − maxSize. */
  maxSize: 3000,
};

/** Checks a draft from the client; returns an error string or null. */
export function validateDraft(d: unknown): string | null {
  const o = d as CarvingDraft;
  if (!o || typeof o !== "object") return "body";
  for (const k of ["x_mm", "y_mm", "w_mm", "h_mm", "src_w", "src_h"] as const) {
    if (typeof o[k] !== "number" || !Number.isFinite(o[k])) return k;
  }
  if (o.w_mm < LIMITS.minSize || o.h_mm < LIMITS.minSize || o.w_mm > LIMITS.maxSize || o.h_mm > LIMITS.maxSize) return "size";
  if (o.src_w <= 0 || o.src_h <= 0 || o.src_w > LIMITS.maxSize || o.src_h > LIMITS.maxSize) return "src";
  if (!Array.isArray(o.strokes) || o.strokes.length === 0) return "strokes";
  const bad = validateStrokes(o.strokes, o.relay ? LIMITS.maxStrokes * 4 : LIMITS.maxStrokes);
  if (bad) return bad;
  if (o.prompt != null && (typeof o.prompt !== "string" || o.prompt.length > 40)) return "prompt";
  if (o.score != null && (!Number.isInteger(o.score) || o.score < 0 || o.score > 100)) return "score";
  if (o.relay != null && (!Number.isInteger(o.relay) || o.relay < 2 || o.relay > 8)) return "relay";
  return null;
}

/** Checks a stroke list (may be empty); returns an error string or null. */
export function validateStrokes(strokes: unknown, maxStrokes = LIMITS.maxStrokes): string | null {
  if (!Array.isArray(strokes) || strokes.length > maxStrokes) return "strokes";
  let n = 0;
  for (const s of strokes as WallStroke[]) {
    if (!s || !Number.isInteger(s.c) || s.c < -1 || s.c > 7) return "stroke.c";
    if (typeof s.s !== "number" || s.s <= 0 || s.s > 200) return "stroke.s";
    if (!Number.isInteger(s.seed)) return "stroke.seed";
    if (!Array.isArray(s.p) || s.p.length < 2 || s.p.length % 2) return "stroke.p";
    if (!s.p.every((v) => typeof v === "number" && Number.isFinite(v))) return "stroke.p";
    n += s.p.length;
  }
  if (n > LIMITS.maxPoints) return "points";
  return null;
}

/** Thins very long drawings (every other point, keeping the ends) until they fit the row limit. */
export function fitPoints(strokes: WallStroke[]): WallStroke[] {
  while (strokes.reduce((n, s) => n + s.p.length, 0) > LIMITS.maxPoints) {
    for (const s of strokes) s.p = s.p.filter((_, i) => i % 4 < 2 || i >= s.p.length - 2);
  }
  return strokes;
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a[0] < b[0] + b[2] + gap && b[0] < a[0] + a[2] + gap && a[1] < b[1] + b[3] + gap && b[1] < a[1] + a[3] + gap;
}

export const rectOf = (c: CarvingDraft): Rect => [c.x_mm, c.y_mm, c.w_mm, c.h_mm];
