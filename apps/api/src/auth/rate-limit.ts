/**
 * In-memory sliding-window rate limiter (SECURITY.md: login/reset/invite
 * endpoints rate-limited per IP + account; API_CONTRACTS: 429 + Retry-After).
 *
 * Single-instance by design for local/dev/P2 — the production replacement is a
 * Redis-backed limiter (Redis is already in the stack); the interface below is
 * the swap seam.
 */

export interface LimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** crude memory guard: reset map when key cardinality exceeds this */
    private readonly maxKeys = 10_000,
  ) {}

  check(key: string, now: number = Date.now()): LimitDecision {
    const cutoff = now - this.windowMs;
    let entries = this.hits.get(key) ?? [];

    // drop timestamps outside the window (sliding, not fixed)
    let firstLive = 0;
    while (firstLive < entries.length && entries[firstLive]! <= cutoff) firstLive += 1;
    if (firstLive > 0) entries = entries.slice(firstLive);

    if (entries.length >= this.limit) {
      const oldest = entries[0]!;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - now) / 1000),
      );
      this.hits.set(key, entries);
      return { allowed: false, retryAfterSec };
    }

    entries.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.hits.clear();
    this.hits.set(key, entries);
    return { allowed: true, retryAfterSec: 0 };
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}

/** Login policy: conservative per-IP and stricter per-account. */
export const LOGIN_RATE_LIMITS = {
  windowMs: 60_000,
  perIp: 10,
  perAccount: 5,
} as const;
