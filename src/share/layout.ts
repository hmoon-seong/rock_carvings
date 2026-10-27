// Photo geometry (이어 그리기 album): the wall crop around a carving, Korean line wrapping, dates.

import type { Rect } from "../../shared/wall";

/**
 * Wall crop (mm) for a photo of aspect w/h: the carving `bbox` fills about 80 % of the
 * picture above the text band (bottom `textFrac`), and the crop stays on the wall if it fits.
 */
export function shareCrop(bbox: Rect, wallW: number, wallH: number, aspect: number, textFrac: number, minWidth = 450): Rect {
  const [bx, by, bw, bh] = bbox;
  const usable = 1 - textFrac;
  const cw = Math.max(minWidth, bw / 0.8, (bh / (0.8 * usable)) * aspect);
  const ch = cw / aspect;
  let x = bx + bw / 2 - cw / 2;
  let y = by + bh / 2 - (usable / 2) * ch;
  const fit = (v: number, size: number, wall: number) => (size <= wall ? Math.min(Math.max(v, 0), wall - size) : (wall - size) / 2);
  x = fit(x, cw, wallW);
  y = fit(y, ch, wallH);
  return [x, y, cw, ch];
}

/** Greedy wrap by words (Korean: spaces), breaking over-long words by character. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    const cand = line ? `${line} ${word}` : word;
    if (measure(cand) <= maxWidth) {
      line = cand;
      continue;
    }
    push();
    if (measure(word) <= maxWidth) {
      line = word;
      continue;
    }
    for (const ch of word) {
      if (measure(line + ch) > maxWidth) push();
      line += ch;
    }
  }
  push();
  return lines;
}

/** Like wrapText, but with lines of similar length (the narrowest width that keeps the line count). */
export function wrapBalanced(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const best = wrapText(text, maxWidth, measure);
  if (best.length < 2) return best;
  let lo = maxWidth / best.length, hi = maxWidth, out = best;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrapText(text, mid, measure);
    if (lines.length <= best.length) {
      out = lines;
      hi = mid;
    } else lo = mid;
  }
  return out;
}

export function koreanDate(d = new Date()): string {
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
