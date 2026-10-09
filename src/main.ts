// 암각화몬: draw on paper → carve into the scanned Bangudae wall under raking light.

import { motifById, pickMotif, type Motif } from "../shared/challenge";
import { LIMITS, rectOf, type Carving, type CarvingDraft, type Rect } from "../shared/wall";
import type { ScoreResult } from "../shared/score";
import { ChallengeUI, type TimerEnd } from "./challenge/challengeUI";
import { guessLine, requestScore } from "./challenge/score";
import { maskBBox, silhouettePNG } from "./challenge/silhouette";
import { checkNearSite, GEO_TEXT, geoBypassed } from "./guestbook/geo";
import { toWallStrokes } from "./guestbook/serialize";
import { findSpots } from "./guestbook/spot";
import { Guestbook } from "./guestbook/store";
import { layerResolution, WallLayer, windowCovers, windowFor, type WallLayerResult, type WallWindow } from "./guestbook/wallLayer";
import { buildCarve } from "./carve/carve";
import { writeShadow } from "./carve/shadow";
import { tracingLabels } from "./carve/tracing";
import { BRUSH_MM, CARVE_KEYS, CARVE_MM_PER_PX, RASTER_KEYS, carveStyles, defaultLab, loadMeta, PALETTE, type WallMeta } from "./config";
import { Ink } from "./draw/ink";
import { countStamps, rasterizeMasks, setBrushRoughness } from "./draw/strokes";
import { setupDrawTools } from "./ui/drawTools";
import { Lab } from "./ui/lab";
import { koreanDate, SHARE_SIZES, shareCrop } from "./share/layout";
import { clipMessage, ShareSheet } from "./share/shareSheet";
import { LightDial } from "./ui/lightDial";
import { dialog, toast } from "./ui/notice";
import { paintTracing } from "./ui/tracingCanvas";
import { attachViewGestures } from "./ui/viewGestures";
import { Camera, fitScale, niceLength, type CameraLimits } from "./wall/camera";
import { loadPlacementMask, placementOK, type PlacementMask } from "./wall/placement";
import { WallRenderer } from "./wall/renderer";
import { loadFull, loadOverview } from "./wall/textures";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLElement>("view");
const status = $<HTMLElement>("status");

type Mode = "draw" | "place" | "carve" | "wall";
type View = "rock" | "rubbing" | "tracing";
let mode: Mode = "draw";
let viewMode: View = "rock";
let busy = false;
/** Current challenge prompt; null = free drawing. */
let motif: Motif | null = null;
let challengeResult: ScoreResult | null = null;
const challengeUI = new ChallengeUI();

/** The drawing rectangle on the wall, in mm (chosen with 자리 고르기). Its top-left stays fixed; its height follows the screen. */
const rect = { x: 0, y: 0, w: 700, h: 700 };

