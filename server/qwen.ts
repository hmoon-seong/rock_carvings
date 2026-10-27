// Qwen (DashScope) calls of the proxy: moderating a wall post and in-game text.
// The API key is read from the server environment only (DASHSCOPE_API_KEY).
// Uses DashScope's OpenAI-compatible chat API with plain fetch (no SDK).

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

/** Null without a key (the handlers then use the word-list fallback). */
export function qwenConfig(env: Env): QwenConfig | null {
  const apiKey = env.DASHSCOPE_API_KEY;
  if (!apiKey) return null;
  return { apiKey, baseUrl: (env.DASHSCOPE_BASE_URL || BASE_URL).replace(/\/+$/, ""), model: env.QWEN_MODEL || MODEL };
}

const MODERATE_SYSTEM = `You moderate a public guestbook wall at a cultural heritage site in Korea, visited by families.
You get a visitor's drawing (flat dark silhouette on light paper) and an optional short message.
Reply with JSON only, no other text:
{"flagged": <true|false>, "message_flagged": <true|false>}
- flagged: true only if the drawing is obscene, sexual (e.g. genitals), hateful (e.g. a swastika), or shows offensive words or symbols.
- message_flagged: true if the message contains profanity, insults, sexual or hateful content, personal data (phone numbers, addresses), or advertising. Ordinary, silly or misspelled messages are fine.`;

/** Removes ```json … ``` fences and any text around the outermost JSON object. */
export function stripFences(text: string): string {
  let t = text.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function ask(cfg: QwenConfig, system: string, content: Part[], timeoutMs = 20_000): Promise<string> {
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`dashscope ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("dashscope: no text in reply");
  return text;
}

const image = (b64: string): Part => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });

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

const TEXT_SYSTEM = `You moderate a drawing-and-guessing party game played by families at a cultural heritage site in Korea.
Players write short prompts and guesses (Korean or English) that the other players see.
Reply with JSON only, no other text:
{"flagged": <true|false>}
- flagged: true if the text contains profanity, slurs, insults aimed at people, sexual or hateful content, or personal data (phone numbers, addresses). Silly, odd, misspelled or nonsense text is fine.`;

/** In-game text (prompt or guess). Throws on API errors (the caller decides how to fail). */
export async function moderateText(cfg: QwenConfig, text: string): Promise<boolean> {
  // Short timeout: a player is waiting (and at the deadline, everyone is).
  const reply = await ask(cfg, TEXT_SYSTEM, [{ type: "text", text: `Text: """${text}"""` }], 6000);
  return (JSON.parse(stripFences(reply)) as { flagged?: unknown }).flagged === true;
}
