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
