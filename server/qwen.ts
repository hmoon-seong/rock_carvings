// Qwen (DashScope) calls of the proxy: scoring a drawing and moderating a wall post.
// The API key is read from the server environment only (DASHSCOPE_API_KEY).
// Uses DashScope's OpenAI-compatible chat API with plain fetch (no SDK).

import { motifById } from "../shared/challenge.ts";
import { parseScore, stripFences, type ScoreResult } from "../shared/score.ts";
import type { Env } from "./http.ts";

/** International endpoint by default; set DASHSCOPE_BASE_URL for the mainland China one
 *  (https://dashscope.aliyuncs.com/compatible-mode/v1). */
export const BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const MODEL = "qwen3-vl-plus";

export interface QwenConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Null without a key (the handlers then use the mock / word-list fallback). */
export function qwenConfig(env: Env): QwenConfig | null {
  const apiKey = env.DASHSCOPE_API_KEY;
  if (!apiKey) return null;
  return { apiKey, baseUrl: (env.DASHSCOPE_BASE_URL || BASE_URL).replace(/\/+$/, ""), model: env.QWEN_MODEL || MODEL };
}

const SCORE_SYSTEM = `You judge a drawing game at the Bangudae Petroglyphs (반구대 암각화) in Ulsan, Korea.
Visitors draw a prehistoric motif in 30 seconds on a phone. You see their drawing as a flat dark silhouette on light paper, like a rubbing of a petroglyph. It will be carved into a rock wall.
Judge kindly: it is a quick finger drawing by a tourist or a child. Simple, blocky, petroglyph-like shapes are fine.

Reply with JSON only, no other text:
{"match": <integer 0-100>, "guess": "<what it looks like, short Korean noun phrase, max 10 characters>", "comment": "<one playful, warm Korean sentence in 해요체, max 40 characters>", "flagged": <true|false>}

- match: how recognizably the drawing shows the prompt. 0 = unrelated or empty, 50 = some features, 80+ = clearly recognizable. If there is no prompt, rate how clear and lively the figure is.
- guess: your honest guess of what was drawn, as if you did not know the prompt.
- flagged: true only if the drawing is obscene, sexual (e.g. genitals), hateful (e.g. a swastika), or contains offensive words or symbols. Otherwise false.`;

const MODERATE_SYSTEM = `You moderate a public guestbook wall at a cultural heritage site in Korea, visited by families.
You get a visitor's drawing (flat dark silhouette on light paper) and an optional short message.
Reply with JSON only, no other text:
{"flagged": <true|false>, "message_flagged": <true|false>}
- flagged: true only if the drawing is obscene, sexual (e.g. genitals), hateful (e.g. a swastika), or shows offensive words or symbols.
- message_flagged: true if the message contains profanity, insults, sexual or hateful content, personal data (phone numbers, addresses), or advertising. Ordinary, silly or misspelled messages are fine.`;

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function ask(cfg: QwenConfig, system: string, content: Part[]): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 500,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`dashscope ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("dashscope: no text in reply");
  return text;
}

const image = (b64: string): Part => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });

/** Throws on API errors or an unusable reply (the handler turns that into the neutral result). */
export async function scoreDrawing(cfg: QwenConfig, pngB64: string, promptId?: string | null): Promise<ScoreResult> {
  const m = motifById(promptId);
  const task = m ? `Prompt: ${m.label} (${m.en}).` : "No prompt (free drawing).";
  const text = await ask(cfg, SCORE_SYSTEM, [image(pngB64), { type: "text", text: task }]);
  const r = parseScore(text);
  if (!r) throw new Error(`unparseable reply: ${text.slice(0, 200)}`);
  return r;
}

export interface Moderation {
  flagged: boolean;
  message_flagged: boolean;
}

export async function moderatePost(cfg: QwenConfig, pngB64: string, message: string): Promise<Moderation> {
  const text = await ask(cfg, MODERATE_SYSTEM, [
    image(pngB64),
    { type: "text", text: message ? `Message: """${message}"""` : "No message." },
  ]);
  const o = JSON.parse(stripFences(text)) as Partial<Moderation>;
  return { flagged: o.flagged === true, message_flagged: o.message_flagged === true };
}
