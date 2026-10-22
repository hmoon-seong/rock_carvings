import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rateLimit";
import { handleScore } from "./score";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const post = (body: unknown, ip = "1.2.3.4") =>
  new Request("http://x/api/score", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("RateLimiter", () => {
  it("allows `limit` hits per window", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit("a", 0)).toBe(true);
    expect(rl.hit("a", 10)).toBe(true);
    expect(rl.hit("a", 20)).toBe(false);
    expect(rl.hit("b", 20)).toBe(true);
    expect(rl.hit("a", 1005)).toBe(true);
  });
});

describe("handleScore", () => {
  it("returns a mock score without an API key", async () => {
    const res = await handleScore(post({ image: PNG, prompt: "whale" }, "10.0.0.1"), {});
    const r = await res.json();
    expect(res.status).toBe(200);
    expect(r.mock).toBe(true);
    expect(typeof r.match).toBe("number");
  });
  it("rejects non-PNG input", async () => {
    const res = await handleScore(post({ image: "hello" }, "10.0.0.2"), {});
    expect(res.status).toBe(400);
  });
  it("rate limits per client", async () => {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await handleScore(post({ image: PNG }, "10.0.0.3"), {})).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes[7]).toBe(429);
  });
});

import { handleWall } from "./wall";

describe("handleWall (no Supabase)", () => {
  const draft = { x_mm: 1000, y_mm: 1000, w_mm: 300, h_mm: 200, src_w: 300, src_h: 200, strokes: [{ c: 0, s: 20, seed: 1, p: [0, 0, 50, 50] }] };
  const postWall = (body: unknown, ip: string) =>
    handleWall(new Request("http://x/api/wall", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body) }), {});
  it("reports mock mode on GET", async () => {
    const r = await handleWall(new Request("http://x/api/wall?x=0&y=0&w=100&h=100"), {});
    expect(await r.json()).toEqual({ mode: "mock" });
  });
  it("moderates the message with the word list and stores nothing", async () => {
    expect(await (await postWall({ draft, image: PNG, message: "안녕 반구대!" }, "20.0.0.1")).json()).toMatchObject({ ok: true, mode: "mock" });
    expect(await (await postWall({ draft, image: PNG, message: "씨 발" }, "20.0.0.2")).json()).toMatchObject({ ok: false, reason: "message" });
  });
  it("rejects invalid drafts", async () => {
    const r = await postWall({ draft: { ...draft, strokes: [] }, image: PNG, message: "" }, "20.0.0.3");
    expect(r.status).toBe(400);
  });
});

import { projectUrl } from "./supabase";
describe("projectUrl", () => {
  it("accepts the project URL or the REST endpoint", () => {
    for (const u of ["https://abc.supabase.co", "https://abc.supabase.co/", "https://abc.supabase.co/rest/v1", " https://abc.supabase.co/rest/v1/ "]) {
      expect(projectUrl(u)).toBe("https://abc.supabase.co");
    }
  });
});
