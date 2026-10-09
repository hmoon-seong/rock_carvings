// Fallback text check used when no AI moderation is available (mock mode).
// Deliberately small: it only catches the obvious words. The real check is the proxy's Claude call.

const BLOCK = [
  "시발", "씨발", "씨바", "ㅅㅂ", "ㅆㅂ", "병신", "ㅂㅅ", "좆", "존나", "개새", "새끼야", "미친놈", "미친년",
  "썅", "엿먹", "보지", "자지", "섹스", "fuck", "shit", "bitch", "sex", "porn",
];

export function mockTextFlagged(text: string): boolean {
  const t = text.toLowerCase().replace(/[\s.\-_*]/g, "");
  return BLOCK.some((w) => t.includes(w));
}

/** Max message length (share image + moderation only; never stored on the wall). */
export const MESSAGE_MAX = 40;
