import { describe, expect, it } from 'vitest';
import { LOGIN_RATE_LIMITS, SlidingWindowLimiter } from './rate-limit';

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit, then blocks', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.check('k', t0).allowed).toBe(true);
    expect(limiter.check('k', t0 + 10).allowed).toBe(true);
    expect(limiter.check('k', t0 + 20).allowed).toBe(true);
    const denied = limiter.check('k', t0 + 30);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it('slides the window: entries expire and free capacity', () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    const t0 = 1_000_000;
    limiter.check('k', t0);
    limiter.check('k', t0 + 1_000);
    expect(limiter.check('k', t0 + 2_000).allowed).toBe(false);
    // first hit ages out after 60s → capacity frees up
    expect(limiter.check('k', t0 + 61_000).allowed).toBe(true);
    expect(limiter.check('k', t0 + 61_500).allowed).toBe(true); // second slot
    expect(limiter.check('k', t0 + 62_000).allowed).toBe(false); // limit again
  });

  it('reports Retry-After aligned with the oldest surviving hit', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    const t0 = 1_000_000;
    limiter.check('k', t0);
    const denied = limiter.check('k', t0 + 25_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(35); // 60s window − 25s elapsed
  });

  it('keeps keys independent', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    expect(limiter.check('a', 1_000_000).allowed).toBe(true);
    expect(limiter.check('b', 1_000_000).allowed).toBe(true);
    expect(limiter.check('a', 1_000_001).allowed).toBe(false);
  });

  it('exposes the login policy as conservative constants', () => {
    expect(LOGIN_RATE_LIMITS.perIp).toBeLessThanOrEqual(20);
    expect(LOGIN_RATE_LIMITS.perAccount).toBeLessThanOrEqual(
      LOGIN_RATE_LIMITS.perIp,
    );
  });
});
