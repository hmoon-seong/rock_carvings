// 암각화몬: draw on paper → carve into the scanned Bangudae wall under raking light.

import { buildCarve } from "./carve/carve";
import { writeShadow } from "./carve/shadow";
import { tracingLabels } from "./carve/tracing";
import { BRUSH_MM, CARVE_KEYS, CARVE_MM_PER_PX, carveStyles, defaultLab, loadMeta, PALETTE, type WallMeta } from "./config";
import { Ink } from "./draw/ink";
import { rasterizeMasks } from "./draw/strokes";
import { setupDrawTools } from "./ui/drawTools";
import { Lab } from "./ui/lab";
import { LightDial } from "./ui/lightDial";
import { paintTracing } from "./ui/tracingCanvas";
import { attachViewGestures } from "./ui/viewGestures";
import { Camera, fitScale, niceLength, type CameraLimits } from "./wall/camera";
import { loadPlacementMask, placementOK, type PlacementMask } from "./wall/placement";
import { WallRenderer } from "./wall/renderer";
import { loadFull, loadOverview } from "./wall/textures";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLElement>("view");
const status = $<HTMLElement>("status");

type Mode = "draw" | "place" | "carve";
type View = "rock" | "rubbing" | "tracing";
let mode: Mode = "draw";
let viewMode: View = "rock";
let busy = false;

