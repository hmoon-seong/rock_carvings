// The drawing surface: flat-color strokes on a canvas, touch + mouse via pointer events.

import type { PaletteColor } from "../config";
import { StrokeHistory } from "./history";
import { ERASER, paintStroke, type Stroke } from "./strokes";

export class Ink {
  readonly history = new StrokeHistory();
  color = 0; // palette index or ERASER
  size: number;
  enabled = true;
  onChange: () => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private active: Stroke | null = null;
  private pointerId = -1;
  private queued = false;

  /** `pxPerMM` returns CSS px per mm of the drawing rectangle. */
  constructor(
    private canvas: HTMLCanvasElement,
    private palette: PaletteColor[],
    private pxPerMM: () => number,
    size: number,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.size = size;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
  }

  get strokes(): readonly Stroke[] {
    return this.history.strokes;
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

  clear() {
    this.history.clear();
    this.changed();
  }

  undo() {
    if (this.active) return;
    this.history.undo();
    this.changed();
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = (canvas.width / canvas.clientWidth) * this.pxPerMM();
    const all = this.active ? [...this.strokes, this.active] : this.strokes;
    for (const s of all) {
      ctx.globalCompositeOperation = s.color === ERASER ? "destination-out" : "source-over";
      ctx.fillStyle = s.color === ERASER ? "#000" : this.palette[s.color].hex;
      paintStroke(ctx, s, scale);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private changed() {
    this.redraw();
    this.onChange();
  }

  private toMM(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect(), k = this.pxPerMM();
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.active || e.button > 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    this.active = { color: this.color, size: this.size, points: this.toMM(e), seed: (Math.random() * 2 ** 31) | 0 };
    this.schedule();
  }

  private move(e: PointerEvent) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    const p = this.active.points;
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.toMM(ev);
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= 0.8) p.push(x, y);
    }
    this.schedule();
  }

  private up(e: PointerEvent) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.history.add(this.active);
    this.active = null;
    this.pointerId = -1;
    this.changed();
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
