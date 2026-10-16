import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from './runtime';

describe('startWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects non-positive intervals', () => {
    expect(() => startWorker(() => {}, 0)).toThrow();
    expect(() => startWorker(() => {}, Number.NaN)).toThrow();
  });

  it('ticks at the given interval and stops cleanly', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const runtime = startWorker(tick, 1000);

    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);

    runtime.stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
