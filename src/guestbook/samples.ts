// A few sample carvings so the shared wall is never empty in mock mode (no Supabase).
// Drawn procedurally as thick strokes, like a visitor's finger drawing. Placed on the calmest
// allowed patches of the wall (least normal-map relief), away from the default drawing spot.

import type { Carving, WallStroke } from "../../shared/wall";

type Pt = [number, number];
const r1 = (v: number) => Math.round(v * 2) / 2;
const stroke = (pts: Pt[], s: number, c = 0, seed = 1): WallStroke => ({ c, s, seed, p: pts.flatMap(([x, y]) => [r1(x), r1(y)]) });
const line = (...pts: Pt[]) => pts;

/** Concentric rings filling an ellipse (a filled body with a thick brush). */
function ellipseFill(cx: number, cy: number, a: number, b: number, brush: number): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; ; k++) {
    const ra = a - k * brush * 0.6, rb = b - k * brush * 0.6;
    if (rb <= 0 || ra <= 0) break;
    for (let t = 0; t <= Math.PI * 2 + 0.01; t += 0.12) pts.push([cx + Math.cos(t) * ra, cy + Math.sin(t) * rb]);
  }
  pts.push([cx - a * 0.5, cy], [cx + a * 0.5, cy]);
  return pts;
}

function sample(id: string, x: number, y: number, w: number, h: number, strokes: WallStroke[], extra: Partial<Carving> = {}): Carving {
  return { id, created_at: "2026-10-01T09:00:00Z", x_mm: x, y_mm: y, w_mm: w, h_mm: h, src_w: w, src_h: h, strokes, prompt: null, score: null, ...extra };
}

export const SAMPLES: Carving[] = [
  // 고래: fat body, tail fluke, a blow
  sample("sample-whale", 1893, 2616, 660, 300, [
    stroke(ellipseFill(300, 170, 230, 75, 40), 40, 0, 11),
    stroke(line([80, 170], [30, 110], [15, 90]), 34, 0, 12),
    stroke(line([80, 170], [30, 230], [15, 250]), 34, 0, 13),
    stroke(line([470, 100], [490, 50], [470, 25]), 18, 0, 14),
  ]),
  // 사슴: body, neck + head, legs, antlers
  sample("sample-deer", 6352, 2885, 420, 440, [
    stroke(ellipseFill(190, 250, 120, 45, 30), 30, 0, 21),
    stroke(line([290, 230], [330, 150], [370, 130]), 30, 0, 22),
    stroke(line([110, 280], [100, 400]), 20, 0, 23),
    stroke(line([150, 285], [160, 405]), 20, 0, 24),
    stroke(line([240, 285], [235, 405]), 20, 0, 25),
    stroke(line([275, 275], [290, 400]), 20, 0, 26),
    stroke(line([340, 135], [310, 60], [280, 30]), 12, 0, 27),
    stroke(line([318, 85], [350, 40]), 12, 0, 28),
    stroke(line([360, 125], [380, 55], [410, 30]), 12, 0, 29),
  ]),
  // 사람: arms up, legs apart (purple)
  sample("sample-human", 5306, 2918, 260, 400, [
    stroke(ellipseFill(130, 60, 34, 34, 26), 26, 1, 31),
    stroke(line([130, 95], [130, 250]), 30, 1, 32),
    stroke(line([30, 40], [70, 140], [130, 150], [190, 140], [230, 40]), 22, 1, 33),
    stroke(line([60, 380], [90, 300], [130, 250], [170, 300], [200, 380]), 24, 1, 34),
  ]),
  // 배: hull with rowers
  sample("sample-boat", 920, 2761, 600, 280, [
    stroke(line([20, 140], [80, 210], [300, 235], [520, 210], [580, 140]), 34, 0, 41),
    stroke(line([60, 185], [540, 185]), 30, 0, 42),
    ...[130, 210, 290, 370, 450].map((x, i) => stroke(line([x, 175], [x + 5, 70]), 16, 0, 43 + i)),
  ]),
  // 거북: shell, head, four legs
  sample("sample-turtle", 5948, 2131, 360, 320, [
    stroke(ellipseFill(170, 160, 105, 90, 34), 34, 0, 51),
    stroke(line([270, 150], [330, 140]), 34, 0, 52),
    stroke(line([90, 85], [45, 40]), 24, 0, 53),
    stroke(line([250, 85], [295, 40]), 24, 0, 54),
    stroke(line([90, 235], [45, 285]), 24, 0, 55),
    stroke(line([250, 235], [295, 285]), 24, 0, 56),
  ]),
  // 물새 (purple, shallower)
  sample("sample-bird", 6948, 2131, 340, 240, [
    stroke(ellipseFill(150, 150, 95, 40, 26), 26, 1, 61),
    stroke(line([230, 140], [270, 70], [290, 40], [325, 45]), 18, 1, 62),
    stroke(line([60, 140], [20, 110]), 22, 1, 63),
  ]),
];
