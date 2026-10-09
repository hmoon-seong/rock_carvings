// Per-client sliding-window rate limit, in memory. Best effort: each serverless instance
// keeps its own counts and loses them when it is recycled. Good enough to stop a stuck
// loop or a casual abuser; a shared store (e.g. Netlify Blobs, Upstash) would make it strict.

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Records a request; false if the client is over the limit (the request is not counted then). */
  hit(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(now);
    return true;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

/** All limits must pass. */
export const allow = (key: string, ...limiters: RateLimiter[]) => limiters.every((l) => l.hit(key));
