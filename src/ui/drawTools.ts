// Draw panel: colors + eraser, brush size, undo, clear.

import { BRUSH_MM, type PaletteColor } from "../config";
import type { Ink } from "../draw/ink";
import { ERASER } from "../draw/strokes";

export function setupDrawTools(ink: Ink, palette: PaletteColor[], pxPerMM: () => number) {
  const $ = (id: string) => document.getElementById(id)!;

  // ---- colors + eraser
  const chips = $("chips");
  const tools = [...palette.map((p, i) => ({ id: i, label: p.label, hex: p.hex })), { id: ERASER, label: "지우개", hex: "" }];
  for (const t of tools) {
    const b = document.createElement("button");
    b.className = "chip" + (t.id === ERASER ? " eraser" : "");
    b.setAttribute("role", "radio");
    if (t.hex) b.style.setProperty("--c", t.hex);
    b.innerHTML = `<i></i>${t.label}`;
    b.addEventListener("click", () => {
      ink.color = t.id;
      sync();
    });
    chips.appendChild(b);
  }

  // ---- brush size (mm); the dot previews it at the real on-screen size
  const size = $("size") as HTMLInputElement;
  const dot = $("sizeDot");
  size.min = String(BRUSH_MM.min);
  size.max = String(BRUSH_MM.max);
  size.step = "1";
  size.value = String(ink.size);
  size.addEventListener("input", () => {
    ink.size = +size.value;
    sync();
  });

  // ---- undo / clear
  const undo = $("undo") as HTMLButtonElement;
  const clear = $("clear") as HTMLButtonElement;
  undo.addEventListener("click", () => ink.undo());
  clear.addEventListener("click", () => ink.clear());
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && document.body.classList.contains("mode-draw")) {
      e.preventDefault();
      ink.undo();
    }
  });

  function sync() {
    [...chips.children].forEach((c, i) => c.setAttribute("aria-checked", String(tools[i].id === ink.color)));
    const d = Math.max(4, ink.size * pxPerMM());
    dot.style.width = dot.style.height = `${d}px`;
    dot.style.background = ink.color === ERASER ? "transparent" : palette[ink.color].hex;
    dot.classList.toggle("eraser", ink.color === ERASER);
    undo.disabled = !ink.history.canUndo;
    clear.disabled = ink.strokes.length === 0;
  }
  sync();
  return sync;
}
