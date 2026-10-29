// 암각화몬: draw straight on the scanned Bangudae wall; every stroke is carved into the rock
// as soon as the finger lifts (실시간 새김), lit by a raking light.

import type { RelayDrawing } from "../shared/relay";
import { fitPoints, LIMITS, rectOf, type Carving, type CarvingDraft, type Rect } from "../shared/wall";
import { clipMessage } from "../shared/moderation";
import { checkNearSite, GEO_TEXT, geoBypassed } from "./guestbook/geo";
import { fromWallStrokes, toWallStrokes } from "./guestbook/serialize";
import { findSpots } from "./guestbook/spot";
import { Guestbook } from "./guestbook/store";
import { layerResolution, WallLayer, windowCovers, windowFor, type WallLayerResult, type WallWindow } from "./guestbook/wallLayer";
import { buildCarve } from "./carve/carve";
import { maskBBox, silhouettePNG } from "./carve/silhouette";
import { LiveCarve } from "./carve/liveCarve";
import { writeShadow } from "./carve/shadow";
import { tracingLabels } from "./carve/tracing";
import { BRUSH_MM, CARVE_KEYS, CARVE_MM_PER_PX, carveStyles, defaultLab, loadMeta, PALETTE, type WallMeta } from "./config";
import { Ink } from "./draw/ink";
import { countStamps, rasterizeMasks, setBrushRoughness, type Stroke } from "./draw/strokes";
import { setupDrawTools } from "./ui/drawTools";
import { Lab } from "./ui/lab";
import { koreanDate, shareCrop } from "./share/layout";
import { Relay } from "./relay/relay";
import { LightDial } from "./ui/lightDial";
import { dialog, toast } from "./ui/notice";
import { paintTracing } from "./ui/tracingCanvas";
import { attachViewGestures } from "./ui/viewGestures";
import { Camera, fitScale, niceLength, type CameraLimits } from "./wall/camera";
import { allowedAt, loadPlacementMask, placementOK, type PlacementMask } from "./wall/placement";
import { WallRenderer } from "./wall/renderer";
import { loadFull, loadOverview } from "./wall/textures";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLElement>("view");
const status = $<HTMLElement>("status");

type Mode = "draw" | "carve" | "wall";
type View = "rock" | "rubbing" | "tracing";
let mode: Mode = "draw";
let viewMode: View = "rock";
let busy = false;

/** Smallest free spot (mm) a drawing starts at when the wall is crowded. */
const SPOT_MM = 600;
/** One drawing fits in this many mm each way (keeps the live carving quick on phones). */
const MAX_DRAWING_MM = 1500;
/** Empty carve layer. */
const FLAT = new Uint8Array([128, 128, 0, 0]);

