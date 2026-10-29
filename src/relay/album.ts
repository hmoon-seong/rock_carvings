// 이어 그리기, the end: each player's album. One chain at a time, top to bottom: the prompt,
// then each drawing (photographed carved on the rock under the raking light), each guess…
// Tabs switch to the other players' chains (the player's own chain opens first). 이미지 저장
// turns the open chain into one tall JPEG (share sheet on phones, else a download).
//
// The photos are made on this device, one at a time (the rock has one carve layer): the
// open chain first, the others when their tab is opened. The tall image is composed as soon
// as a chain's photos are ready, so the tap on 이미지 저장 can call navigator.share() at once
// (iOS Safari only allows share() inside the tap's user activation).

import type { RelayDrawing } from "../../shared/relay";
import { loadShareFont, SHARE_FONT } from "../share/font";
import { koreanDate, wrapBalanced } from "../share/layout";
import type { ChainEntry } from "./api";

export interface AlbumDeps {
  /** Carves a drawing (null: bare rock) and returns a w × h photo of it under the light. */
  photo(d: RelayDrawing | null, w: number, h: number): Promise<HTMLCanvasElement>;
  /** The whole chain. */
  load(chain: number): Promise<ChainEntry[]>;
}

export interface AlbumOpen {
  game: number;
  n: number;
  /** Name of the player who started each chain. */
  owners: string[];
  /** The chain this player started (opens first); null for watchers. */
  mine: number | null;
}

const PHOTO_W = 1080, PHOTO_H = 720;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** What each step was, in a few words. */
export function entryLabel(e: ChainEntry): string {
  const who = e.name || "누군가";
  if (e.drawing) return e.drawing.strokes.length ? `${who} 님이 새겼어요` : `${who} 님 · 시간 안에 새기지 못했어요`;
  if (e.step === 0) return e.auto ? "자동으로 정한 이야기" : `${who} 님이 지은 이야기`;
  return e.auto ? `${who} 님 · 시간 안에 적지 못했어요` : `${who} 님의 추측`;
}

const photoKey = (game: number, chain: number, step: number) => `${game}:${chain}:${step}`;

export class Album {
  private root = $("rlAlbumView");
  private tabs = $("rlAlbumTabs");
  private list = $("rlAlbumList");
  private saveBtn = $<HTMLButtonElement>("rlSave");
  private o: AlbumOpen | null = null;
  private chain = 0;
  private entries = new Map<number, ChainEntry[]>();
  /** Photos by game:chain:step (null: it could not be made). */
  private photos = new Map<string, HTMLCanvasElement | null>();
  private queue: { key: string; chain: number; d: RelayDrawing | null }[] = [];
  private working = false;
  /** The tall image of each chain, once composed. */
  private files = new Map<number, File>();
  private composing = new Set<number>();

