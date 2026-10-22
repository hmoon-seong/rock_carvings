// Drawing straight on the rock. Strokes are in wall mm. The stroke under the finger shows as
// flat paint; when the finger lifts the stroke is handed over to be carved (onEdit) and its
// paint fades into the fresh carving. Pointer input comes from ui/viewGestures.ts.

import type { PaletteColor } from "../config";
import { StrokeHistory } from "./history";
import { ERASER, paintStroke, type Stroke } from "./strokes";

/** The view: wall mm at the canvas's top-left, and mm per CSS px. */
export type InkView = () => { x: number; y: number; scale: number };

const FADE_MS = 450;
const ERASER_FILL = "rgba(245, 238, 228, 0.5)";

export class Ink {
  readonly history = new StrokeHistory();
  color = 0; // palette index or ERASER
  size: number;
  enabled = true;
  /** Shows every stroke as paint (the guide sketch under the timelapse). */
  guide = false;
  onChange: () => void = () => {};
  /** Strokes whose area changed (added, undone, cleared): re-carve around them. */
  onEdit: (changed: readonly Stroke[]) => void = () => {};
  /** Checks a finished stroke; returns false to drop it. */
  accept: (s: Stroke) => boolean = () => true;

  private ctx: CanvasRenderingContext2D;
  private active: Stroke | null = null;
  private fading: { s: Stroke; t0: number }[] = [];
  private queued = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private palette: PaletteColor[],
    private view: InkView,
    size: number,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.size = size;
  }

  get strokes(): readonly Stroke[] {
    return this.history.strokes;
  }

  get drawing(): boolean {
    return this.active != null;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.redraw();
  }

  // ---- edits
  clear() {
    this.edit(() => this.history.clear());
  }

  reset() {
    this.active = null;
    this.edit(() => this.history.reset());
  }

  /** Replaces the drawing with `strokes` (no undo), carving them. */
  load(strokes: readonly Stroke[]) {
    this.active = null;
    this.edit(() => this.history.load(strokes));
  }

  undo() {
    if (this.active) return;
    this.edit(() => this.history.undo());
  }

  private edit(op: () => void) {
    const before = new Set(this.strokes);
    op();
    const after = new Set(this.strokes);
    const changed = [...before].filter((s) => !after.has(s)).concat([...after].filter((s) => !before.has(s)));
    this.fading = [];
    if (changed.length) this.onEdit(changed);
    this.redraw();
    this.onChange();
  }

  // ---- pointer input (view px, relative to the canvas)
  begin(sx: number, sy: number): boolean {
    if (!this.enabled || this.active) return false;
    this.active = { color: this.color, size: this.size, points: this.toMM(sx, sy), seed: (Math.random() * 2 ** 31) | 0 };
    this.schedule();
    return true;
  }

  extend(pts: readonly { x: number; y: number }[]) {
    if (!this.active) return;
    const p = this.active.points;
    for (const { x: sx, y: sy } of pts) {
      const [x, y] = this.toMM(sx, sy);
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= 0.8) p.push(x, y);
    }
    this.schedule();
  }

  end() {
    const s = this.active;
    if (!s) return;
    this.active = null;
    if (!this.accept(s)) {
      this.fading.push({ s, t0: performance.now() - FADE_MS / 2 });
      this.schedule();
      return;
    }
    this.history.add(s);
    this.onEdit([s]); // carves it (may take a frame or two)
    this.fading.push({ s, t0: performance.now() });
    this.schedule();
    this.onChange();
  }

  /** Drops the stroke in progress (a second finger turned it into a pinch). */
  cancel() {
    if (!this.active) return;
    this.active = null;
    this.redraw();
  }

  // ---- painting
  redraw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const v = this.view();
    const scale = canvas.width / canvas.clientWidth / v.scale; // device px per mm
    const paint = (s: Stroke) => {
      // Only the paint's own color shows; the eraser is a pale wash over the rock.
      ctx.globalCompositeOperation = s.color === ERASER && this.guide ? "destination-out" : "source-over";
      ctx.fillStyle = s.color === ERASER ? (this.guide ? "#000" : ERASER_FILL) : this.palette[s.color].hex;
      paintStroke(ctx, s, scale, Infinity, v.x, v.y);
    };
    if (this.guide) this.strokes.forEach(paint);
    const now = performance.now();
    this.fading = this.fading.filter((f) => now - f.t0 < FADE_MS);
    for (const f of this.fading) {
      ctx.globalAlpha = Math.max(0, 1 - (now - f.t0) / FADE_MS) ** 1.5;
      paint(f.s);
    }
    ctx.globalAlpha = 1;
    if (this.active) paint(this.active);
    ctx.globalCompositeOperation = "source-over";
    if (this.fading.length) this.schedule();
  }

  private toMM(sx: number, sy: number): [number, number] {
    const v = this.view();
    return [v.x + sx * v.scale, v.y + sy * v.scale];
  }

  private schedule() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.redraw();
    });
  }
}
