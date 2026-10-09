// Pan / zoom gestures on the wall: one-finger or mouse drag = pan, two-finger pinch = zoom + pan,
// wheel = zoom at the cursor, double-tap / double-click = zoom in 2× there.

export interface GestureHandlers {
  enabled: () => boolean;
  pan: (dxPx: number, dyPx: number) => void;
  zoom: (factor: number, sx: number, sy: number) => void; // sx, sy relative to the element
  start?: () => void;
  /** A short tap without movement (sx, sy relative to the element). */
  tap?: (sx: number, sy: number) => void;
}

/** Controls inside the view (buttons, the lab sheet) keep their own pointer and wheel input. */
const OWN_INPUT = "button, input, .sheet";
const ownsInput = (e: Event) => (e.target as Element | null)?.closest?.(OWN_INPUT) != null;

export function attachViewGestures(el: HTMLElement, h: GestureHandlers) {
  const pts = new Map<number, { x: number; y: number }>();
  let lastTap = 0;
  let down: { x: number; y: number; t: number; moved: boolean } | null = null;
  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  el.addEventListener("pointerdown", (e) => {
    if (!h.enabled() || e.button > 0 || ownsInput(e)) return;
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    h.start?.();
    down = pts.size === 1 ? { ...local(e), t: performance.now(), moved: false } : null;
    if (pts.size === 1) {
      const now = performance.now();
      if (now - lastTap < 300) {
        const p = local(e);
        h.zoom(2, p.x, p.y);
        lastTap = 0;
      } else lastTap = now;
    }
  });

  el.addEventListener("pointermove", (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    if (pts.size === 1) {
      const p = local(e);
      h.pan(p.x - prev.x, p.y - prev.y);
      pts.set(e.pointerId, p);
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > 2) lastTap = 0;
      if (down && Math.hypot(p.x - down.x, p.y - down.y) > 6) down.moved = true;
    } else if (pts.size === 2) {
      const before = mid();
      pts.set(e.pointerId, local(e));
      const after = mid();
      h.pan(after.x - before.x, after.y - before.y);
      if (before.d > 0) h.zoom(after.d / before.d, after.x, after.y);
      lastTap = 0;
      down = null;
    }
  });

  const end = (e: PointerEvent) => pts.delete(e.pointerId);
  el.addEventListener("pointerup", (e) => {
    if (pts.has(e.pointerId) && pts.size === 1 && down && !down.moved && performance.now() - down.t < 350) h.tap?.(down.x, down.y);
    down = null;
    end(e);
  });
  el.addEventListener("pointercancel", end);

  el.addEventListener(
    "wheel",
    (e) => {
      if (!h.enabled() || ownsInput(e)) return;
      e.preventDefault();
      const p = local(e);
      h.zoom(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    },
    { passive: false },
  );
}
