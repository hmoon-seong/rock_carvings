// Drawing strokes ⇄ stored wall strokes (shared/wall.ts).

import type { WallStroke } from "../../shared/wall";
import type { Stroke } from "../draw/strokes";

const q = (v: number) => Math.round(v * 2) / 2; // 0.5 mm

/** Strokes moved so (ox, oy) mm becomes the origin, rounded to 0.5 mm. */
export function toWallStrokes(strokes: readonly Stroke[], ox: number, oy: number): WallStroke[] {
  return strokes.map((s) => {
    const p: number[] = [];
    for (let i = 0; i < s.points.length; i += 2) {
      const x = q(s.points[i] - ox), y = q(s.points[i + 1] - oy);
      // Rounding can make neighbours equal; keep one (but never drop the first point).
      if (p.length && p[p.length - 2] === x && p[p.length - 1] === y) continue;
      p.push(x, y);
    }
    return { c: s.color, s: q(s.size), seed: s.seed, p };
  });
}

export function fromWallStrokes(ws: readonly WallStroke[]): Stroke[] {
  return ws.map((w) => ({ color: w.c, size: w.s, seed: w.seed, points: w.p.slice() }));
}
