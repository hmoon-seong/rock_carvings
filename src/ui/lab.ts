// 실험실 (lab): detailed sliders for the carving and the light. Carve keys re-carve the drawing;
// the rest only change the shader. "설정 복사" copies the values as JSON to hand back.

import type { LabSettings } from "../config";

type Slider = [keyof LabSettings, string, number, number, number, (v: number) => string];

const mm = (v: number) => `${v.toFixed(1)} mm`;
const num = (v: number) => v.toFixed(2);
const warmth = (v: number) => (Math.abs(v) < 0.01 ? "기본" : v > 0 ? `따뜻하게 ${v.toFixed(2)}` : `차갑게 ${(-v).toFixed(2)}`);

const GROUPS: [string, Slider[]][] = [
  [
    "새김",
    [
      ["depth_mm", "새김 깊이", 2, 20, 0.5, mm],
      ["bevel_sigma_mm", "가장자리 경사", 1, 8, 0.1, mm],
      ["peck_roughness", "쪼기 거칠기", 0, 1.5, 0.01, num],
      ["purple_depth_ratio", "보라 깊이 비율", 0.1, 1, 0.01, (v) => `× ${v.toFixed(2)}`],
      ["fresh_stone_lightening", "새 돌 밝기", 0, 1, 0.01, num],
    ],
  ],
  [
    "빛",
    [
      ["sun_intensity", "빛 세기", 0, 5, 0.01, num],
      ["sun_warmth", "빛 색", -1, 1, 0.01, warmth],
      ["ambient_intensity", "그늘 밝기", 0, 2, 0.01, num],
      ["exposure", "노출", 0.3, 2.5, 0.01, num],
    ],
  ],
  ["바위", [["detail_strength", "입자", 0, 1.5, 0.01, num]]],
];

export class Lab {
  /** `key` is the slider that moved (all keys on reset). */
  onChange: (lab: LabSettings, key: keyof LabSettings | null) => void = () => {};
  /** Extra state to include in the copied JSON (e.g. the light direction). */
  extra: () => Record<string, unknown> = () => ({});
  private inputs = new Map<keyof LabSettings, [HTMLInputElement, HTMLOutputElement, Slider[5]]>();

  constructor(private host: HTMLElement, private value: LabSettings, private defaults: LabSettings) {
    // One tab per group so the sheet stays short and the carving stays visible.
    const tabs = document.createElement("div");
    tabs.className = "lab-tabs";
    tabs.setAttribute("role", "tablist");
    host.appendChild(tabs);
    const panes: HTMLElement[] = [];
    const show = (i: number) => {
      panes.forEach((p, j) => (p.hidden = i !== j));
      [...tabs.children].forEach((t, j) => t.setAttribute("aria-selected", String(i === j)));
    };
    GROUPS.forEach(([title, sliders], gi) => {
      const tab = document.createElement("button");
      tab.setAttribute("role", "tab");
      tab.textContent = title;
      tab.addEventListener("click", () => show(gi));
      tabs.appendChild(tab);
      const pane = document.createElement("div");
      pane.className = "lab-pane";
      panes.push(pane);
      host.appendChild(pane);
      for (const [key, label, min, max, step, fmt] of sliders) {
        const row = document.createElement("label");
        row.className = "lab-row";
        row.innerHTML = `<span>${label}</span><output></output>
          <input type="range" min="${min}" max="${max}" step="${step}">`;
        const input = row.querySelector("input")!, out = row.querySelector("output")!;
        input.addEventListener("input", () => {
          this.value = { ...this.value, [key]: +input.value };
          out.textContent = fmt(+input.value);
          this.onChange(this.value, key);
        });
        this.inputs.set(key, [input, out, fmt]);
        pane.appendChild(row);
      }
    });
    show(0);
    const actions = document.createElement("div");
    actions.className = "lab-actions";
    actions.innerHTML = `<button class="text" data-act="copy">설정 복사</button><button class="text" data-act="reset">기본값</button>`;
    actions.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (act === "reset") this.set(this.defaults);
      if (act === "copy") this.copy(e.target as HTMLButtonElement);
    });
    host.appendChild(actions);
    this.render();
  }

  get settings(): LabSettings {
    return this.value;
  }

  set(v: LabSettings) {
    this.value = { ...v };
    this.render();
    this.onChange(this.value, null);
  }

  toggle(open?: boolean) {
    this.host.hidden = !(open ?? this.host.hidden);
    return !this.host.hidden;
  }

  private render() {
    for (const [key, [input, out, fmt]] of this.inputs) {
      input.value = String(this.value[key]);
      out.textContent = fmt(this.value[key]);
    }
  }

  private async copy(btn: HTMLButtonElement) {
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const data = Object.fromEntries(Object.entries({ ...this.value, ...this.extra() }).map(([k, v]) => [k, typeof v === "number" ? round(v) : v]));
    const text = JSON.stringify(data, null, 1);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Not a secure context (e.g. phone on http://<LAN IP>): fall back to a selected textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    }
    btn.textContent = ok ? "복사했어요" : "복사 실패";
    setTimeout(() => (btn.textContent = "설정 복사"), 1500);
  }
}
