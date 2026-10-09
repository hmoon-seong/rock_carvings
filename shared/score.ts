// Scoring result: the proxy contract, parsing of the model's reply, and the mock/fallback results.

import { MOTIFS, motifById } from "./challenge.ts";

export interface ScoreResult {
  /** 0–100; null when the drawing was flagged. */
  match: number | null;
  /** Short Korean label of what the drawing looks like. */
  guess: string;
  /** One playful Korean sentence. */
  comment: string;
  flagged: boolean;
  /** Fake score (no API key, or the proxy is unreachable): show the "모의 채점" badge. */
  mock?: boolean;
  /** The real scorer failed; this is the neutral result. */
  fallback?: boolean;
}

export const NEUTRAL: ScoreResult = {
  match: 50,
  guess: "알쏭달쏭한 무언가",
  comment: "채점 도우미가 잠깐 쉬는 중이에요. 그래도 멋진 새김이에요!",
  flagged: false,
  fallback: true,
};

/** Removes ```json … ``` fences and any text around the outermost JSON object. */
export function stripFences(text: string): string {
  let t = text.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

const clip = (s: unknown, n: number, dflt: string) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : dflt);

/** Parses and sanitizes the model's JSON; null if it is not usable. */
export function parseScore(text: string): ScoreResult | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const flagged = o.flagged === true;
  const m = Number(o.match);
  if (!flagged && !Number.isFinite(m)) return null;
  return {
    match: flagged ? null : Math.round(Math.min(100, Math.max(0, m))),
    guess: clip(o.guess, 20, "무언가"),
    comment: clip(o.comment, 80, ""),
    flagged,
  };
}

/** FNV-1a hash of a string (deterministic mock scores). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const MOCK_COMMENTS = {
  high: ["바위에 새겨도 손색없는 솜씨예요!", "옛 사냥꾼이 봐도 단번에 알아보겠어요.", "선사시대 화가가 울고 갈 실력이에요!"],
  mid: ["조금만 더 크게 그리면 완벽하겠어요.", "특징을 잘 잡았어요. 한 번 더 해 볼까요?", "바위의 친구들이 고개를 갸웃하고 있어요."],
  low: ["음… 바위가 아직 고민 중이에요.", "추상화의 길을 걷고 계시네요!", "천 년 뒤 학자들이 열심히 연구하겠어요."],
};

/** Deterministic fake result for mock mode: the same drawing always gets the same score. */
export function mockScore(image: string, promptId?: string | null): ScoreResult {
  const h = hashString(image.slice(-4000) + (promptId ?? ""));
  const prompt = motifById(promptId);
  const match = 35 + (h % 61); // 35–95
  const others = MOTIFS.filter((m) => m.id !== prompt?.id);
  const guess = prompt && match >= 60 ? prompt.label : others[(h >>> 8) % others.length].label;
  const band = match >= 75 ? MOCK_COMMENTS.high : match >= 55 ? MOCK_COMMENTS.mid : MOCK_COMMENTS.low;
  return { match, guess, comment: band[(h >>> 16) % band.length], flagged: false, mock: true };
}
