/**
 * Minimal worker runtime (Phase-2 scaffold).
 * The real outbox→queue consumer is built in P2 (see PROGRESS_TRACKER);
 * this scaffold provides lifecycle + heartbeat so processes, CI and
 * process managers have something honest to run from day one.
 */
export interface WorkerRuntime {
  stop(): void;
}

export function startWorker(
  onTick: () => void,
  intervalMs: number,
): WorkerRuntime {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('intervalMs must be a positive number');
  }
  const timer = setInterval(onTick, intervalMs);
  // allow natural process exit when idle (no unref needed for managed runs)
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
