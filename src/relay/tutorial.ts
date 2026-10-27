// 이어 그리기 how-to: four cards with small line drawings, for people who have never played a
// Gartic Phone-style game. Shown once (the first time the relay screens open on this device)
// and from the 규칙 보기 buttons. Swipe or tap 다음; 건너뛰기 closes it.

const SEEN_KEY = "amgakhwamon.relayTutorial.v1";

// ---- drawings (viewBox 0 0 260 150): phones, speech bubbles, a petroglyph whale, arrows
const phone = (x: number, y: number, w = 44, h = 76) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="t-line"/><line x1="${x + w / 2 - 6}" y1="${y + h - 7}" x2="${x + w / 2 + 6}" y2="${y + h - 7}" class="t-line"/>`;
const bubble = (x: number, y: number, w = 36, h = 22) =>
  `<path d="M${x + 4} ${y}h${w - 8}a4 4 0 0 1 4 4v${h - 8}a4 4 0 0 1-4 4h-${w / 2 - 8}l-6 6v-6h-${w / 2 - 6}a4 4 0 0 1-4-4v-${h - 8}a4 4 0 0 1 4-4z" class="t-line t-fill"/>` +
  `<line x1="${x + 7}" y1="${y + 7}" x2="${x + w - 7}" y2="${y + 7}" class="t-thin"/><line x1="${x + 7}" y1="${y + 12}" x2="${x + w - 13}" y2="${y + 12}" class="t-thin"/>`;
const whale = (x: number, y: number, k = 1) =>
  `<path transform="translate(${x} ${y}) scale(${k})" d="M0 10C4 2 22 0 32 6L40 1 38 10 40 19 32 14C22 20 4 18 0 10Z" class="t-whale"/>`;
const arrow = (d: string) => `<path d="${d}" class="t-arrow" marker-end="url(#t-head)"/>`;
const svg = (body: string) =>
  `<svg viewBox="0 0 260 150" aria-hidden="true"><defs><marker id="t-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" class="t-head"/></marker></defs>${body}</svg>`;

const CARDS: { art: string; title: string; text: string }[] = [
  {
    art: svg([30, 108, 186].map((x) => phone(x, 56) + bubble(x + 4, 20)).join("")),
    title: "각자 문장을 지어요",
    text: "“고래가 춤을 춰요”처럼 아무 문장이나 괜찮아요. 모두 동시에 써요.",
  },
  {
    art: svg(phone(36, 38) + bubble(40, 54) + arrow("M92 76H164") + phone(176, 38) + whale(178, 66, 1)),
    title: "옆 사람 문장을 바위에 새겨요",
    text: "내 문장은 옆 사람에게, 나는 다른 사람의 문장을 받아요. 글자 없이 그림으로만!",
  },
  {
    art: svg(
      phone(112, 4, 36, 56) + bubble(114, 18, 32, 20) +
      phone(204, 47, 36, 56) + whale(206, 68, 0.8) +
      phone(112, 90, 36, 56) + `<text x="130" y="124" class="t-q">?</text>` +
      phone(20, 47, 36, 56) + whale(22, 68, 0.8) +
      arrow("M154 26Q190 30 206 44") + arrow("M222 108Q206 128 156 122") + arrow("M106 122Q56 128 40 108") + arrow("M38 44Q52 26 106 26"),
    ),
    title: "새김을 보고 맞히고, 또 새겨요",
    text: "받은 새김이 무엇인지 적으면, 그 글을 다음 사람이 또 새겨요. 사람 수만큼 옆으로 계속 넘어가요.",
  },
  {
    art: svg(
      `<rect x="86" y="6" width="88" height="138" rx="10" class="t-line"/>` +
      bubble(98, 14, 64, 22) + arrow("M130 42V50") + whale(110, 56, 1) + arrow("M130 80V88") + bubble(98, 94, 64, 22) +
      `<path d="M206 60v26m-10-10 10 10 10-10M194 100h24" class="t-line"/>`,
    ),
    title: "끝나면 내 문장이 어떻게 변했는지 봐요",
    text: "각자 처음 쓴 문장이 그림과 글로 어떻게 바뀌었는지 한눈에! 이미지로 저장하고 모두의 벽에도 남길 수 있어요.",
  },
];

const el = (tag: string, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class Tutorial {
  private root: HTMLElement | null = null;
  private i = 0;

  /** Opens the tutorial if this device has never seen it. */
  firstTime() {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // private mode: show it
    }
    if (!seen) this.open();
  }

  open() {
    this.root ??= this.build();
    this.i = 0;
    this.root.hidden = false;
    this.paint();
    requestAnimationFrame(() => this.root?.classList.add("show"));
  }

  private close() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // private mode
    }
    if (!this.root) return;
    this.root.classList.remove("show");
    this.root.hidden = true;
  }

  private build(): HTMLElement {
    const root = el("div", "overlay tut");
    root.hidden = true;
    root.innerHTML = `
      <div class="tut-box" role="dialog" aria-label="이어 그리기 규칙">
        <div class="tut-view"><div class="tut-track">${CARDS.map((c) => `<section class="tut-card">${c.art}<h3>${c.title}</h3><p>${c.text}</p></section>`).join("")}</div></div>
        <div class="tut-dots">${CARDS.map(() => "<i></i>").join("")}</div>
        <div class="row">
          <button class="text tut-skip">건너뛰기</button>
          <span class="grow"></span>
          <button class="pill tut-prev">이전</button>
          <button class="primary tut-next">다음</button>
        </div>
      </div>`;
    document.body.append(root);
    root.querySelector(".tut-skip")!.addEventListener("click", () => this.close());
    root.querySelector(".tut-prev")!.addEventListener("click", () => this.go(this.i - 1));
    root.querySelector(".tut-next")!.addEventListener("click", () => (this.i === CARDS.length - 1 ? this.close() : this.go(this.i + 1)));
    // Swipe left / right.
    const track = root.querySelector<HTMLElement>(".tut-track")!;
    let x0: number | null = null;
    track.addEventListener("pointerdown", (e) => (x0 = e.clientX));
    track.addEventListener("pointerup", (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) this.go(this.i + (dx < 0 ? 1 : -1));
    });
    return root;
  }

  private go(i: number) {
    this.i = Math.max(0, Math.min(CARDS.length - 1, i));
    this.paint();
  }

  private paint() {
    const root = this.root!;
    root.querySelector<HTMLElement>(".tut-track")!.style.transform = `translateX(${-100 * this.i}%)`;
    root.querySelectorAll(".tut-dots i").forEach((d, k) => d.classList.toggle("on", k === this.i));
    root.querySelector<HTMLButtonElement>(".tut-prev")!.hidden = this.i === 0;
    root.querySelector(".tut-next")!.textContent = this.i === CARDS.length - 1 ? "시작하기" : "다음";
  }
}
