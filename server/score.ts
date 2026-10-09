// POST /api/score  { image: base64 PNG (the flat silhouette), prompt?: motif id }
//   → ScoreResult. Never fails the UI: errors give the neutral result,
//     no DASHSCOPE_API_KEY gives the deterministic mock result.

import { motifById } from "../shared/challenge.ts";
import { mockScore, NEUTRAL } from "../shared/score.ts";
import { qwenConfig, scoreDrawing } from "./qwen.ts";
import { clientKey, json, pngBase64, readJson, type Env } from "./http.ts";
import { allow, RateLimiter } from "./rateLimit.ts";

const perMinute = new RateLimiter(6, 60_000);
const perHour = new RateLimiter(60, 3_600_000);

export async function handleScore(req: Request, env: Env, ip?: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const body = await readJson<{ image?: string; prompt?: string }>(req, 500_000);
  const png = pngBase64(body?.image);
  if (!body || !png) return json({ ...NEUTRAL, error: "bad image" }, 400);
  const prompt = motifById(body.prompt)?.id ?? null;

  if (!allow(clientKey(req, ip), perMinute, perHour)) return json({ ...NEUTRAL, limited: true }, 429);
  const ai = qwenConfig(env);
  if (!ai) return json(mockScore(png, prompt));
  try {
    return json(await scoreDrawing(ai, png, prompt));
  } catch (err) {
    console.error("score failed", err);
    return json(NEUTRAL);
  }
}
