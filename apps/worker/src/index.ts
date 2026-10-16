import { startWorker } from './runtime';

const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 30000);

const runtime = startWorker(() => {
  // eslint-disable-next-line no-console
  console.log(`[worker] heartbeat ${new Date().toISOString()} (outbox consumer lands in P2)`);
}, HEARTBEAT_MS);

console.log('[worker] started (scaffold)');

function shutdown(signal: string): void {
  console.log(`[worker] ${signal} received - stopping`);
  runtime.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
