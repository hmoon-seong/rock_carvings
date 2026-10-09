// The share image's Korean font (Gowun Batang, Google Fonts), loaded only when a share image
// is made so the first visit stays light. Google Fonts serves unicode-range subsets, so only
// the glyphs of the message are downloaded. Falls back to the system's Korean font after 3 s.

export const SHARE_FONT = `"Gowun Batang", "Noto Serif KR", "Apple SD Gothic Neo", "Noto Sans KR", serif`;

let linked = false;

export async function loadShareFont(text: string, timeoutMs = 3000): Promise<boolean> {
  if (!linked) {
    linked = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap";
    document.head.appendChild(link);
    await new Promise((r) => {
      link.onload = link.onerror = r;
      setTimeout(r, timeoutMs);
    });
  }
  const sample = text + "반구대 암각화몬 0123456789.·점도전";
  const load = Promise.all([
    document.fonts.load(`700 60px "Gowun Batang"`, sample),
    document.fonts.load(`400 34px "Gowun Batang"`, sample),
  ]).then((f) => f.every((x) => x.length > 0)).catch(() => false);
  return Promise.race([load, new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
}
