// Small toast + modal dialog (Korean UI text is passed in).

let toastTimer = 0;
export function toast(text: string, ms = 2200) {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), ms);
}

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

/** Modal over the app; resolves with the chosen button's value. */
export function dialog<T>(title: string, text: string, buttons: DialogButton<T>[]): Promise<T> {
  const back = document.createElement("div");
  back.className = "modal";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.setAttribute("role", "alertdialog");
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  const row = document.createElement("div");
  row.className = "modal-actions";
  box.append(h, p, row);
  back.appendChild(box);
  document.getElementById("app")!.appendChild(back);
  requestAnimationFrame(() => back.classList.add("show"));
  return new Promise((resolve) => {
    for (const b of buttons) {
      const el = document.createElement("button");
      el.className = b.primary ? "primary" : "text";
      el.textContent = b.label;
      el.addEventListener("click", () => {
        back.remove();
        resolve(b.value);
      });
      row.appendChild(el);
    }
  });
}
