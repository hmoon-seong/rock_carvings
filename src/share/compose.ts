// Composes the share PNG: the carving on its wall crop (rendered by WebGL), the visitor's
// message, the date and small "반구대 암각화" branding.

import { SHARE_FONT } from "./font";
import { koreanDate, SHARE_SIZES, wrapBalanced, type ShareSize } from "./layout";

export interface ShareText {
  message: string;
  /** e.g. "도전 · 고래 · 78점" */
  badge?: string;
  date?: Date;
}

export function composeShare(rock: HTMLCanvasElement, size: ShareSize, t: ShareText): HTMLCanvasElement {
  const { w: W, h: H, textFrac } = SHARE_SIZES[size];
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(rock, 0, 0, W, H);

  // Dark band at the bottom for the text.
  const g0 = H * (1 - textFrac - 0.1);
  const grad = ctx.createLinearGradient(0, g0, 0, H);
  grad.addColorStop(0, "rgba(14, 11, 9, 0)");
  grad.addColorStop(0.45, "rgba(14, 11, 9, 0.62)");
  grad.addColorStop(1, "rgba(14, 11, 9, 0.9)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, g0, W, H - g0);

  const pad = 84;
  const story = size === "story";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 12;

  // Bottom up: branding, date, message, badge.
  let y = H - (story ? 120 : 64);
  ctx.font = `400 30px ${SHARE_FONT}`;
  ctx.fillStyle = "rgba(226, 214, 200, 0.85)";
  ctx.letterSpacing = "6px";
  ctx.fillText("반구대 암각화 · 암각화몬", W / 2, y);
  ctx.letterSpacing = "0px";

  y -= story ? 64 : 52;
  ctx.font = `400 34px ${SHARE_FONT}`;
  ctx.fillStyle = "rgba(236, 226, 214, 0.9)";
  ctx.fillText(koreanDate(t.date), W / 2, y);

  const msg = t.message.trim();
  if (msg) {
    const fs = story ? 62 : 54, lh = fs * 1.38;
    ctx.font = `700 ${fs}px ${SHARE_FONT}`;
    ctx.fillStyle = "#f6efe6";
    const lines = wrapBalanced(msg, W - 2 * pad, (s) => ctx.measureText(s).width).slice(0, 3);
    y -= story ? 92 : 74;
    for (let i = lines.length - 1; i >= 0; i--) {
      ctx.fillText(lines[i], W / 2, y);
      y -= lh;
    }
    y += lh - fs * 0.35;
  }
  if (t.badge) {
    y -= msg ? 50 : 86;
    ctx.font = `700 32px ${SHARE_FONT}`;
    ctx.fillStyle = "#e9b48f";
    ctx.fillText(t.badge, W / 2, y);
  }
  return cv;
}

export const toPngBlob = (cv: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