  constructor(private deps: AlbumDeps) {
    this.tabs.addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-chain]")?.dataset.chain;
      if (c != null && Number(c) !== this.chain) void this.select(Number(c));
    });
  }

  open(o: AlbumOpen) {
    if (this.o?.game !== o.game) {
      this.entries.clear();
      this.photos.clear();
      this.files.clear();
      this.composing.clear();
      this.queue = [];
    }
    this.o = o;
    this.root.hidden = false;
    this.root.scrollTop = 0;
    void this.select(o.mine ?? 0);
  }

  close() {
    this.o = null;
    this.queue = [];
    this.root.hidden = true;
  }

  private renderTabs() {
    const o = this.o!;
    const order = Array.from({ length: o.n }, (_, c) => c);
    if (o.mine != null) order.sort((a, b) => Number(b === o.mine) - Number(a === o.mine));
    this.tabs.replaceChildren(
      ...order.map((c) => {
        const b = el("button", "", c === o.mine ? "내 이야기" : `${o.owners[c]} 님`);
        b.dataset.chain = String(c);
        b.setAttribute("aria-pressed", String(c === this.chain));
        return b;
      }),
    );
  }

  private async select(chain: number) {
    const o = this.o;
    if (!o) return;
    this.chain = chain;
    this.renderTabs();
    this.syncSave();
    let entries = this.entries.get(chain);
    if (!entries) {
      this.list.replaceChildren(el("li", "al-wait", "불러오는 중…"));
      try {
        entries = await this.deps.load(chain);
      } catch {
        if (this.chain === chain) this.list.replaceChildren(el("li", "al-wait", "불러오지 못했어요. 탭을 다시 눌러 주세요"));
        return;
      }
      this.entries.set(chain, entries);
    }
    if (this.o !== o || this.chain !== chain) return;
    this.renderList(chain, entries);
    this.root.scrollTop = 0;
    // This chain's photos go first.
    const todo = entries
      .filter((e) => e.drawing && !this.photos.has(photoKey(o.game, chain, e.step)))
      .map((e) => ({ key: photoKey(o.game, chain, e.step), chain, d: e.drawing!.strokes.length ? e.drawing! : null }))
      .filter((t) => !this.queue.some((q) => q.key === t.key));
    this.queue.unshift(...todo);
    void this.pump();
    this.maybeCompose(chain);
  }

  private renderList(chain: number, entries: ChainEntry[]) {
    const o = this.o!;
    const head = el("li", "al-head");
    head.append(el("h2", "", `${o.owners[chain]} 님의 이야기`), el("small", "", chain === o.mine ? "내가 지은 문장이 이렇게 변했어요" : `${entries.length}단계`));
    this.list.replaceChildren(
      head,
      ...entries.map((e) => {
        const li = el("li", e.drawing ? "al-draw" : "al-text");
        li.append(el("small", "", entryLabel(e)));
        if (e.drawing) {
          const frame = el("div", "al-photo");
          frame.dataset.key = photoKey(o.game, chain, e.step);
          this.fillFrame(frame);
          li.append(frame);
        } else li.append(el("p", "", `“${e.text ?? ""}”`));
        return li;
      }),
    );
  }

  private fillFrame(frame: HTMLElement) {
    const key = frame.dataset.key!;
    if (!this.photos.has(key)) return frame.replaceChildren(el("span", "", "새기는 중…"));
    const cv = this.photos.get(key);
    frame.replaceChildren(cv ?? el("span", "", "사진을 만들지 못했어요"));
  }

  /** Makes the queued photos one by one (the open chain's first). */
  private async pump() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.o && this.queue.length) {
        const i = Math.max(0, this.queue.findIndex((q) => q.chain === this.chain));
        const [job] = this.queue.splice(i, 1);
        if (this.photos.has(job.key)) continue;
        let cv: HTMLCanvasElement | null = null;
        try {
          cv = await this.deps.photo(job.d, PHOTO_W, PHOTO_H);
        } catch (err) {
          console.warn("album photo failed", err);
        }
        if (!this.o || !job.key.startsWith(`${this.o.game}:`)) break;
        this.photos.set(job.key, cv);
        const frame = this.list.querySelector<HTMLElement>(`.al-photo[data-key="${job.key}"]`);
        if (frame) this.fillFrame(frame);
        this.maybeCompose(job.chain);
      }
    } finally {
      this.working = false;
    }
  }

  /** Composes the chain's tall image once all its photos exist. */
  private maybeCompose(chain: number) {
    const o = this.o;
    const entries = this.entries.get(chain);
    if (!o || !entries || this.files.has(chain) || this.composing.has(chain)) return;
    if (entries.some((e) => e.drawing && !this.photos.has(photoKey(o.game, chain, e.step)))) return;
    this.composing.add(chain);
    const title = `${o.owners[chain]} 님의 이야기`;
    const photos = entries.map((e) => (e.drawing ? this.photos.get(photoKey(o.game, chain, e.step)) ?? null : null));
    void composeAlbum(title, entries, photos)
      .then((blob) => {
        if (this.o?.game !== o.game) return;
        const stamp = new Date().toISOString().slice(0, 10);
        this.files.set(chain, new File([blob], `amgakhwa-relay-${stamp}-${chain + 1}.jpg`, { type: "image/jpeg" }));
        this.syncSave();
      })
      .catch((err) => console.warn("album image failed", err))
      .finally(() => this.composing.delete(chain));
  }

  private syncSave() {
    const ready = this.files.has(this.chain);
    this.saveBtn.disabled = !ready;
    this.saveBtn.textContent = ready ? "이미지 저장" : "사진 만드는 중…";
  }

  /** 이미지 저장: the share sheet where files can be shared, else a download. */
  async save() {
    const file = this.files.get(this.chain);
    if (!file) return;
    let canShare = false;
    try {
      canShare = !!navigator.canShare && navigator.canShare({ files: [file] });
    } catch {
      // older browsers throw on files
    }
    if (canShare) {
      try {
        await navigator.share({ files: [file], title: "반구대 암각화 · 이어 그리기" });
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
}

// ---------------------------------------------------------------- the tall image

const W = 1080, PAD = 72, INNER = W - 2 * PAD;
const C = { paper: "#f3efe9", card: "#fbf8f4", text: "#2a2521", muted: "#8b827a", accent: "#9d4a2c" };

/** The chain as one tall JPEG: title, then each step (text card or photo), arrows between. */
export async function composeAlbum(title: string, entries: ChainEntry[], photos: (HTMLCanvasElement | null)[], date = new Date()): Promise<Blob> {
  const words = [title, koreanDate(date), "반구대 암각화 · 이어 그리기 · 암각화몬", ...entries.map((e) => `${entryLabel(e)} ${e.text ?? ""}`)].join(" ");
  await loadShareFont(words);
  const measure = document.createElement("canvas").getContext("2d")!;
  const font = (w: number, px: number) => `${w} ${px}px ${SHARE_FONT}`;
  const TEXT_PX = 54, TEXT_LH = 76, CARD_PAD = 44, LABEL_GAP = 52, ARROW = 96;
  const photoH = Math.round((INNER * PHOTO_H) / PHOTO_W);

  measure.font = font(700, TEXT_PX);
  const lines = entries.map((e) => (e.drawing ? [] : wrapBalanced(`“${e.text ?? ""}”`, INNER - 2 * CARD_PAD, (s) => measure.measureText(s).width)));
  measure.font = font(700, 64);
  const titleLines = wrapBalanced(title, INNER, (s) => measure.measureText(s).width).slice(0, 2);
  const blockH = (i: number) => LABEL_GAP + (entries[i].drawing ? photoH : lines[i].length * TEXT_LH + 2 * CARD_PAD - (TEXT_LH - TEXT_PX));
  const headH = 120 + titleLines.length * 84 + 60 + 70;
  const H = headH + entries.reduce((s, _, i) => s + blockH(i) + (i < entries.length - 1 ? ARROW : 0), 0) + 170;

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // Header
  let y = 110;
  ctx.textAlign = "left";
  ctx.font = font(400, 30);
  ctx.fillStyle = C.muted;
  ctx.letterSpacing = "4px";
  ctx.fillText("반구대 암각화 · 이어 그리기", PAD, y);
  ctx.letterSpacing = "0px";
  ctx.font = font(700, 64);
  ctx.fillStyle = C.text;
  for (const l of titleLines) {
    y += 84;
    ctx.fillText(l, PAD, y);
  }
  y += 60;
  ctx.font = font(400, 32);
  ctx.fillStyle = C.muted;
  ctx.fillText(koreanDate(date), PAD, y);
  y += 70;

  const rounded = (x: number, yy: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, yy, w, h, r);
  };
  entries.forEach((e, i) => {
    ctx.textAlign = "left";
    ctx.font = font(400, 30);
    ctx.fillStyle = C.muted;
    ctx.fillText(`${i + 1}  ${entryLabel(e)}`, PAD, y + 34);
    y += LABEL_GAP;
    if (e.drawing) {
      ctx.save();
      rounded(PAD, y, INNER, photoH, 28);
      ctx.clip();
      const p = photos[i];
      if (p) ctx.drawImage(p, PAD, y, INNER, photoH);
      else {
        ctx.fillStyle = "#d9d0c4";
        ctx.fillRect(PAD, y, INNER, photoH);
      }
      ctx.restore();
      y += photoH;
    } else {
      const h = blockH(i) - LABEL_GAP;
      rounded(PAD, y, INNER, h, 28);
      ctx.fillStyle = C.card;
      ctx.fill();
      ctx.font = font(700, TEXT_PX);
      ctx.fillStyle = e.auto ? C.muted : C.text;
      lines[i].forEach((l, k) => ctx.fillText(l, PAD + CARD_PAD, y + CARD_PAD + TEXT_PX * 0.86 + k * TEXT_LH));
      y += h;
    }
    if (i < entries.length - 1) {
      ctx.textAlign = "center";
      ctx.font = font(700, 44);
      ctx.fillStyle = C.accent;
      ctx.fillText("↓", W / 2, y + ARROW / 2 + 16);
      y += ARROW;
    }
  });

  ctx.textAlign = "center";
  ctx.font = font(400, 28);
  ctx.fillStyle = C.muted;
  ctx.letterSpacing = "6px";
  ctx.fillText("반구대 암각화 · 암각화몬", W / 2, H - 70);
  ctx.letterSpacing = "0px";

  return new Promise<Blob>((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.9));
}
