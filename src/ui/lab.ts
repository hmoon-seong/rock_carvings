// 실험실 (lab): carving sliders. They set the brown carving; purple follows (see config.carveStyles).

import type { LabSettings } from "../config";

const SLIDERS: [keyof LabSettings, string, number, number, number, (v: number) => string][] = [
  ["depth_mm", "새김 깊이", 2, 20, 0.5, (v) => `${v.toFixed(1)} mm`],
  ["bevel_sigma_mm", "가장자리 경사", 1, 8, 0.1, (v) => `${v.toFixed(1)} mm`],
  ["peck_roughness", "쪼기 거칠기", 0, 1.5, 0.01, (v) => v.toFixed(2)],
];

export class Lab {
  onChange: (lab: LabSettings) => void = () => {};
  private inputs = new Map<keyof LabSettings, [HTMLInputElement, HTMLOutputElement]>();

  constructor(private host: HTMLElement, private value: LabSettings, private defaults: LabSettings) {
    for (const [key, label, min, max, step, fmt] of SLIDERS) {
      const row = document.createElement("label");
      row.className = "lab-row";
      row.innerHTML = `<span>${label}</span><output></output>
        <input type="range" min="${min}" max="${max}" step="${step}">`;
      const input = row.querySelector("input")!, out = row.querySelector("output")!;
      input.value = String(value[key]);
      out.textContent = fmt(value[key]);
      input.addEventListener("input", () => {
        this.value = { ...this.value, [key]: +input.value };
        out.textContent = fmt(+input.value);
        this.onChange(this.value);
      });
      this.inputs.set(key, [input, out]);
      host.appendChild(row);
    }
    const reset = document.createElement("button");
    reset.className = "text lab-reset";
    reset.textContent = "기본값";
    reset.addEventListener("click", () => this.set(this.defaults));
    host.appendChild(reset);
  }

  get settings(): LabSettings {
    return this.value;
  }

  set(v: LabSettings) {
    this.value = { ...v };
    for (const [key, , , , , fmt] of SLIDERS) {
      const [input, out] = this.inputs.get(key)!;
      input.value = String(v[key]);
      out.textContent = fmt(v[key]);
    }
    this.onChange(this.value);
  }

  toggle(open?: boolean) {
    this.host.hidden = !(open ?? this.host.hidden);
    return !this.host.hidden;
  }
}
