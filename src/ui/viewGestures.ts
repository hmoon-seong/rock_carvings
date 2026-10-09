// Gestures on the wall view.
// Drawing (draw.active()): one finger, pen or left mouse drag draws; two fingers pan + zoom
// (a second finger within GRACE_MS of the first turns the young stroke into a pinch; later
// it is ignored, e.g. a palm); right or middle mouse drag pans; the wheel zooms.
// Otherwise: one-finger or mouse drag = pan, two-finger pinch = zoom + pan, wheel = zoom at
// the cursor, double-tap / double-click = zoom in 2× there.

export interface GestureHandlers {
  enabled: () => boolean;
  pan: (dxPx: number, dyPx: number) => void;
  zoom: (factor: number, sx: number, sy: number) => void; // sx, sy relative to the element
  start?: () => void;
  /** A short tap without movement (sx, sy relative to the element). */
  tap?: (sx: number, sy: number) => void;
  draw?: DrawHandlers;
}

export interface DrawHandlers {
  /** Is the view in drawing mode right now? */
  active: () => boolean;
  /** Starts a stroke; false if none was started. */
  begin: (sx: number, sy: number) => boolean;
  move: (pts: { x: number; y: number }[]) => void;
  end: () => void;
  cancel: () => void;
}

/** A second finger this soon after the first means a pinch, not a stroke. */
const GRACE_MS = 250;

/** Controls inside the view (buttons, the lab sheet, cards) keep their own pointer and wheel input. */
const OWN_INPUT = "button, input, .sheet, .card, #timer";
const ownsInput = (e: Event) => (e.target as Element | null)?.closest?.(OWN_INPUT) != null;

export function attachViewGestures(el: HTMLElement, h: GestureHandlers) {
  const pts = new Map<number, { x: number; y: number }>();
  const ignored = new Set<number>();
  let lastTap = 0;
  let down: { x: number; y: number; t: number; moved: boolean } | null = null;
  let stroke: { id: number; t0: number } | null = null;
  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const drawing = () => h.draw?.active() ?? false;

  el.addEventListener("contextmenu", (e) => drawing() && e.preventDefault());

  el.addEventListener("pointerdown", (e) => {
    if (!h.enabled() || ownsInput(e)) return;
    const mouse = e.pointerType === "mouse";
    if (drawing()) {
      if (stroke) {
        // A second finger: a pinch if the stroke just started, otherwise ignored.
        if (performance.now() - stroke.t0 > GRACE_MS || mouse) {
          ignored.add(e.pointerId);
          return;
        }
        h.draw!.cancel();
        stroke = null;
      } else if (pts.size === 0 && (!mouse || e.button === 0)) {
        el.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, local(e));
        h.start?.();
        const p = local(e);
        if (h.draw!.begin(p.x, p.y)) stroke = { id: e.pointerId, t0: performance.now() };
        return;
      } else if (mouse && e.button !== 1 && e.button !== 2) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      h.start?.();
      down = null;
      return;
    }
    if (e.button > 0) return;
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
    if (stroke && e.pointerId === stroke.id) {
      const events = e.getCoalescedEvents?.() ?? [];
      h.draw!.move((events.length ? events : [e]).map(local));
      pts.set(e.pointerId, local(e)); // where a pinch would start from
      return;
    }
    const prev = pts.get(e.pointerId);
    if (!prev || ignored.has(e.pointerId)) return;
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

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (stroke && e.pointerId === stroke.id) {
      if (cancelled) h.draw!.cancel();
      else h.draw!.end();
      stroke = null;
    }
    ignored.delete(e.pointerId);
    pts.delete(e.pointerId);
  };
  el.addEventListener("pointerup", (e) => {
    if (pts.has(e.pointerId) && pts.size === 1 && down && !down.moved && performance.now() - down.t < 350) h.tap?.(down.x, down.y);
    down = null;
    end(e, false);
  });
  el.addEventListener("pointercancel", (e) => end(e, true));

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
