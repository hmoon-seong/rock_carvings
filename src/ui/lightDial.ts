// Light dial: a sun on a sky dome seen from the front of the wall.
// Angle around the dial = azimuth (0 = top, 90 = right), distance from the rim = elevation.

import type { Light } from "../wall/renderer";

const MIN_EL = 4, MAX_EL = 80;

export class LightDial {
  readonly el: HTMLElement;
  onInput: (l: Light) => void = () => {};
  private sun: SVGCircleElement;
  private ray: SVGLineElement;
  private label: HTMLElement;

  constructor(private light: Light) {
    this.el = document.createElement("div");
    this.el.className = "dial";
    this.el.innerHTML = `
      <svg viewBox="-50 -50 100 100" aria-hidden="true">
        <circle class="dial-rim" r="44"/>
        <circle class="dial-mid" r="22"/>
        <line class="dial-ray" x1="0" y1="0"/>
        <circle class="dial-sun" r="7"/>
      </svg>
      <span class="dial-label"></span>`;
    this.el.setAttribute("role", "slider");
    this.el.setAttribute("aria-label", "빛 방향");
    this.el.tabIndex = 0;
    this.sun = this.el.querySelector(".dial-sun")!;
    this.ray = this.el.querySelector(".dial-ray")!;
    this.label = this.el.querySelector(".dial-label")!;

    const svg = this.el.querySelector("svg")!;
    const pick = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width - 0.5) * 100, y = ((e.clientY - r.top) / r.height - 0.5) * 100;
      const az = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
      const t = Math.min(1, Math.hypot(x, y) / 44);
      this.set({ azimuth: az, elevation: MIN_EL + (MAX_EL - MIN_EL) * (1 - t) });
    };
    svg.addEventListener("pointerdown", (e) => {
      svg.setPointerCapture(e.pointerId);
      pick(e);
    });
    svg.addEventListener("pointermove", (e) => {
      if (svg.hasPointerCapture(e.pointerId)) pick(e);
    });
    this.el.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
      if (d) this.set({ ...this.light, azimuth: (this.light.azimuth + d + 360) % 360 });
    });
    this.render();
  }

  set(l: Light, notify = true) {
    this.light = { ...l };
    this.render();
    if (notify) this.onInput(this.light);
  }

  private render() {
    const { azimuth, elevation } = this.light;
    const t = 1 - (elevation - MIN_EL) / (MAX_EL - MIN_EL);
    const a = (azimuth * Math.PI) / 180, r = 44 * Math.max(0, Math.min(1, t));
    const x = Math.sin(a) * r, y = -Math.cos(a) * r;
    this.sun.setAttribute("cx", x.toFixed(1));
    this.sun.setAttribute("cy", y.toFixed(1));
    this.ray.setAttribute("x2", x.toFixed(1));
    this.ray.setAttribute("y2", y.toFixed(1));
    this.label.textContent = `${Math.round(azimuth)}° · 높이 ${Math.round(elevation)}°`;
    this.el.setAttribute("aria-valuenow", String(Math.round(azimuth)));
  }
}
