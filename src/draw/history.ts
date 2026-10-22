// Stroke list with undo. Each change stores the previous list (strokes are never mutated
// after they end), so undo also brings back a cleared drawing.

import type { Stroke } from "./strokes";

export class StrokeHistory {
  private list: Stroke[] = [];
  private past: Stroke[][] = [];

  get strokes(): readonly Stroke[] {
    return this.list;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  add(s: Stroke) {
    this.past.push(this.list);
    this.list = [...this.list, s];
  }

  clear() {
    if (this.list.length === 0) return;
    this.past.push(this.list);
    this.list = [];
  }

  /** These strokes and no undo (someone else's drawing, shown in 이어 그리기). */
  load(list: readonly Stroke[]) {
    this.list = [...list];
    this.past = [];
  }

  /** Empty drawing and no undo (a new challenge starts from a blank paper). */
  reset() {
    this.list = [];
    this.past = [];
  }

  undo() {
    const prev = this.past.pop();
    if (prev) this.list = prev;
  }
}
