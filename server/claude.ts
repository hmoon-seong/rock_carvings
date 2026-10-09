// Claude calls of the proxy: scoring a drawing and moderating a wall post.
// The API key is read from the server environment only (ANTHROPIC_API_KEY).

import Anthropic from "@anthropic-ai/sdk";
import { motifById } from "../shared/challenge.ts";
import { parseScore, stripFences, type ScoreResult } from "../shared/score.ts";

export const MODEL = "claude-haiku-5-5";

let client: Anthropic | null = null;
let clientKey = "";
function getClient(apiKey: string): Anthropic {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
    clientKey = apiKey;
  }
  return client;
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

function textOf(msg: Anthropic.Message): string {
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

async function ask(apiKey: string, system: string, content: Anthropic.ContentBlockParam[]): Promise<string> {
  const msg = await getClient(apiKey).messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content }],
  });
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  return textOf(msg);
}

const image = (b64: string): Anthropic.ImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: b64 },
});

/** Throws on API errors or an unusable reply (the handler turns that into the neutral result). */
export async function scoreDrawing(apiKey: string, pngB64: string, promptId?: string | null): Promise<ScoreResult> {
  const m = motifById(promptId);
  const task = m ? `Prompt: ${m.label} (${m.en}).` : "No prompt (free drawing).";
  const text = await ask(apiKey, SCORE_SYSTEM, [image(pngB64), { type: "text", text: task }]);
  const r = parseScore(text);
  if (!r) throw new Error(`unparseable reply: ${text.slice(0, 200)}`);
  return r;
}

export interface Moderation {
  flagged: boolean;
  message_flagged: boolean;
}

export async function moderatePost(apiKey: string, pngB64: string, message: string): Promise<Moderation> {
  const text = await ask(apiKey, MODERATE_SYSTEM, [
    image(pngB64),
    { type: "text", text: message ? `Message: """${message}"""` : "No message." },
  ]);
  const o = JSON.parse(stripFences(text)) as Partial<Moderation>;
  return { flagged: o.flagged === true, message_flagged: o.message_flagged === true };
}
