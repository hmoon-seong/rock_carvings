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

  undo() {
    const prev = this.past.pop();
    if (prev) this.list = prev;
  }
}
