// 공유하기 sheet: live preview of the share PNG, optional message, size, share / save.
// The PNG is rendered ahead of time, so the tap on 공유하기 calls navigator.share() right away
// (iOS Safari only allows share() inside the tap's user activation).

import { MESSAGE_MAX } from "../../shared/moderation";
import { toast } from "../ui/notice";
import { composeShare, toPngBlob, type ShareText } from "./compose";
import { loadShareFont } from "./font";
import { SHARE_SIZES, type ShareSize } from "./layout";

export interface ShareSource {
  /** The lit wall crop around the carving at the given pixel size. */
  rock: (size: ShareSize) => Promise<HTMLCanvasElement>;
  badge?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Keeps at most `n` characters (code points), so a Korean IME can't overshoot maxlength. */
export const clipMessage = (s: string, n = MESSAGE_MAX) => [...s].slice(0, n).join("");

export class ShareSheet {
  /** The visitor's message; shared with 벽에 남기기 (moderation only, never stored). */
  message = "";
  onMessage: (m: string) => void = () => {};
  private el = $("share");
  private img = $<HTMLImageElement>("sharePreview");
  private msg = $<HTMLInputElement>("shareMsg");
  private count = $("shareCount");
  private go = $<HTMLButtonElement>("shareGo");
  private save = $<HTMLButtonElement>("shareSave");
  private sizeSeg = $("shareSize");
  private size: ShareSize = "story";
  private src: ShareSource | null = null;
  private file: File | null = null;
  private url = "";
  private gen = 0;
  private timer = 0;

  constructor() {
    this.msg.maxLength = MESSAGE_MAX;
    this.msg.addEventListener("input", () => {
      const v = clipMessage(this.msg.value);
      if (v !== this.msg.value) this.msg.value = v;
      this.message = v;
      this.onMessage(v);
      this.syncCount();
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.render(), 350);
    });
    this.sizeSeg.addEventListener("click", (e) => {
      const s = (e.target as HTMLElement).dataset.size as ShareSize | undefined;
      if (!s || s === this.size) return;
      this.size = s;
      this.syncSize();
      this.render();
    });
    $("shareClose").addEventListener("click", () => this.close());
    this.el.addEventListener("click", (e) => e.target === this.el && this.close());
    this.go.addEventListener("click", () => this.share());
    this.save.addEventListener("click", () => this.download());
    this.syncSize();
  }

  open(src: ShareSource) {
    this.src = src;
    this.msg.value = this.message;
    this.syncCount();
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add("show"));
    this.render();
  }

  close() {
    this.el.classList.remove("show");
    this.el.hidden = true;
    this.src = null;
  }

  setMessage(m: string) {
    this.message = clipMessage(m);
  }

  private syncCount() {
    this.count.textContent = `${[...this.msg.value].length}/${MESSAGE_MAX}`;
  }

  private syncSize() {
    [...this.sizeSeg.children].forEach((b) => b.setAttribute("aria-checked", String((b as HTMLElement).dataset.size === this.size)));
    const { w, h } = SHARE_SIZES[this.size];
    this.img.style.aspectRatio = `${w} / ${h}`;
  }

  private async render() {
    if (!this.src) return;
    const gen = ++this.gen;
    this.el.classList.add("busy");
    this.go.disabled = this.save.disabled = true;
    const text: ShareText = { message: this.message, badge: this.src.badge };
    await loadShareFont(text.message + (text.badge ?? ""));
    const rock = await this.src.rock(this.size);
    if (gen !== this.gen || !this.src) return;
    const blob = await toPngBlob(composeShare(rock, this.size, text));
    if (gen !== this.gen) return;
    const stamp = new Date().toISOString().slice(0, 10);
    this.file = new File([blob], `amgakhwa-${stamp}.png`, { type: "image/png" });
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.img.src = this.url;
    this.el.classList.remove("busy");
    this.go.disabled = this.save.disabled = false;
    this.go.hidden = !this.canShareFile();
  }

  private canShareFile(): boolean {
    try {
      return !!this.file && !!navigator.canShare && navigator.canShare({ files: [this.file] });
    } catch {
      return false;
    }
  }

  private async share() {
    if (!this.file) return;
    if (!this.canShareFile()) return this.download();
    try {
      await navigator.share({ files: [this.file], title: "반구대 암각화" });
    } catch (err) {
      if ((err as Error).name !== "AbortError") this.download();
    }
  }

  private download() {
    if (!this.file) return;
    const a = document.createElement("a");
    a.href = this.url;
    a.download = this.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("이미지를 저장했어요");
  }
}
