// 암각화몬: draw on paper → carve into the scanned Bangudae wall under raking light.

import { buildCarve } from "./carve/carve";
import { writeShadow } from "./carve/shadow";
import { tracingLabels } from "./carve/tracing";
import { BRUSH_MM, CARVE_MM_PER_PX, carveStyles, defaultLab, loadMeta, PALETTE, type WallMeta } from "./config";
import { Ink } from "./draw/ink";
import { rasterizeMasks } from "./draw/strokes";
import { setupDrawTools } from "./ui/drawTools";
import { Lab } from "./ui/lab";
import { LightDial } from "./ui/lightDial";
import { paintTracing } from "./ui/tracingCanvas";
import { WallRenderer } from "./wall/renderer";
import { loadFull, loadOverview } from "./wall/textures";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLElement>("view");
const status = $<HTMLElement>("status");

type Mode = "draw" | "carve";
type View = "rock" | "rubbing" | "tracing";
let mode: Mode = "draw";
let viewMode: View = "rock";
let busy = false;

/** The drawing rectangle on the wall, in mm. Its top-left stays fixed; its height follows the screen. */
const rect = { x: 0, y: 0, w: 700, h: 700 };

const smooth = (t: number) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

function animate(ms: number, step: (t: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      step(t);
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

async function main() {
  let meta: WallMeta;
  let renderer: WallRenderer;
  try {
    meta = await loadMeta();
    renderer = new WallRenderer($("wall"), meta);
  } catch (err) {
    fail(err);
    return;
  }
  const palette = PALETTE;
  const defaultLight = { ...renderer.light };

  // ---------------------------------------------------------------- layout
  // Masks are kept so the lab sliders can re-carve without re-rasterizing the strokes.
  let carve: {
    masks: Float32Array[];
    used: boolean[];
    w: number;
    h: number;
    mmPerPx: number;
    rgba: Uint8Array;
    height: Float32Array;
  } | null = null;
  const [cx, cy] = meta.carving.demo_center_mm;
  rect.w = meta.carving.drawing_width_mm;
  rect.x = cx - rect.w / 2;
  rect.y = cy - rect.w * 0.7;
  const pxPerMM = () => view.clientWidth / rect.w;

  const ink = new Ink($("ink"), palette, pxPerMM, BRUSH_MM.default);
  let syncTools = () => {};
  const layout = () => {
    rect.h = (view.clientHeight / view.clientWidth) * rect.w;
    renderer.view = [rect.x, rect.y, rect.w, rect.h];
    renderer.invalidate();
    ink.resize();
    syncTools();
    placeTrace();
  };
  // The tracing canvas covers the carve rectangle, which keeps its mm size when the view resizes.
  const traceCanvas = $<HTMLCanvasElement>("trace");
  const placeTrace = () => {
    if (!carve) return;
    traceCanvas.style.height = `${carve.h * carve.mmPerPx * pxPerMM()}px`;
  };
  new ResizeObserver(layout).observe(view);
  layout();

  // ---------------------------------------------------------------- textures
  let fullRequested = false;
  const requestFull = () => {
    if (fullRequested) return;
    fullRequested = true;
    loadFull(meta)
      .then((img) => renderer.setWall(img, "full"))
      .catch((err) => console.warn("full-res wall failed, staying on overview", err));
  };
  loadOverview(meta)
    .then((img) => {
      renderer.setWall(img, "overview");
      renderer.setDetail(img.detail);
      status.classList.add("done");
    })
    .catch(fail);

  // ---------------------------------------------------------------- draw tools
  syncTools = setupDrawTools(ink, palette, pxPerMM);
  const hint = $("hint");
  const carveBtn = $<HTMLButtonElement>("carve");
  const syncDraw = () => {
    hint.classList.toggle("hidden", ink.strokes.length > 0);
    carveBtn.disabled = ink.strokes.length === 0;
    syncTools();
  };
  ink.onChange = syncDraw;
  $("ink").addEventListener("pointerdown", requestFull);
  syncDraw();

  // ---------------------------------------------------------------- carving
  const lab = new Lab($("lab"), defaultLab(meta), defaultLab(meta));
  let traceDirty = true;

  const recarve = () => {
    if (!carve) return;
    const styles = carveStyles(lab.settings);
    const layers = carve.masks.flatMap((mask, i) => (carve!.used[i] ? [{ mask, style: styles[i] }] : []));
    const { rgba, height } = buildCarve(layers, { w: carve.w, h: carve.h, mmPerPx: carve.mmPerPx });
    Object.assign(carve, { rgba, height });
    renderer.setCarve(rgba, carve.w, carve.h, [rect.x, rect.y, rect.w, rect.h]);
    relight();
    traceDirty = true;
    if (viewMode === "tracing") paintTrace();
  };
  const paintTrace = () => {
    if (!carve || !traceDirty) return;
    const sigmas = carveStyles(lab.settings).map((s) => s.bevel_sigma_mm / carve!.mmPerPx);
    const masks = carve.masks.map((m, i) => (carve!.used[i] ? m : new Float32Array(m.length)));
    paintTracing(traceCanvas, tracingLabels(masks, sigmas, carve.w, carve.h), carve.w, carve.h, palette);
    placeTrace();
    traceDirty = false;
  };

  // Lab sliders re-carve at most every ~120 ms while dragging.
  let labTimer = 0;
  lab.onChange = () => {
    if (labTimer) return;
    labTimer = window.setTimeout(() => {
      labTimer = 0;
      recarve();
    }, 120);
  };
  const labBtn = $("labBtn");
  labBtn.addEventListener("click", () => labBtn.setAttribute("aria-expanded", String(lab.toggle())));

  // ---------------------------------------------------------------- light
  const dial = new LightDial(renderer.light);
  $("dialHost").appendChild(dial.el);
  // The carving's cast shadow depends on the light: recompute it at most once per frame.
  let shadowQueued = false;
  const relight = () => {
    shadowQueued = false;
    if (!carve) return;
    const { azimuth, elevation } = renderer.light;
    writeShadow(carve.rgba, carve.height, carve.w, carve.h, carve.mmPerPx, azimuth, elevation);
    renderer.updateCarve(carve.rgba);
  };
  const setLight = (l: typeof renderer.light, fromDial = false) => {
    renderer.light = { ...l };
    renderer.invalidate();
    if (!fromDial) dial.set(l, false);
    if (carve && !shadowQueued) {
      shadowQueued = true;
      requestAnimationFrame(relight);
    }
  };
  dial.onInput = (l) => setLight(l, true);

  const wallCanvas = $("wall");
  const wallHint = $("wallhint");
  let drag: { x: number; y: number; az: number; el: number } | null = null;
  wallCanvas.addEventListener("pointerdown", (e) => {
    if (mode !== "carve" || busy || viewMode !== "rock") return;
    wallCanvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, az: renderer.light.azimuth, el: renderer.light.elevation };
    wallHint.classList.remove("show");
  });
  wallCanvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const az = (drag.az + (e.clientX - drag.x) * 0.5 + 360) % 360;
    const el = Math.min(80, Math.max(4, drag.el - (e.clientY - drag.y) * 0.1));
    setLight({ azimuth: az, elevation: el });
  });
  const endDrag = () => (drag = null);
  wallCanvas.addEventListener("pointerup", endDrag);
  wallCanvas.addEventListener("pointercancel", endDrag);

  // ---------------------------------------------------------------- views: 바위 / 탁본 / 도면
  const seg = $("viewSeg");
  const setView = (v: View, animated = true) => {
    const from = renderer.rubbing, to = v === "rubbing" ? 1 : v === "rock" ? 0 : from;
    viewMode = v;
    if (v === "tracing") paintTrace();
    document.body.classList.remove("view-rock", "view-rubbing", "view-tracing");
    document.body.classList.add(`view-${v}`);
    [...seg.children].forEach((b) => b.setAttribute("aria-checked", String((b as HTMLElement).dataset.view === v)));
    if (!animated) {
      renderer.rubbing = to;
      renderer.invalidate();
      return;
    }
    animate(450, (t) => {
      renderer.rubbing = from + (to - from) * smooth(t);
      renderer.invalidate();
    });
  };
  seg.addEventListener("click", (e) => {
    const v = (e.target as HTMLElement).dataset.view as View | undefined;
    if (v && !busy) setView(v);
  });

  // ---------------------------------------------------------------- mode switches
  const paper = $("paper");
  const inkCanvas = $("ink");
  const step = $("step");
  const setMode = (m: Mode) => {
    mode = m;
    document.body.classList.remove("mode-draw", "mode-carve");
    document.body.classList.add(`mode-${m}`);
    step.textContent = m === "draw" ? "그리기" : "새기기";
  };
  setMode("draw");
  setView("rock", false);

  carveBtn.addEventListener("click", async () => {
    if (busy || ink.strokes.length === 0) return;
    busy = true;
    requestFull();
    carveBtn.textContent = "새기는 중…";
    await nextFrame();

    const { masks, w, h, used } = rasterizeMasks(ink.strokes, palette.length, rect.w, rect.h, CARVE_MM_PER_PX);
    carve = { masks, used, w, h, mmPerPx: rect.w / w, rgba: new Uint8Array(0), height: new Float32Array(0) };
    recarve();
    renderer.carveAmount = 0;
    carveBtn.textContent = "새기기";
    setView("rock", false);
    setMode("carve");

    // Paper lifts off → paint on bare rock → paint sinks into the stone as the light swings round.
    // Swing in from the upper left: with light from below, a cut can read as raised.
    const az0 = defaultLight.azimuth - 70;
    paper.style.transition = "none";
    await animate(2600, (t) => {
      paper.style.opacity = String(1 - smooth(t / 0.25));
      inkCanvas.style.opacity = String(1 - smooth((t - 0.35) / 0.4));
      renderer.carveAmount = smooth((t - 0.3) / 0.5);
      const k = smooth(t);
      setLight({ azimuth: az0 + (defaultLight.azimuth - az0) * k, elevation: defaultLight.elevation });
    });
    busy = false;
    wallHint.classList.add("show");
  });

  $("redraw").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    lab.toggle(false);
    labBtn.setAttribute("aria-expanded", "false");
    setView("rock");
    const c0 = renderer.carveAmount;
    await animate(600, (t) => {
      const k = smooth(t);
      paper.style.opacity = inkCanvas.style.opacity = String(k);
      renderer.carveAmount = c0 * (1 - k);
      renderer.invalidate();
    });
    setMode("draw");
    busy = false;
  });
}

function fail(err: unknown) {
  console.error(err);
  status.classList.remove("done");
  status.classList.add("error");
  status.textContent =
    String(err).includes("WebGL2")
      ? "이 브라우저는 WebGL2를 지원하지 않아요. 최신 Safari나 Chrome에서 열어 주세요."
      : "바위를 불러오지 못했어요. 새로고침해 주세요.";
}

main();
