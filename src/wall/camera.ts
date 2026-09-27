// Camera over the wall plane: a centre in wall mm and a scale in mm per CSS pixel.

export interface CameraLimits {
  wallW: number; // mm
  wallH: number; // mm
  minScale: number; // most zoomed in, mm per px
}

export class Camera {
  constructor(
    public cx: number,
    public cy: number,
    public scale: number, // mm per CSS px
  ) {}

  /** Visible rectangle [x, y, w, h] in mm for a viewport of vw × vh CSS px. */
  rect(vw: number, vh: number): [number, number, number, number] {
    const w = vw * this.scale, h = vh * this.scale;
    return [this.cx - w / 2, this.cy - h / 2, w, h];
  }

  toMM(sx: number, sy: number, vw: number, vh: number): [number, number] {
    return [this.cx + (sx - vw / 2) * this.scale, this.cy + (sy - vh / 2) * this.scale];
  }

  pan(dxPx: number, dyPx: number) {
    this.cx -= dxPx * this.scale;
    this.cy -= dyPx * this.scale;
  }

  /** Zooms by `factor` (> 1 = closer) keeping the wall point under (sx, sy) fixed on screen. */
  zoomAt(factor: number, sx: number, sy: number, vw: number, vh: number, lim: CameraLimits) {
    const [mx, my] = this.toMM(sx, sy, vw, vh);
    const s = clampScale(this.scale / factor, vw, vh, lim);
    this.cx = mx - (sx - vw / 2) * s;
    this.cy = my - (sy - vh / 2) * s;
    this.scale = s;
  }

  /** Keeps the scale in range and the view centre on the wall. */
  clamp(vw: number, vh: number, lim: CameraLimits) {
    this.scale = clampScale(this.scale, vw, vh, lim);
    this.cx = Math.min(lim.wallW, Math.max(0, this.cx));
    this.cy = Math.min(lim.wallH, Math.max(0, this.cy));
  }
}

/** Scale that shows the whole wall with a small margin. */
export function fitScale(vw: number, vh: number, lim: CameraLimits): number {
  return Math.max(lim.wallW / vw, lim.wallH / vh) * 1.04;
}

function clampScale(s: number, vw: number, vh: number, lim: CameraLimits): number {
  return Math.min(fitScale(vw, vh, lim), Math.max(lim.minScale, s));
}

/** A "nice" scale-bar length (1, 2 or 5 × 10^n mm) close to `targetMM`. */
export function niceLength(targetMM: number): number {
  const p = 10 ** Math.floor(Math.log10(targetMM));
  const m = targetMM / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}