const smooth = (t: number) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Result for a challenge that ended with nothing drawn (no scoring call). */
const EMPTY_RESULT: ScoreResult = { match: 0, guess: "빈 바위", comment: "아직 아무것도 새기지 않았어요. 다시 도전해 볼까요?", flagged: false };

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
  const wallLayer = new WallLayer(palette.length);
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
    onWallCamera();
  };
  let onWallCamera = () => {};
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
  let maskLoad: Promise<PlacementMask> | null = null;
  const getPlacementMask = () =>
    (maskLoad ??= loadPlacementMask(meta).then((m) => (placementMask = m)).catch((err) => {
      maskLoad = null;
      throw err;
    }));
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
    zoomToggle.textContent = atHome || mode === "place" || mode === "wall" ? "전체 보기" : "내 새김";
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
    if (atHome || mode === "place" || mode === "wall") {
      atHome = false;
      await animateCamera([meta.width_mm / 2, meta.height_mm / 2, fitScale(vw(), vh(), limits())], 700);
      syncZoomUI();
    } else await goHome();
  });

  new ResizeObserver(layout).observe(view);
  layout();

  // ---------------------------------------------------------------- textures
  let fullLoad: Promise<void> | null = null;
  /** Starts loading the full-res wall (once); resolves when it is shown (or failed). */
  const requestFull = () =>
    (fullLoad ??= loadFull(meta)
      .then((img) => renderer.setWall(img, "full"))
      .catch((err) => console.warn("full-res wall failed, staying on overview", err)));
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
  const doneBtn = $<HTMLButtonElement>("done");
  const syncDraw = () => {
    hint.classList.toggle("hidden", ink.strokes.length > 0);
    carveBtn.disabled = ink.strokes.length === 0;
    doneBtn.disabled = ink.strokes.length === 0 || !challengeUI.running;
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
  // 붓 거칠기 changes the marks themselves: the paper redraws and the masks are rebuilt from the strokes.
  renderer.setLook(lab.settings);
  setBrushRoughness(lab.settings.brush_roughness);
  let labTimer = 0;
  let rasterDirty = false;
  lab.onChange = (settings, key) => {
    renderer.setLook(settings);
    if (key && !CARVE_KEYS.includes(key)) return;
    wallLayer.lookVersion++;
    if (!key || RASTER_KEYS.includes(key)) {
      setBrushRoughness(settings.brush_roughness);
      ink.redraw();
      rasterDirty = true;
    }
    if (labTimer) return;
    labTimer = window.setTimeout(() => {
      labTimer = 0;
      if (rasterDirty && carve) {
        const [, , wMM, hMM] = carve.rectMM;
        const { masks, used } = rasterizeMasks(ink.strokes, palette.length, wMM, hMM, CARVE_MM_PER_PX);
        Object.assign(carve, { masks, used });
      }
      rasterDirty = false;
      recarve();
    }, 120);
  };
  lab.extra = () => ({ azimuth_deg: renderer.light.azimuth, elevation_deg: renderer.light.elevation });
  const labBtn = $("labBtn");
  labBtn.addEventListener("click", () => labBtn.setAttribute("aria-expanded", String(lab.toggle())));

  // ---------------------------------------------------------------- light
  const dial = new LightDial(renderer.light);
  $("dialHost").appendChild(dial.el);
  // The dial lives in the free-mode carve panel or in the challenge result panel.
  const placeDial = () => {
    const host = $(mode === "wall" ? "dialHost3" : motif ? "dialHost2" : "dialHost");
    if (dial.el.parentElement !== host) host.appendChild(dial.el);
  };
  // The carving's cast shadow depends on the light: recompute it at most once per frame.
  let shadowQueued = false;
  let timelapseRunning = false;
  const relight = () => {
    shadowQueued = false;
    if (mode === "wall") return relightWall();
    if (!carve || timelapseRunning) return;
    const { azimuth, elevation } = renderer.light;
    writeShadow(carve.rgba, carve.height, carve.w, carve.h, carve.mmPerPx, azimuth, elevation);
    renderer.updateCarve(carve.rgba);
  };
  const setLight = (l: typeof renderer.light, fromDial = false) => {
    renderer.light = { ...l };
    renderer.invalidate();
    if (!fromDial) dial.set(l, false);
    if ((carve || mode === "wall") && !shadowQueued) {
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
    tap: (sx, sy) => wallTap(sx, sy),
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
    document.body.classList.remove("mode-draw", "mode-place", "mode-carve", "mode-wall");
    document.body.classList.add(`mode-${m}`);
    step.textContent = m === "wall" ? "모두의 벽" : motif ? "도전" : { draw: "그리기", place: "자리 고르기", carve: "새기기" }[m];
    placeDial();
  };

  // ---------------------------------------------------------------- 자리 고르기
  let placeFrom = { x: rect.x, y: rect.y };
  $("placeBtn").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    placeFrom = { x: rect.x, y: rect.y };
    getPlacementMask()
      .then(() => placeFrame())
      .catch((err) => console.warn("placement mask failed; any spot allowed", err));
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

  // ---------------------------------------------------------------- timelapse
  // The carving is pecked mark by mark in drawing order. Frames are built at 2 mm/px (a quarter
  // of the pixels) so they keep up; the full 1 mm/px carving replaces them at the end.
  // A tap on the wall skips to the end.
  const GUIDE_OPACITY = 0.35;
  const TIMELAPSE_MM_PER_PX = 2;
  const progress = $("progress");
  let skipTimelapse = false;
  view.addEventListener("pointerdown", () => {
    if (timelapseRunning) skipTimelapse = true;
  });
  const timelapseFrame = (limit: number) => {
    const c = carve!;
    const styles = carveStyles(lab.settings);
    const { masks, w, h, used } = rasterizeMasks(ink.strokes, palette.length, c.rectMM[2], c.rectMM[3], TIMELAPSE_MM_PER_PX, limit);
    const layers = masks.flatMap((mask, i) => (used[i] ? [{ mask, style: styles[i] }] : []));
    const mmPerPx = c.rectMM[2] / w;
    const { rgba, height } = buildCarve(layers, { w, h, mmPerPx });
    writeShadow(rgba, height, w, h, mmPerPx, renderer.light.azimuth, renderer.light.elevation, 1);
    renderer.setCarve(rgba, w, h, c.rectMM);
  };
  const playTimelapse = async () => {
    if (!carve) return;
    timelapseRunning = true;
    skipTimelapse = false;
    document.body.classList.add("timelapse");
    const total = countStamps(ink.strokes);
    const frames = Math.min(48, Math.max(12, Math.ceil(total / 5)));
    const duration = Math.min(7000, Math.max(3000, total * 22));
    const t0 = performance.now();
    let built = -1;
    for (;;) {
      await nextFrame();
      const t = skipTimelapse ? 1 : Math.min(1, (performance.now() - t0) / duration);
      progress.style.transform = `scaleX(${t})`;
      if (t >= 1) break;
      const f = Math.floor(t * frames);
      if (f !== built) {
        timelapseFrame(Math.round(((f + 1) / frames) * total));
        built = f;
      }
    }
    // Full-resolution carving, then the guide sketch fades away.
    renderer.setCarve(carve.rgba, carve.w, carve.h, carve.rectMM);
    timelapseRunning = false;
    relight();
    document.body.classList.remove("timelapse");
    const g0 = +(inkCanvas.style.opacity || GUIDE_OPACITY);
    await animate(700, (k) => (inkCanvas.style.opacity = String(g0 * (1 - smooth(k)))));
    progress.style.transform = "scaleX(0)";
  };

  // Builds the carving of the current drawing in the drawing rectangle (no animation yet).
  const prepareCarve = () => {
    const { masks, w, h, used } = rasterizeMasks(ink.strokes, palette.length, rect.w, rect.h, CARVE_MM_PER_PX);
    const mmPerPx = rect.w / w;
    const rectMM: [number, number, number, number] = [rect.x, rect.y, rect.w, h * mmPerPx];
    carve = { masks, used, w, h, mmPerPx, rectMM, rgba: new Uint8Array(0), height: new Float32Array(0) };
    traceDirty = true;
    recarve();
    setPosted(false);
    return carve;
  };

  // Paper lifts off; the drawing stays as a faint guide sketch on the bare rock; then the timelapse.
  const presentCarve = async () => {
    renderer.carveAmount = 1;
    atHome = true;
    [camera.cx, camera.cy, camera.scale] = homeCamera();
    applyCamera();
    setView("rock", false);
    setMode("carve");
    setLight(defaultLight);
    paper.style.transition = "none";
    renderer.setCarve(new Uint8Array([128, 128, 0, 0]), 1, 1, carve!.rectMM);
    await animate(600, (t) => {
      paper.style.opacity = String(1 - smooth(t));
      inkCanvas.style.opacity = String(1 - (1 - GUIDE_OPACITY) * smooth(t));
    });
    if (ink.strokes.length > 0) await playTimelapse();
    else inkCanvas.style.opacity = "0";
  };

  /** The carving's bounding box on the wall in mm (with a margin), or the drawing rectangle. */
  const carveBBoxMM = (pad = 40): [number, number, number, number] => {
    const c = carve!;
    const bb = maskBBox(c.masks, c.w, c.h);
    if (!bb) return c.rectMM;
    const k = c.mmPerPx;
    return [c.rectMM[0] + bb[0] * k - pad, c.rectMM[1] + bb[1] * k - pad, (bb[2] - bb[0]) * k + 2 * pad, (bb[3] - bb[1]) * k + 2 * pad];
  };
  /** Frames the carving in the view (the result panel is taller than the drawing panel). */
  const focusCarving = () => {
    const [x, y, w, h] = carveBBoxMM();
    const home = rect.w / vw();
    const s = Math.min(home * 2, Math.max(home * 0.75, Math.max(w / vw(), h / vh()) * 1.2));
    atHome = false;
    return animateCamera([x + w / 2, y + h / 2, s], 600);
  };

  carveBtn.addEventListener("click", async () => {
    if (busy || ink.strokes.length === 0) return;
    busy = true;
    requestFull();
    carveBtn.textContent = "새기는 중…";
    await nextFrame();
    prepareCarve();
    carveBtn.textContent = "새기기";
    await presentCarve();
    busy = false;
    wallHint.classList.add("show");
  });

  $("replay").addEventListener("click", async () => {
    if (busy || !carve) return;
    busy = true;
    lab.toggle(false);
    labBtn.setAttribute("aria-expanded", "false");
    setView("rock");
    await goHome();
    renderer.setCarve(new Uint8Array([128, 128, 0, 0]), 1, 1, carve.rectMM);
    await animate(300, (t) => (inkCanvas.style.opacity = String(GUIDE_OPACITY * smooth(t))));
    await playTimelapse();
    busy = false;
  });

  // Back to the paper: the carving sinks back into the rock and the drawing returns.
  const backToDraw = async () => {
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
  };
  $("redraw").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    await backToDraw();
    busy = false;
  });

  // ---------------------------------------------------------------- 도전 모드
  // Prompt card → 3-2-1 → timer → drawing locks → silhouette to the scoring proxy while the
  // carving timelapse plays → result.
  const modeSeg = $("modeSeg");
  const syncModeSeg = () =>
    [...modeSeg.children].forEach((b) =>
      b.setAttribute("aria-checked", String(((b as HTMLElement).dataset.mode === "challenge") === (motif != null))),
    );
  const openCard = (m: Motif) => {
    motif = m;
    document.body.classList.add("challenge");
    ink.reset();
    ink.enabled = false;
    challengeUI.showCard(m);
    step.textContent = "도전";
    syncModeSeg();
    syncDraw();
  };
  const quitChallenge = () => {
    challengeUI.hideCard();
    challengeUI.finish("quit");
    motif = null;
    challengeResult = null;
    document.body.classList.remove("challenge", "ch-running");
    ink.enabled = true;
    setMode(mode);
    syncModeSeg();
    syncDraw();
  };
  modeSeg.addEventListener("click", async (e) => {
    const want = (e.target as HTMLElement).dataset.mode;
    if (busy || mode !== "draw" || !want) return;
    if (want === "challenge" && !motif) {
      if (ink.strokes.length > 0) {
        busy = true;
        const go = await dialog("도전 모드로 갈까요?", "도전은 빈 종이에서 시작해요.\n지금 그리던 그림은 지워져요.", [
          { label: "계속 그리기", value: false },
          { label: "도전하기", value: true, primary: true },
        ]);
        busy = false;
        if (!go) return;
      }
      openCard(pickMotif());
    }
    if (want === "free" && motif) quitChallenge();
  });
  $("cardSwap").addEventListener("click", () => motif && openCard(pickMotif(motif.id)));
  $("cardStart").addEventListener("click", async () => {
    if (busy || !motif) return;
    busy = true;
    challengeUI.hideCard();
    document.body.classList.add("ch-running");
    requestFull();
    await challengeUI.countdown();
    ink.enabled = true;
    busy = false;
    const timer = challengeUI.runTimer(motif);
    syncDraw();
    const why = await timer;
    ink.enabled = false;
    document.body.classList.remove("ch-running");
    if (why !== "quit") finishChallenge(why);
  });
  doneBtn.addEventListener("click", () => challengeUI.finish("done"));
  $("timerQuit").addEventListener("click", () => quitChallenge());

  const scoreNum = $("scoreNum"), resGuess = $("resGuess"), resComment = $("resComment");
  const mockBadge = $("mockBadge");
  const resultButtons = [...document.querySelectorAll<HTMLButtonElement>(".result-actions button")];
  const postRes = $<HTMLButtonElement>("postRes");
  const showScoring = (m: Motif) => {
    $("resPrompt").textContent = m.label;
    scoreNum.textContent = "…";
    resGuess.textContent = "새기는 동안 채점하고 있어요…";
    resComment.textContent = "";
    mockBadge.hidden = true;
    resultButtons.forEach((b) => (b.disabled = true));
  };
  const showResult = async (r: ScoreResult) => {
    mockBadge.hidden = !(r.mock || r.fallback);
    mockBadge.textContent = r.mock ? "모의 채점" : "임시 점수";
    resultButtons.forEach((b) => (b.disabled = false));
    postRes.disabled = r.flagged || ink.strokes.length === 0 || carvePosted;
    if (r.flagged) {
      scoreNum.textContent = "–";
      resGuess.textContent = "이 그림은 점수를 드릴 수 없어요.";
      resComment.textContent = "바위에는 모두가 함께 볼 수 있는 그림만 새길 수 있어요.";
      return;
    }
    resGuess.textContent = guessLine(r);
    resComment.textContent = r.comment;
    const target = r.match ?? 0;
    await animate(Math.min(1200, 300 + target * 10), (t) => (scoreNum.textContent = String(Math.round(target * smooth(t)))));
  };

  const finishChallenge = async (why: TimerEnd) => {
    const m = motif!;
    busy = true;
    syncDraw();
    if (why === "timeup") {
      toast("그만! 시간이 다 됐어요", 1400);
      await sleep(900);
    }
    prepareCarve();
    const png = silhouettePNG(carve!.masks, carve!.w, carve!.h);
    showScoring(m);
    const scoring = png ? requestScore(png, m.id) : Promise.resolve(EMPTY_RESULT);
    await presentCarve();
    const r = await scoring;
    if (motif !== m) return; // left the challenge meanwhile
    challengeResult = r;
    await Promise.all([showResult(r), focusCarving()]);
    busy = false;
  };

  const restartChallenge = async (m: Motif) => {
    if (busy) return;
    busy = true;
    ink.reset();
    await backToDraw();
    openCard(m);
    busy = false;
  };
  $("retry").addEventListener("click", () => motif && restartChallenge(motif));
  $("nextPrompt").addEventListener("click", () => motif && restartChallenge(pickMotif(motif.id)));
  syncModeSeg();

  // ---------------------------------------------------------------- 공유하기 (share image)
  const share = new ShareSheet();
  const openShare = () => {
    if (busy || !carve) return;
    const r = challengeResult;
    const badge = motif ? `도전 · ${motif.label}${r && !r.flagged && r.match != null ? ` · ${r.match}점` : ""}` : undefined;
    share.open({
      badge,
      rock: async (size) => {
        await Promise.race([requestFull(), sleep(6000)]);
        const { w, h, textFrac } = SHARE_SIZES[size];
        const crop = shareCrop(carveBBoxMM(60), meta.width_mm, meta.height_mm, w / h, textFrac);
        return renderer.snapshot(crop, w, h);
      },
    });
  };
  $("shareFree").addEventListener("click", openShare);
  $("shareRes").addEventListener("click", openShare);

  // ---------------------------------------------------------------- 모두의 벽 (shared wall)
  // Every carving is rebuilt from its strokes into one carve layer covering a window around
  // the view, at a resolution that follows the zoom. Only carvings in the window are loaded.
  const guestbook = new Guestbook();
  const hl = $("hl"), wallInfo = $("wallInfo"), wallCount = $("wallCount");
  const postOk = $<HTMLButtonElement>("postOk"), postMsg = $<HTMLInputElement>("postMsg");
  const postButtons = [$<HTMLButtonElement>("postFree"), postRes];
  let wallFrom: Mode = "draw";
  let wallWin: WallWindow | null = null;
  let wallRes: WallLayerResult | null = null;
  let wallLoaded: Carving[] = [];
  let wallGen = 0;
  let wallTimer = 0;
  let selected: Carving | null = null;
  /** The visitor's carving at its proposed spot, while confirming 벽에 남기기. */
  let pending: Carving | null = null;
  let draftBase: CarvingDraft | null = null;
  let spots: Rect[] = [];
  let spotIdx = 0;
  let carvePosted = false;
  function setPosted(v: boolean) {
    carvePosted = v;
    for (const b of postButtons) {
      b.textContent = v ? "벽에 남겼어요" : "벽에 남기기";
      b.disabled = v || (b === postRes && (challengeResult?.flagged ?? false));
    }
  }

  const relightWall = () => {
    if (!wallRes) return;
    const { rgba, height, w, h, mmPerPx } = wallRes;
    writeShadow(rgba, height, w, h, mmPerPx, renderer.light.azimuth, renderer.light.elevation, mmPerPx >= 2 ? 1 : 2);
    renderer.updateCarve(rgba);
  };

  const buildWall = async (force = false) => {
    if (mode !== "wall") return;
    const view = camera.rect(vw(), vh());
    const win = windowFor(view, meta.width_mm, meta.height_mm, layerResolution(camera.scale / Math.min(window.devicePixelRatio || 1, 2)));
    if (!force && wallWin && windowCovers(wallWin, view, win.mmPerPx)) return;
    const gen = ++wallGen;
    let list: Carving[];
    try {
      list = await guestbook.list(win.rect);
    } catch (err) {
      console.warn(err);
      toast("벽을 불러오지 못했어요");
      return;
    }
    if (gen !== wallGen || mode !== "wall") return;
    if (pending) list = [...list, pending];
    wallLoaded = list;
    placeMarks();
    wallWin = win;
    wallRes = wallLayer.build(list, win, carveStyles(lab.settings));
    renderer.setCarve(wallRes.rgba, win.w, win.h, win.rect);
    renderer.carveAmount = 1;
    relightWall();
    $("wallBadge").hidden = guestbook.mode !== "local";
  };

  const placeHighlight = () => {
    const c = pending ?? selected;
    if (mode !== "wall" || !c) return hl.classList.remove("show");
    const [vx, vy] = camera.rect(vw(), vh()), s = camera.scale;
    Object.assign(hl.style, {
      left: `${(c.x_mm - vx) / s}px`, top: `${(c.y_mm - vy) / s}px`, width: `${c.w_mm / s}px`, height: `${c.h_mm / s}px`,
    });
    hl.classList.add("show");
    hl.classList.toggle("pending", c === pending);
  };
  // Zoomed out, carvings are a few pixels wide: faint markers show where they are.
  const marks = $("marks");
  const MARK_SCALE = 7; // mm per CSS px
  const placeMarks = () => {
    const show = mode === "wall" && camera.scale > MARK_SCALE;
    if (!show) return void (marks.innerHTML = "");
    const [vx, vy] = camera.rect(vw(), vh()), s = camera.scale, mine = guestbook.mine();
    const items = wallLoaded.filter((c) => c !== pending).slice(0, 400);
    while (marks.childElementCount > items.length) marks.lastElementChild!.remove();
    while (marks.childElementCount < items.length) marks.appendChild(document.createElement("i"));
    items.forEach((c, i) => {
      const el = marks.children[i] as HTMLElement;
      el.style.left = `${(c.x_mm + c.w_mm / 2 - vx) / s}px`;
      el.style.top = `${(c.y_mm + c.h_mm / 2 - vy) / s}px`;
      el.classList.toggle("mine", mine.has(c.id));
    });
  };
  onWallCamera = () => {
    if (mode !== "wall") return;
    placeHighlight();
    placeMarks();
    clearTimeout(wallTimer);
    wallTimer = window.setTimeout(() => buildWall(), 180);
  };

  const showWallInfo = () => {
    const c = selected;
    if (!c) {
      wallInfo.textContent = "새김을 눌러 보세요";
      return;
    }
    const parts: string[] = [];
    if (guestbook.mine().has(c.id)) parts.push("내 새김");
    if (c.id.startsWith("sample-")) parts.push("예시 새김");
    else parts.push(koreanDate(new Date(c.created_at)));
    const m = motifById(c.prompt);
    if (m) parts.push(`도전 ${m.label}${c.score != null ? ` ${c.score}점` : ""}`);
    wallInfo.textContent = parts.join(" · ");
  };
  const wallTap = (sx: number, sy: number) => {
    if (mode !== "wall" || pending || busy) return;
    const [mx, my] = camera.toMM(sx, sy, vw(), vh());
    // Inside a carving's box, or (zoomed out) within 22 px of its marker.
    const near = 22 * camera.scale;
    const dist = (c: Carving) => Math.hypot(mx - (c.x_mm + c.w_mm / 2), my - (c.y_mm + c.h_mm / 2));
    const hits = wallLoaded.filter(
      (c) => (mx >= c.x_mm && my >= c.y_mm && mx <= c.x_mm + c.w_mm && my <= c.y_mm + c.h_mm) || (camera.scale > MARK_SCALE && dist(c) < near),
    );
    selected = hits.sort((a, b) => dist(a) - dist(b))[0] ?? null;
    showWallInfo();
    placeHighlight();
  };
  const refreshCount = () =>
    guestbook
      .list([0, 0, meta.width_mm, meta.height_mm], true)
      .then((all) => (wallCount.textContent = `새김 ${all.length}개`))
      .catch(() => (wallCount.textContent = ""));

  /** Camera that shows `r` at about half the screen width. */
  const focusOn = (r: Rect): [number, number, number] => {
    const s = Math.max(r[2] / vw(), r[3] / vh()) * 2.2;
    return [r[0] + r[2] / 2, r[1] + r[3] / 2, Math.min(s, fitScale(vw(), vh(), limits()))];
  };

  const enterWall = async (focus?: Rect) => {
    if (mode !== "wall") wallFrom = mode;
    lab.toggle(false);
    labBtn.setAttribute("aria-expanded", "false");
    wallHint.classList.remove("show");
    setView("rock", false);
    if (wallFrom === "draw") renderer.carveAmount = 0;
    setMode("wall");
    selected = null;
    showWallInfo();
    wallWin = null;
    requestFull();
    refreshCount();
    atHome = false;
    await animateCamera(focus ? focusOn(focus) : [meta.width_mm / 2, meta.height_mm / 2, fitScale(vw(), vh(), limits())], 800);
    await buildWall(true);
  };

  const leaveWall = async () => {
    pending = null;
    selected = null;
    document.body.classList.remove("posting");
    hl.classList.remove("show");
    marks.innerHTML = "";
    wallWin = wallRes = null;
    wallGen++;
    const back = wallFrom;
    setMode(back);
    if (carve) {
      renderer.setCarve(carve.rgba, carve.w, carve.h, carve.rectMM);
      relight();
    }
    renderer.carveAmount = back === "carve" ? 1 : 0;
    await goHome();
  };

  $("wallBtn").addEventListener("click", () => {
    if (busy) return;
    busy = true;
    enterWall().finally(() => (busy = false));
  });
  $("wallBack").addEventListener("click", () => {
    if (busy) return;
    busy = true;
    leaveWall().finally(() => (busy = false));
  });

  // ---- 벽에 남기기: geolocation → a free spot → confirm (message) → moderation → stored.
  /** The current carving as a wall row: strokes cropped to the carving (+ bevel margin). */
  const makeDraft = (): CarvingDraft | null => {
    const c = carve!;
    const bb = maskBBox(c.masks, c.w, c.h);
    if (!bb) return null;
    const k = c.mmPerPx, pad = 16;
    const x0 = Math.max(0, bb[0] * k - pad), y0 = Math.max(0, bb[1] * k - pad);
    const x1 = Math.min(c.rectMM[2], bb[2] * k + pad), y1 = Math.min(c.rectMM[3], bb[3] * k + pad);
    const w = Math.max(LIMITS.minSize, x1 - x0), h = Math.max(LIMITS.minSize, y1 - y0);
    const strokes = toWallStrokes(ink.strokes, x0, y0);
    // Very long drawings: thin the points until they fit the row limit.
    while (strokes.reduce((n, s) => n + s.p.length, 0) > LIMITS.maxPoints) {
      for (const s of strokes) s.p = s.p.filter((_, i) => i % 4 < 2 || i >= s.p.length - 2);
    }
    if (strokes.length > LIMITS.maxStrokes) return null;
    const r = challengeResult;
    return {
      x_mm: c.rectMM[0] + x0, y_mm: c.rectMM[1] + y0, w_mm: w, h_mm: h, src_w: w, src_h: h, strokes,
      prompt: motif?.id ?? null,
      score: motif && r && !r.flagged && !r.fallback ? r.match : null,
    };
  };

  /** Free spots for the draft: its own spot first; smaller sizes if the wall is crowded. */
  const findSpotsFor = async (d: CarvingDraft): Promise<Rect[]> => {
    const [mask, all] = await Promise.all([getPlacementMask(), guestbook.list([0, 0, meta.width_mm, meta.height_mm], true)]);
    const taken = all.map(rectOf);
    for (const k of [1, 0.75, 0.55]) {
      const w = d.w_mm * k, h = d.h_mm * k;
      const found = findSpots(w, h, [d.x_mm + (d.w_mm - w) / 2, d.y_mm + (d.h_mm - h) / 2], {
        wallW: meta.width_mm, wallH: meta.height_mm, taken, allowed: (r) => placementOK(mask, r),
      });
      if (found.length) return found;
    }
    return [];
  };

  const setPending = () => {
    const [x, y, w, h] = spots[spotIdx];
    pending = { ...draftBase!, x_mm: x, y_mm: y, w_mm: w, h_mm: h, id: "pending", created_at: new Date().toISOString() };
  };

  const syncPostCount = () => ($("postCount").textContent = `${[...postMsg.value].length}/40`);
  postMsg.addEventListener("input", () => {
    const v = clipMessage(postMsg.value);
    if (v !== postMsg.value) postMsg.value = v;
    syncPostCount();
  });

  const startPost = async () => {
    if (busy || !carve || carvePosted || ink.strokes.length === 0) return;
    if (motif && challengeResult?.flagged) return;
    busy = true;
    try {
      if (!geoBypassed()) toast("위치를 확인하는 중…", 12_000);
      const geo = await checkNearSite();
      if (geo !== "ok") {
        toast("", 1);
        const go = await dialog("벽에 남길 수 없어요", GEO_TEXT[geo], [
          { label: "닫기", value: false },
          { label: "모두의 벽 구경", value: true, primary: true },
        ]);
        if (go) await enterWall();
        return;
      }
      const d = makeDraft();
      if (!d) {
        toast("그림이 너무 복잡해서 남길 수 없어요");
        return;
      }
      toast("빈자리를 찾는 중…", 4000);
      let found: Rect[];
      try {
        found = await findSpotsFor(d);
      } catch (err) {
        console.warn(err);
        toast("벽을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      toast("", 1);
      if (!found.length) {
        await dialog("벽이 가득 찼어요", "지금은 빈자리가 없어요.\n다음에 다시 찾아 주세요.", [{ label: "확인", value: 0, primary: true }]);
        return;
      }
      draftBase = d;
      spots = found;
      spotIdx = 0;
      setPending();
      postMsg.value = share.message;
      syncPostCount();
      document.body.classList.add("posting");
      await enterWall(spots[0]);
    } finally {
      busy = false;
    }
  };
  for (const b of postButtons) b.addEventListener("click", startPost);
  if (import.meta.env.DEV) {
    // Test hook for the headless screen checks (not in production builds).
    Object.assign(window, {
      __amg: {
        lookAt: (x: number, y: number, s: number) => {
          [camera.cx, camera.cy, camera.scale] = [x, y, s];
          atHome = false;
          applyCamera();
        },
        cam: () => [camera.cx, camera.cy, camera.scale, vw(), vh()],
        wall: () => wallRes && { r: wallRes.mmPerPx, w: wallRes.w, h: wallRes.h, rect: wallRes.rect, n: wallLoaded.length, minH: wallRes.height.reduce((a, b) => Math.min(a, b), 0) },
      },
    });
  }

  $("postOther").addEventListener("click", async () => {
    if (busy || !pending) return;
    if (spots.length < 2) return toast("다른 빈자리가 없어요");
    busy = true;
    spotIdx = (spotIdx + 1) % spots.length;
    setPending();
    placeHighlight();
    await animateCamera(focusOn(spots[spotIdx]), 600);
    await buildWall(true);
    busy = false;
  });
  $("postCancel").addEventListener("click", () => {
    if (busy) return;
    busy = true;
    leaveWall().finally(() => (busy = false));
  });

  const REJECT: Record<string, [string, string]> = {
    flagged: ["바위에 새길 수 없는 그림이에요", "모두가 함께 보는 벽이라 이 그림은 남길 수 없어요.\n다른 그림으로 다시 도전해 볼까요?"],
    message: ["메시지를 고쳐 주세요", "메시지에 벽에 남기기 어려운 말이 있어요.\n고치거나 비워 두고 다시 눌러 주세요."],
    limited: ["잠시 후에 다시 남겨 주세요", "짧은 시간에 너무 많이 남겼어요.\n조금 쉬었다가 다시 시도해 주세요."],
    invalid: ["남길 수 없어요", "그림을 저장하지 못했어요. 다시 그려 볼까요?"],
    error: ["지금은 남길 수 없어요", "연결이 불안정해요. 잠시 후 다시 시도해 주세요."],
  };
  postOk.addEventListener("click", async () => {
    if (busy || !pending || !carve) return;
    busy = true;
    postOk.textContent = "확인하는 중…";
    postOk.disabled = true;
    const message = clipMessage(postMsg.value.trim());
    share.setMessage(message);
    const { id: _id, created_at: _at, ...draft } = pending;
    const png = silhouettePNG(carve.masks, carve.w, carve.h) ?? "";
    const res = await guestbook.post(draft, png, message);
    postOk.textContent = "새기기";
    postOk.disabled = false;
    if (res.ok) {
      pending = null;
      selected = res.carving;
      document.body.classList.remove("posting");
      setPosted(true);
      await buildWall(true);
      showWallInfo();
      placeHighlight();
      refreshCount();
      toast("모두의 벽에 새겼어요!");
    } else {
      const [title, text] = REJECT[res.reason] ?? REJECT.error;
      await dialog(title, text, [{ label: "확인", value: 0, primary: true }]);
      if (res.reason === "flagged") {
        setPosted(false);
        postButtons.forEach((b) => (b.disabled = true));
        await leaveWall();
      }
    }
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