const smooth = (t: number) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const guestbook = new Guestbook();
  renderer.carveAmount = 1;

  // The lab comes first: the live carving reads its carve settings.
  const lab = new Lab($("lab"), defaultLab(), defaultLab());
  const styles = () => carveStyles(lab.settings);
  const live = new LiveCarve(palette.length, CARVE_MM_PER_PX);

  // ---------------------------------------------------------------- camera
  // "Home" is the free spot the drawing started at, at the drawing scale (700 mm across).
  const drawW = meta.carving.drawing_width_mm;
  const spot = { cx: meta.carving.demo_center_mm[0], cy: meta.carving.demo_center_mm[1] };
  const camera = new Camera(spot.cx, spot.cy, 1);
  let atHome = true;
  let zoomedOut = false; // 전체 보기 is showing (the toggle then reads 내 새김)
  const vw = () => view.clientWidth, vh = () => view.clientHeight;
  const homeScale = () => drawW / vw();
  // While drawing the zoom stays near the drawing scale, so brush sizes keep their meaning.
  const limits = (): CameraLimits =>
    mode === "draw"
      ? { wallW: meta.width_mm, wallH: meta.height_mm, minScale: homeScale() / 3, maxScale: homeScale() * 2 }
      : { wallW: meta.width_mm, wallH: meta.height_mm, minScale: homeScale() / 4 };
  const homeCamera = (): [number, number, number] => [spot.cx, spot.cy, homeScale()];

  const inkView = () => {
    const [x, y] = camera.rect(vw(), vh());
    return { x, y, scale: camera.scale };
  };
  const ink = new Ink($("ink"), palette, inkView, BRUSH_MM.default);
  let syncTools = () => {};
  // 이어 그리기 (set up further down)
  let relayActive = () => false;
  let relayDrawing = () => false;

  const applyCamera = () => {
    renderer.view = camera.rect(vw(), vh());
    renderer.invalidate();
    ink.redraw();
    placeTrace();
    syncZoomUI();
    syncTools();
    onWallCamera();
  };
  let onWallCamera = () => {};
  const layout = () => {
    if (atHome) [camera.cx, camera.cy, camera.scale] = homeCamera();
    else camera.clamp(vw(), vh(), limits());
    ink.resize();
    applyCamera();
  };
  // The tracing canvas covers the carve region and follows the camera.
  const traceCanvas = $<HTMLCanvasElement>("trace");
  const placeTrace = () => {
    if (live.empty) return;
    const [vx, vy] = camera.rect(vw(), vh()), [x, y, w, h] = live.rectMM, s = camera.scale;
    Object.assign(traceCanvas.style, {
      left: `${(x - vx) / s}px`, top: `${(y - vy) / s}px`, width: `${w / s}px`, height: `${h / s}px`,
    });
  };

  // Zoom controls + scale bar (carve and wall screens).
  const zoomToggle = $<HTMLButtonElement>("zoomToggle");
  const scaleBar = $("scalebar");
  const syncZoomUI = () => {
    zoomToggle.textContent = zoomedOut && mode !== "wall" ? "내 새김" : "전체 보기";
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
  const zoomBy = (f: number) => {
    const c = new Camera(camera.cx, camera.cy, camera.scale);
    c.zoomAt(f, vw() / 2, vh() / 2, vw(), vh(), limits());
    atHome = false;
    animateCamera([c.cx, c.cy, c.scale], 220);
  };
  $("zoomIn").addEventListener("click", () => zoomBy(1.6));
  $("zoomOut").addEventListener("click", () => zoomBy(1 / 1.6));
  zoomToggle.addEventListener("click", async () => {
    if (busy) return;
    if (!zoomedOut || mode === "wall") {
      atHome = false;
      zoomedOut = mode !== "wall";
      await animateCamera([meta.width_mm / 2, meta.height_mm / 2, fitScale(vw(), vh(), limits())], 700);
    } else {
      zoomedOut = false;
      await focusCarving();
    }
    syncZoomUI();
  });

  new ResizeObserver(layout).observe(view);

  // ---------------------------------------------------------------- free spots
  let placementMask: PlacementMask | null = null;
  let maskLoad: Promise<PlacementMask> | null = null;
  const getPlacementMask = () =>
    (maskLoad ??= loadPlacementMask(meta).then((m) => (placementMask = m)).catch((err) => {
      maskLoad = null;
      throw err;
    }));

  /**
   * Centre (mm) of a random free spot on allowed wall, away from everyone's carvings: about
   * the size of the screen at the drawing scale, so the view starts on rock; smaller if crowded.
   */
  const pickSpot = async (): Promise<[number, number] | null> => {
    const [mask, all] = await Promise.all([getPlacementMask(), guestbook.list([0, 0, meta.width_mm, meta.height_mm], true)]);
    const taken = all.map(rectOf);
    const viewH = Math.min(vh() * homeScale() * 0.85, 1000);
    for (const [w, h] of [[drawW, viewH], [SPOT_MM, SPOT_MM]]) {
      const preferred: [number, number] = [Math.random() * (meta.width_mm - w), Math.random() * (meta.height_mm - h)];
      const [r] = findSpots(w, h, preferred, {
        wallW: meta.width_mm, wallH: meta.height_mm, taken, allowed: (r) => placementOK(mask, r), max: 1,
      });
      if (r) return [r[0] + r[2] / 2, r[1] + r[3] / 2];
    }
    return null;
  };
  /** Moves home to a new free spot (the demo spot if none is found in time). */
  const goToNewSpot = async (animated: boolean) => {
    const found = await Promise.race([
      pickSpot().catch((err) => (console.warn("no free spot", err), null)),
      sleep(3000).then(() => null),
    ]);
    if (found) [spot.cx, spot.cy] = found;
    zoomedOut = false;
    if (animated) await animateCamera(homeCamera(), 700);
    atHome = true;
    layout();
  };

  // ---------------------------------------------------------------- textures
  let fullLoad: Promise<void> | null = null;
  /** Starts loading the full-res wall (once); resolves when it is shown (or failed). */
  const requestFull = () =>
    (fullLoad ??= loadFull(meta)
      .then((img) => renderer.setWall(img, "full"))
      .catch((err) => console.warn("full-res wall failed, staying on overview", err)));
  Promise.all([loadOverview(meta), goToNewSpot(false)])
    .then(([img]) => {
      renderer.setWall(img, "overview");
      renderer.setDetail(img.detail);
      status.classList.add("done");
    })
    .catch(fail);

  // ---------------------------------------------------------------- live carving
  // The carve layer on the GPU follows `live`; other layers (timelapse frames, the shared
  // wall) reset `carveShown` so the next upload sends the whole layer again.
  let carveShown = -1;
  let timelapseRunning = false;
  let traceDirty = true;
  const showLive = () => {
    if (live.empty) {
      renderer.setCarve(FLAT, 1, 1, [0, 0, 1, 1]);
      carveShown = -1;
    } else if (carveShown !== live.version) {
      renderer.setCarve(live.rgba, live.w, live.h, live.rectMM);
      carveShown = live.version;
    } else renderer.updateCarve(live.rgba);
  };
  /** Cast shadow for the current light, then upload. */
  const relightLive = () => {
    if (!live.empty) {
      const { azimuth, elevation } = renderer.light;
      writeShadow(live.rgba, live.height, live.w, live.h, live.mmPerPx, azimuth, elevation);
    }
    showLive();
  };
  const carveChanged = () => {
    traceDirty = true;
    if (mode === "wall") return;
    relightLive();
    placeTrace();
    if (viewMode === "tracing") paintTrace();
  };
  const paintTrace = () => {
    if (live.empty || !traceDirty) return;
    const sigmas = styles().map((s) => s.bevel_sigma_mm / live.mmPerPx);
    const masks = live.masks.map((m, i) => (live.used[i] ? m : new Float32Array(m.length)));
    paintTracing(traceCanvas, tracingLabels(masks, sigmas, live.w, live.h), live.w, live.h, palette);
    placeTrace();
    traceDirty = false;
  };

  // Strokes carve the moment they end; undo / clear re-carve the area they covered.
  ink.onEdit = (changed) => {
    live.update(ink.strokes, changed, styles());
    carveChanged();
    setPosted(false);
  };
  /** Points (mm) of a stroke that fall on wall where carving is allowed. */
  const onAllowedWall = (s: Stroke) => {
    if (!placementMask) return true;
    let ok = 0;
    for (let i = 0; i < s.points.length; i += 2) if (allowedAt(placementMask, s.points[i], s.points[i + 1])) ok++;
    return ok * 2 >= s.points.length / 2;
  };
  ink.accept = (s) => {
    if (ink.strokes.length >= LIMITS.maxStrokes) return toast("더 그릴 수 없어요. 이제 완성해 볼까요?"), false;
    if (!onAllowedWall(s)) return toast("여기는 새길 수 없어요"), false;
    const b = live.carveBounds([...ink.strokes, s], styles());
    if (b && (b[2] - b[0] > MAX_DRAWING_MM || b[3] - b[1] > MAX_DRAWING_MM)) {
      toast(`한 그림은 ${MAX_DRAWING_MM / 1000} m 안에 그려 주세요`);
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------- draw tools
  syncTools = setupDrawTools(ink, palette, () => 1 / camera.scale);
  const hint = $("hint");
  const carveBtn = $<HTMLButtonElement>("carve");
  const doneBtn = $<HTMLButtonElement>("done");
  const syncDraw = () => {
    hint.classList.toggle("hidden", ink.strokes.length > 0);
    carveBtn.disabled = ink.strokes.length === 0;
    doneBtn.disabled = ink.strokes.length === 0 || !relayDrawing();
    syncTools();
  };
  ink.onChange = syncDraw;
  syncDraw();
  layout();

  // ---------------------------------------------------------------- lab
  // Shading sliders apply at once; carve sliders re-carve the whole drawing at most every ~120 ms.
  renderer.setLook(lab.settings);
  setBrushRoughness(lab.settings.brush_roughness);
  let labTimer = 0;
  lab.onChange = (settings, key) => {
    renderer.setLook(settings);
    if (key && !CARVE_KEYS.includes(key)) return;
    wallLayer.lookVersion++;
    setBrushRoughness(settings.brush_roughness);
    if (labTimer) return;
    labTimer = window.setTimeout(() => {
      labTimer = 0;
      live.rebuild(ink.strokes, styles());
      carveChanged();
      if (mode === "wall") buildWall(true);
    }, 120);
  };
  lab.extra = () => ({ azimuth_deg: renderer.light.azimuth, elevation_deg: renderer.light.elevation });
  const labBtn = $("labBtn");
  labBtn.addEventListener("click", () => labBtn.setAttribute("aria-expanded", String(lab.toggle())));
  const closeLab = () => {
    lab.toggle(false);
    labBtn.setAttribute("aria-expanded", "false");
  };

  // ---------------------------------------------------------------- light
  const dial = new LightDial(renderer.light);
  $("dialHost0").appendChild(dial.el);
  // The dial moves with the panel: drawing, the carve panel, the wall.
  const placeDial = () => {
    const host = $(mode === "draw" ? "dialHost0" : mode === "wall" ? "dialHost3" : "dialHost");
    if (dial.el.parentElement !== host) host.appendChild(dial.el);
  };
  // The carving's cast shadow depends on the light: recompute it at most once per frame.
  let shadowQueued = false;
  const relight = () => {
    shadowQueued = false;
    if (mode === "wall") return relightWall();
    if (live.empty || timelapseRunning) return;
    relightLive();
  };
  const setLight = (l: typeof renderer.light) => {
    renderer.light = { ...l };
    renderer.invalidate();
    if (!shadowQueued) {
      shadowQueued = true;
      requestAnimationFrame(relight);
    }
  };
  dial.onInput = (l) => setLight(l);

  // One finger draws on the rock (draw mode); two fingers move and zoom; elsewhere a drag pans.
  const wallHint = $("wallhint");
  attachViewGestures(view, {
    enabled: () => !busy,
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
    draw: {
      active: () => mode === "draw" && !busy,
      begin: (x, y) => {
        if (!ink.enabled) return false;
        requestFull();
        hint.classList.add("hidden");
        return ink.begin(x, y);
      },
      move: (p) => ink.extend(p),
      end: () => ink.end(),
      cancel: () => {
        ink.cancel();
        syncDraw();
      },
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
  const inkCanvas = $("ink");
  const step = $("step");
  const setMode = (m: Mode) => {
    mode = m;
    document.body.classList.remove("mode-draw", "mode-carve", "mode-wall");
    document.body.classList.add(`mode-${m}`);
    step.textContent = m === "wall" ? "모두의 벽" : relayActive() ? "이어 그리기" : { draw: "그리기", carve: "새김 보기" }[m];
    placeDial();
    camera.clamp(vw(), vh(), limits());
    applyCamera();
  };
  setMode("draw");
  setView("rock", false);

  // ---------------------------------------------------------------- timelapse
  // The carving is pecked mark by mark in drawing order. Frames are built at 2 mm/px (a quarter
  // of the pixels) so they keep up; the live 1 mm/px carving replaces them at the end.
  // The drawing shows as a faint guide sketch meanwhile. A tap on the wall skips to the end.
  const GUIDE_OPACITY = 0.35;
  const TIMELAPSE_MM_PER_PX = 2;
  const progress = $("progress");
  let skipTimelapse = false;
  view.addEventListener("pointerdown", () => {
    if (timelapseRunning) skipTimelapse = true;
  });
  const timelapseFrame = (limit: number) => {
    const st = styles();
    const [rx, ry, rw, rh] = live.rectMM;
    const { masks, w, h } = rasterizeMasks(ink.strokes, palette.length, rw, rh, TIMELAPSE_MM_PER_PX, limit, rx, ry);
    const layers = masks.flatMap((mask, i) => (mask.some((v) => v > 0) ? [{ mask, style: st[i], key: i }] : []));
    const mmPerPx = rw / w;
    const { rgba, height } = buildCarve(layers, { w, h, mmPerPx, origin: [Math.round(rx / mmPerPx), Math.round(ry / mmPerPx)] });
    writeShadow(rgba, height, w, h, mmPerPx, renderer.light.azimuth, renderer.light.elevation, 1);
    renderer.setCarve(rgba, w, h, live.rectMM);
    carveShown = -1;
  };
  const playTimelapse = async () => {
    if (live.empty) return;
    timelapseRunning = true;
    skipTimelapse = false;
    document.body.classList.add("timelapse");
    renderer.setCarve(FLAT, 1, 1, live.rectMM);
    carveShown = -1;
    ink.guide = true;
    ink.redraw();
    await animate(300, (t) => (inkCanvas.style.opacity = String(1 - (1 - GUIDE_OPACITY) * smooth(t))));
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
    timelapseRunning = false;
    relightLive();
    document.body.classList.remove("timelapse");
    await animate(700, (k) => (inkCanvas.style.opacity = String(GUIDE_OPACITY * (1 - smooth(k)))));
    ink.guide = false;
    ink.redraw();
    inkCanvas.style.opacity = "1";
    progress.style.transform = "scaleX(0)";
  };

  /** The carving's bounding box on the wall in mm (with a margin), or the home view. */
  const carveBBoxMM = (pad = 40): [number, number, number, number] => {
    const bb = live.empty ? null : maskBBox(live.masks, live.w, live.h);
    if (!bb) return camera.rect(vw(), vh());
    const [rx, ry] = live.rectMM, k = live.mmPerPx;
    return [rx + bb[0] * k - pad, ry + bb[1] * k - pad, (bb[2] - bb[0]) * k + 2 * pad, (bb[3] - bb[1]) * k + 2 * pad];
  };
  /** Frames the carving in the view (the result panel is taller than the drawing panel). */
  const focusCarving = () => {
    const [x, y, w, h] = carveBBoxMM();
    const home = homeScale();
    const s = Math.min(home * 2, Math.max(home * 0.75, Math.max(w / vw(), h / vh()) * 1.2));
    atHome = false;
    return animateCamera([x + w / 2, y + h / 2, s], 600);
  };

  // 완성: the drawing is already carved; show it with the light, views and 벽에 남기기.
  const presentCarve = async () => {
    setView("rock", false);
    setMode("carve");
    zoomedOut = false;
    await focusCarving();
  };
  carveBtn.addEventListener("click", async () => {
    if (busy || ink.strokes.length === 0 || ink.drawing) return;
    busy = true;
    requestFull();
    await presentCarve();
    busy = false;
    wallHint.classList.add("show");
  });

  $("replay").addEventListener("click", async () => {
    if (busy || live.empty) return;
    busy = true;
    closeLab();
    setView("rock");
    await playTimelapse();
    busy = false;
  });

  // Back to drawing on the same rock (the carving stays).
  const backToDraw = async () => {
    setView("rock");
    setMode("draw");
    await nextFrame();
  };
  $("redraw").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    await backToDraw();
    busy = false;
  });

  // ---------------------------------------------------------------- 모드: 자유 | 이어 그리기
  const modeSeg = $("modeSeg");
  const syncModeSeg = () => {
    const on = relayActive() ? "relay" : "free";
    [...modeSeg.children].forEach((b) => b.setAttribute("aria-checked", String((b as HTMLElement).dataset.mode === on)));
  };
  modeSeg.addEventListener("click", async (e) => {
    const want = (e.target as HTMLElement).dataset.mode;
    if (busy || mode !== "draw" || want !== "relay" || relayActive()) return;
    busy = true;
    const go =
      ink.strokes.length === 0 ||
      (await dialog("이어 그리기로 갈까요?", "친구들과 문장을 새김으로, 새김을 문장으로 이어 가요.\n지금 그리던 그림은 지워져요.", [
        { label: "계속 그리기", value: false },
        { label: "이어 그리기", value: true, primary: true },
      ]));
    busy = false;
    if (go) void relay.open();
  });
  doneBtn.addEventListener("click", () => relayDrawing() && relay.finishDrawing());
  $("timerQuit").addEventListener("click", () => relayActive() && relay.quit());
  syncModeSeg();

  // ---------------------------------------------------------------- 모두의 벽 (shared wall)
  // Every carving is rebuilt from its strokes into one carve layer covering a window around
  // the view, at a resolution that follows the zoom. Only carvings in the window are loaded.
  const hl = $("hl"), wallInfo = $("wallInfo"), wallCount = $("wallCount");
  const postOk = $<HTMLButtonElement>("postOk"), postMsg = $<HTMLInputElement>("postMsg");
  const postBtn = $<HTMLButtonElement>("postFree");
  let wallFrom: Mode = "draw";
  let wallCam: [number, number, number] = [0, 0, 1];
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
    postBtn.textContent = v ? "벽에 남겼어요" : "벽에 남기기";
    postBtn.disabled = v;
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
    carveShown = -1;
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
    if (c.relay) parts.push(`이어 그리기 · ${c.relay}명`);
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
    if (mode !== "wall") {
      wallFrom = mode;
      wallCam = [camera.cx, camera.cy, camera.scale];
    }
    wallHint.classList.remove("show");
    setView("rock", false);
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
    setMode(wallFrom);
    relightLive();
    await animateCamera(wallCam, 700);
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
  /** The drawing in its own frame: strokes moved to the carving's box (+ bevel margin), at (x0, y0) on the wall. */
  const currentDrawing = (): (RelayDrawing & { x0: number; y0: number }) | null => {
    const bb = live.empty ? null : maskBBox(live.masks, live.w, live.h);
    if (!bb) return null;
    const [rx, ry] = live.rectMM, k = live.mmPerPx, pad = 16;
    const x0 = rx + bb[0] * k - pad, y0 = ry + bb[1] * k - pad;
    const w = Math.max(LIMITS.minSize, (bb[2] - bb[0]) * k + 2 * pad), h = Math.max(LIMITS.minSize, (bb[3] - bb[1]) * k + 2 * pad);
    // Very long drawings: thin the points until they fit the row limit.
    const strokes = fitPoints(toWallStrokes(ink.strokes, x0, y0));
    if (strokes.length > LIMITS.maxStrokes) return null;
    return { x0, y0, w, h, strokes };
  };

  /** The current carving as a wall row. */
  const makeDraft = (): CarvingDraft | null => {
    const d = currentDrawing();
    if (!d) return null;
    return { x_mm: d.x0, y_mm: d.y0, w_mm: d.w, h_mm: d.h, src_w: d.w, src_h: d.h, strokes: d.strokes, prompt: null, score: null };
  };

  /** Free spots for the draft: its own spot first; smaller sizes if the wall is crowded. */
  const findSpotsFor = async (d: Pick<CarvingDraft, "x_mm" | "y_mm" | "w_mm" | "h_mm">): Promise<Rect[]> => {
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
    if (busy || live.empty || carvePosted || ink.strokes.length === 0) return;
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
      postMsg.value = "";
      syncPostCount();
      document.body.classList.add("posting");
      await enterWall(spots[0]);
    } finally {
      busy = false;
    }
  };
  postBtn.addEventListener("click", startPost);
  // ---------------------------------------------------------------- 이어 그리기 (relay game)
  // The game itself is in relay/relay.ts; this is the rock it plays on.
  const relay = new Relay({
    enter: () => {
      closeLab();
      document.body.classList.add("relay");
      ink.reset();
      ink.enabled = false;
      setView("rock", false);
      setMode("carve");
      syncDraw();
    },
    exit: async () => {
      document.body.classList.remove("relay", "rl-timer");
      ink.reset();
      ink.enabled = true;
      setMode("draw");
      syncDraw();
      await goToNewSpot(true);
    },
    freshRock: async () => {
      ink.reset();
      ink.enabled = false;
      setView("rock");
      setMode("carve");
      await goToNewSpot(true);
    },
    startDrawing: (enabled) => {
      requestFull();
      setMode("draw");
      ink.enabled = enabled;
      syncDraw();
    },
    stopDrawing: () => {
      ink.cancel();
      ink.enabled = false;
      syncDraw();
      const d = currentDrawing();
      return d ? { w: d.w, h: d.h, strokes: d.strokes } : { w: 0, h: 0, strokes: [] };
    },
    showDrawing: async (d, timelapse) => {
      setView("rock");
      setMode("carve");
      if (!d) {
        ink.reset();
        atHome = true;
        return animateCamera(homeCamera(), 500);
      }
      // Centred on the current spot.
      const x0 = spot.cx - d.w / 2, y0 = spot.cy - d.h / 2;
      ink.load(fromWallStrokes(d.strokes).map((s) => ({ ...s, points: s.points.map((v, i) => v + (i % 2 ? y0 : x0)) })));
      requestFull();
      await focusCarving();
      if (timelapse) await playTimelapse();
    },
    photo: async (d, w, h) => {
      // Sharper with the full-res wall (it loads on the first draw step, so it is usually there).
      await Promise.race([requestFull(), sleep(6000)]);
      let bbox: [number, number, number, number];
      if (d && d.strokes.length) {
        const x0 = spot.cx - d.w / 2, y0 = spot.cy - d.h / 2;
        ink.load(fromWallStrokes(d.strokes).map((s) => ({ ...s, points: s.points.map((v, i) => v + (i % 2 ? y0 : x0)) })));
        bbox = carveBBoxMM(60);
      } else {
        ink.reset();
        bbox = [spot.cx - 300, spot.cy - 200, 600, 400];
      }
      return renderer.snapshot(shareCrop(bbox, meta.width_mm, meta.height_mm, w / h, 0, 300), w, h);
    },
  });
  relayActive = () => relay.active;
  relayDrawing = () => relay.drawing;
  relay.onActive = () => {
    syncModeSeg();
    setMode(mode);
  };
  relay.boot();

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
        live: () => ({ rect: live.rectMM, w: live.w, h: live.h, v: live.version, minH: live.height.reduce((m, v) => Math.min(m, v), 0) }),
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
    flagged: ["바위에 새길 수 없는 그림이에요", "모두가 함께 보는 벽이라 이 그림은 남길 수 없어요.\n다른 그림을 그려 볼까요?"],
    message: ["메시지를 고쳐 주세요", "메시지에 벽에 남기기 어려운 말이 있어요.\n고치거나 비워 두고 다시 눌러 주세요."],
    limited: ["잠시 후에 다시 남겨 주세요", "짧은 시간에 너무 많이 남겼어요.\n조금 쉬었다가 다시 시도해 주세요."],
    invalid: ["남길 수 없어요", "그림을 저장하지 못했어요. 다시 그려 볼까요?"],
    error: ["지금은 남길 수 없어요", "연결이 불안정해요. 잠시 후 다시 시도해 주세요."],
  };
  postOk.addEventListener("click", async () => {
    if (busy || !pending || live.empty) return;
    busy = true;
    postOk.textContent = "확인하는 중…";
    postOk.disabled = true;
    const message = clipMessage(postMsg.value.trim());
    const { id: _id, created_at: _at, ...draft } = pending;
    const png = silhouettePNG(live.masks, live.w, live.h) ?? "";
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
        postBtn.disabled = true;
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
