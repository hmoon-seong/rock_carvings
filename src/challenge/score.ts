// Client side of the scoring proxy. Never throws: no proxy (static hosting, offline) gives
// the same deterministic mock result the server uses without an API key.

import { mockScore, NEUTRAL, type ScoreResult } from "../../shared/score";

export const API_BASE = `${import.meta.env.BASE_URL}api/`;

export async function requestScore(png: string, promptId: string | null): Promise<ScoreResult> {
  let res: Response;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    res = await fetch(API_BASE + "score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: png, prompt: promptId }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
  } catch {
    return mockScore(png.replace(/^data:image\/png;base64,/, ""), promptId);
  }
  // No function behind /api (404, or an HTML page from a static host): mock mode.
  if (res.status === 404 || !(res.headers.get("content-type") ?? "").includes("json")) {
    return mockScore(png.replace(/^data:image\/png;base64,/, ""), promptId);
  }
  try {
    const r = (await res.json()) as ScoreResult;
    if (typeof r.flagged !== "boolean" || typeof r.guess !== "string") return NEUTRAL;
    return r;
  } catch {
    return NEUTRAL;
  }
}

/** "이건... 고래 같아요!" — sure when the score is high, wondering when low. */
export function guessLine(r: ScoreResult): string {
  return `이건... ${r.guess} 같아요${(r.match ?? 0) >= 60 ? "!" : "?"}`;
}
