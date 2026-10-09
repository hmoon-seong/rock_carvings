// The real (non-mock) paths with a stubbed fetch: Anthropic Messages API and Supabase REST.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleScore } from "./score";
import { handleWall } from "./wall";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const draft = { x_mm: 1000, y_mm: 1000, w_mm: 300, h_mm: 200, src_w: 300, src_h: 200, strokes: [{ c: 0, s: 20, seed: 1, p: [0, 0, 50, 50] }] };

function claudeReply(text: string) {
  return new Response(
    JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } },
  );
}

const calls: { url: string; init?: RequestInit; body?: unknown }[] = [];
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    return handler(url, init);
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

const req = (path: string, body?: unknown, ip = "30.0.0.1") =>
  new Request(`http://x${path}`, body ? { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body) } : { headers: { "x-forwarded-for": ip } });

describe("score with an API key", () => {
  it("sends the PNG to claude-haiku-5-5 and parses a fenced JSON reply", async () => {
    stubFetch(() => claudeReply('```json\n{"match": 83, "guess": "고래", "comment": "멋진 고래예요!", "flagged": false}\n```'));
    const res = await handleScore(req("/api/score", { image: PNG, prompt: "whale" }, "30.0.0.1"), { ANTHROPIC_API_KEY: "sk-test" });
    expect(await res.json()).toEqual({ match: 83, guess: "고래", comment: "멋진 고래예요!", flagged: false });
    const sent = calls[0].body as { model: string; messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] };
    expect(calls[0].url).toContain("/v1/messages");
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
  });
  it("falls back to the neutral result on a bad reply", async () => {
    stubFetch(() => claudeReply("Sorry, I can't."));
    const r = await (await handleScore(req("/api/score", { image: PNG }, "30.0.0.2"), { ANTHROPIC_API_KEY: "sk-test" })).json();
    expect(r.fallback).toBe(true);
    expect(r.match).toBe(50);
  });
});

describe("wall with Supabase", () => {
  const env = { SUPABASE_URL: "https://demo.supabase.co", SUPABASE_ANON_KEY: "anon", ANTHROPIC_API_KEY: "sk-test" };
  it("lists carvings in a rectangle", async () => {
    stubFetch(() => new Response(JSON.stringify([{ ...draft, id: "a", created_at: "x" }, { ...draft, x_mm: 5000, id: "b", created_at: "x" }]), { headers: { "content-type": "application/json" } }));
    const r = await (await handleWall(req("/api/wall?x=900&y=900&w=1000&h=1000"), env)).json();
    expect(r.mode).toBe("supabase");
    expect(r.carvings.map((c: { id: string }) => c.id)).toEqual(["a"]); // b starts right of the rectangle
    expect(calls[0].url).toContain("/rest/v1/carvings?");
    expect((calls[0].init?.headers as Record<string, string>).apikey).toBe("anon");
  });
  it("moderates, then inserts without the message", async () => {
    stubFetch((url) =>
      url.includes("anthropic")
        ? claudeReply('{"flagged": false, "message_flagged": false}')
        : new Response(JSON.stringify([{ ...draft, id: "new", created_at: "now" }]), { status: 201, headers: { "content-type": "application/json" } }),
    );
    const r = await (await handleWall(req("/api/wall", { draft, image: PNG, message: "안녕하세요" }, "30.0.0.3"), env)).json();
    expect(r).toMatchObject({ ok: true, mode: "supabase", carving: { id: "new" } });
    const insert = calls.find((c) => c.url.includes("supabase"))!;
    expect(insert.init?.method).toBe("POST");
    expect(JSON.stringify(insert.body)).not.toContain("안녕하세요");
  });
  it("rejects a flagged drawing and stores nothing", async () => {
    stubFetch((url) => (url.includes("anthropic") ? claudeReply('{"flagged": true, "message_flagged": false}') : new Response("{}", { status: 500 })));
    const r = await (await handleWall(req("/api/wall", { draft, image: PNG, message: "" }, "30.0.0.4"), env)).json();
    expect(r).toEqual({ ok: false, reason: "flagged" });
    expect(calls.some((c) => c.url.includes("supabase"))).toBe(false);
  });
  it("fails closed when moderation is down", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    const res = await handleWall(req("/api/wall", { draft, image: PNG, message: "" }, "30.0.0.5"), env);
    expect(await res.json()).toEqual({ ok: false, reason: "error" });
  });
});
