import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  OutboxDispatcher,
  startDispatcherLoop,
  type OutboxHandler,
} from './dispatcher';

/**
 * Dispatcher unit (no DB): backoff math, registry/claim filtering contract,
 * empty-registry no-op, poll-loop wiring. DB behaviors (SKIP LOCKED claims,
 * retry/DLQ transitions) are covered by dispatcher.integration.spec.ts.
 */

function makeDispatcher(
  handlers: ReadonlyMap<string, OutboxHandler>,
  opts?: ConstructorParameters<typeof OutboxDispatcher>[2],
): OutboxDispatcher {
  const pool = {
    connect: () => {
      throw new Error('pool must not be touched in unit tests');
    },
  } as unknown as Pool;
  return new OutboxDispatcher(pool, handlers, { jitter: () => 0, ...opts });
}

describe('OutboxDispatcher (unit)', () => {
  it('backoff: exponential from base, bounded by cap, jitter stays within base', () => {
    const d = makeDispatcher(new Map([['a', async () => undefined]]), {
      baseBackoffMs: 1000,
      maxBackoffMs: 8000,
      jitter: () => 0,
    });
    expect(d.backoffMs(1)).toBe(1000);
    expect(d.backoffMs(2)).toBe(2000);
    expect(d.backoffMs(3)).toBe(4000);
    expect(d.backoffMs(4)).toBe(8000); // capped (would be 16000)
    expect(d.backoffMs(10)).toBe(8000); // stays capped

    const jittery = makeDispatcher(
      new Map([['a', async () => undefined]]),
      { baseBackoffMs: 1000, maxBackoffMs: 60_000, jitter: () => 0.999 },
    );
    expect(jittery.backoffMs(1)).toBe(1999); // 1000 + floor(0.999*1000)
    expect(jittery.backoffMs(4)).toBeLessThan(60_000 + 1000);
  });

  it('empty registry: tick is a no-op and never touches the pool', async () => {
    const d = makeDispatcher(new Map());
    expect(await d.tick()).toEqual({
      claimed: 0,
      published: 0,
      retried: 0,
      dead: 0,
    });
    expect(d.handledTypes()).toEqual([]);
  });

  it('handledTypes lists the registered claim filter', () => {
    const d = makeDispatcher(
      new Map([
        ['case.created', async () => undefined],
        ['email.delivery.failed', async () => undefined],
      ]),
    );
    expect(d.handledTypes().sort()).toEqual([
      'case.created',
      'email.delivery.failed',
    ]);
  });

  it('poll loop ticks on the interval and routes failures to onError', async () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn().mockRejectedValue(new Error('boom'));
      const onError = vi.fn();
      const loop = startDispatcherLoop(
        { tick } as unknown as OutboxDispatcher,
        1000,
        onError,
      );
      vi.advanceTimersByTime(3100);
      expect(tick).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(3));
      loop.stop();
      vi.advanceTimersByTime(5000);
      expect(tick).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