/** The drawing rectangle on the wall, in mm (chosen with 자리 고르기). Its top-left stays fixed; its height follows the screen. */
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
    rectMM: [number, number, number, number]; // fixed where it was carved
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

  // Camera: "home" puts the drawing rectangle exactly where the paper was (top-left aligned).
  const camera = new Camera(0, 0, 1);
  let atHome = true;
  const vw = () => view.clientWidth, vh = () => view.clientHeight;
  // While choosing a spot the frame never gets bigger than the screen.
  const limits = (): CameraLimits => ({
    wallW: meta.width_mm,
    wallH: meta.height_mm,
    minScale: mode === "place" ? rect.w / vw() : rect.w / vw() / 4,
  });
  const homeCamera = (): [number, number, number] => {
    const s = rect.w / vw();
    return [rect.x + rect.w / 2, rect.y + (vh() * s) / 2, s];
  };
  const applyCamera = () => {
    renderer.view = camera.rect(vw(), vh());
    renderer.invalidate();
    placeTrace();
    placeFrame();
    syncZoomUI();
  };
  const layout = () => {
    rect.h = (vh() / vw()) * rect.w;
    if (atHome) [camera.cx, camera.cy, camera.scale] = homeCamera();
    else camera.clamp(vw(), vh(), limits());
    applyCamera();
    ink.resize();
    syncTools();
  };
  // The tracing canvas covers the carve rectangle and follows the camera.
  const traceCanvas = $<HTMLCanvasElement>("trace");
  const placeTrace = () => {
    if (!carve) return;
    const [vx, vy] = camera.rect(vw(), vh()), [x, y, w, h] = carve.rectMM, s = camera.scale;
    Object.assign(traceCanvas.style, {
      left: `${(x - vx) / s}px`, top: `${(y - vy) / s}px`, width: `${w / s}px`, height: `${h / s}px`,
    });
  };

  // 자리 고르기: a frame fixed at the screen centre; the wall moves under it. The current
  // drawing is shown inside the frame (the ink canvas scaled down), and the frame turns red
  // where placement_mask.png does not allow a carving.
  const frame = $("frame");
  const inkEl = $("ink");
  const placeOk = $<HTMLButtonElement>("placeOk");
  const placeMsg = $("placeMsg");
  let placementMask: PlacementMask | null = null;
  let maskRequested = false;
  const frameRect = (): [number, number, number, number] => [camera.cx - rect.w / 2, camera.cy - rect.h / 2, rect.w, rect.h];
  const placeFrame = () => {
    if (mode !== "place") {
      inkEl.style.transform = "";
      return;
    }
    const fw = rect.w / camera.scale, fh = rect.h / camera.scale;
    const left = (vw() - fw) / 2, top = (vh() - fh) / 2;
    Object.assign(frame.style, { left: `${left}px`, top: `${top}px`, width: `${fw}px`, height: `${fh}px` });
    inkEl.style.transform = `translate(${left}px, ${top}px) scale(${fw / vw()})`;
    const ok = !placementMask || placementOK(placementMask, frameRect());
    frame.classList.toggle("bad", !ok);
    placeOk.disabled = !ok;
    placeMsg.textContent = ok ? "" : "여기는 새길 수 없어요";
  };

  // Zoom controls + scale bar (carve and place screens).
  const zoomToggle = $<HTMLButtonElement>("zoomToggle");
  const scaleBar = $("scalebar");
  const syncZoomUI = () => {
    zoomToggle.textContent = atHome || mode === "place" ? "전체 보기" : "내 새김";
    const len = niceLength(90 * camera.scale);
    (scaleBar.firstElementChild as HTMLElement).style.width = `${len / camera.scale}px`;
    scaleBar.lastElementChild!.textContent = len >= 1000 ? `${len / 1000} m` : `${len / 10} cm`;
  };
  const animateCamera = (to: [number, number, number], ms = 450) => {
    const from: [number, number, number] = [camera.cx, camera.cy, camera.scale];
    return animate(ms, (t) => {
      const k = smooth(t);
      camera.cx = from[0] + (to[0] - from[0]) * k;
      camera.cy = from[1] + (to[1] - from[1]) * k;
      camera.scale = Math.exp(Math.log(from[2]) + (Math.log(to[2]) - Math.log(from[2])) * k); // even zoom speed
      applyCamera();
    });
  };
  const goHome = async () => {
    await animateCamera(homeCamera());
    atHome = true;
    syncZoomUI();
  };
  const zoomBy = (f: number) => {
    const c = new Camera(camera.cx, camera.cy, camera.scale);
    c.zoomAt(f, vw() / 2, vh() / 2, vw(), vh(), limits());
    atHome = false;
    animateCamera([c.cx, c.cy, c.scale], 220);
  };
  $("zoomIn").addEventListener("click", () => zoomBy(1.6));
  $("zoomOut").addEventListener("click", () => zoomBy(1 / 1.6));
  zoomToggle.addEventListener("click", async () => {
    if (atHome || mode === "place") {
      atHome = false;
      await animateCamera([meta.width_mm / 2, meta.height_mm / 2, fitScale(vw(), vh(), limits())], 700);
      syncZoomUI();
    } else await goHome();
  });

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
  const lab = new Lab($("lab"), defaultLab(), defaultLab());
  let traceDirty = true;

  const recarve = () => {
    if (!carve) return;
    const styles = carveStyles(lab.settings);
    const layers = carve.masks.flatMap((mask, i) => (carve!.used[i] ? [{ mask, style: styles[i] }] : []));
    const { rgba, height } = buildCarve(layers, { w: carve.w, h: carve.h, mmPerPx: carve.mmPerPx });
    Object.assign(carve, { rgba, height });
    renderer.setCarve(rgba, carve.w, carve.h, carve.rectMM);
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

  // Shading sliders apply at once; carve sliders re-carve at most every ~120 ms while dragging.
  renderer.setLook(lab.settings);
  let labTimer = 0;
  lab.onChange = (settings, key) => {
    renderer.setLook(settings);
    if (key && !CARVE_KEYS.includes(key)) return;
    if (labTimer) return;
    labTimer = window.setTimeout(() => {
      labTimer = 0;
      recarve();
    }, 120);
  };
  lab.extra = () => ({ azimuth_deg: renderer.light.azimuth, elevation_deg: renderer.light.elevation });
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

  // Drag / pinch / wheel on the wall moves the camera (the light is set with the dial).
  const wallHint = $("wallhint");
  attachViewGestures(view, {
    enabled: () => mode !== "draw" && !busy,
    start: () => wallHint.classList.remove("show"),
    pan: (dx, dy) => {
      camera.pan(dx, dy);
      camera.clamp(vw(), vh(), limits());
      atHome = false;
      applyCamera();
    },
    zoom: (f, sx, sy) => {
      camera.zoomAt(f, sx, sy, vw(), vh(), limits());
      camera.clamp(vw(), vh(), limits());
      atHome = false;
      applyCamera();
    },
  });

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
    document.body.classList.remove("mode-draw", "mode-place", "mode-carve");
    document.body.classList.add(`mode-${m}`);
    step.textContent = { draw: "그리기", place: "자리 고르기", carve: "새기기" }[m];
  };

  // ---------------------------------------------------------------- 자리 고르기
  let placeFrom = { x: rect.x, y: rect.y };
  $("placeBtn").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    placeFrom = { x: rect.x, y: rect.y };
    if (!maskRequested) {
      maskRequested = true;
      loadPlacementMask(meta)
        .then((m) => {
          placementMask = m;
          placeFrame();
        })
        .catch((err) => console.warn("placement mask failed; any spot allowed", err));
    }
    setMode("place");
    atHome = false;
    applyCamera();
    // Paper lifts off and the view pulls back so the drawing sits in a frame on the wall.
    const [hx, hy, hs] = homeCamera();
    paper.style.transition = "none";
    await animate(700, (t) => {
      paper.style.opacity = String(1 - smooth(t / 0.6));
      camera.cx = hx;
      camera.cy = hy;
      camera.scale = hs * Math.exp(Math.log(3) * smooth(t));
      applyCamera();
    });
    busy = false;
  });
  const leavePlace = async () => {
    await animateCamera(homeCamera(), 550); // the frame grows to fill the screen
    atHome = true;
    setMode("draw");
    applyCamera();
    await animate(350, (t) => (paper.style.opacity = String(smooth(t))));
    busy = false;
  };
  placeOk.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    [rect.x, rect.y] = frameRect();
    leavePlace();
  });
  $("placeCancel").addEventListener("click", () => {
    if (busy) return;
    busy = true;
    rect.x = placeFrom.x;
    rect.y = placeFrom.y;
    leavePlace();
  });
  setMode("draw");
  setView("rock", false);

  carveBtn.addEventListener("click", async () => {
    if (busy || ink.strokes.length === 0) return;
    busy = true;
    requestFull();
    carveBtn.textContent = "새기는 중…";
    await nextFrame();

    const { masks, w, h, used } = rasterizeMasks(ink.strokes, palette.length, rect.w, rect.h, CARVE_MM_PER_PX);
    const mmPerPx = rect.w / w;
    const rectMM: [number, number, number, number] = [rect.x, rect.y, rect.w, h * mmPerPx];
    carve = { masks, used, w, h, mmPerPx, rectMM, rgba: new Uint8Array(0), height: new Float32Array(0) };
    traceDirty = true;
    recarve();
    renderer.carveAmount = 0;
    atHome = true;
    [camera.cx, camera.cy, camera.scale] = homeCamera();
    applyCamera();
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
    await goHome();
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
