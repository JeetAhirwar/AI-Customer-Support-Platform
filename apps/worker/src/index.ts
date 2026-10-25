import { Pool } from 'pg';
import { OutboxDispatcher, startDispatcherLoop } from './dispatcher';
import { startWorker } from './runtime';
import { createWorkerLogger } from './logger';

/**
 * Worker process (ADR-010 §worker, ADR-002 dispatch, ADR-008 logging).
 * Connects with the OWNER role (WORKER_DATABASE_URL) because outbox
 * claiming drains all tenants by design (RLS would block it — ADR-003
 * two-role model). Handlers are registered per event type; P2 ships the
 * machinery (no producers yet — the cases slice starts emitting
 * 'case.created' etc.).
 */

const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 30000);
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);

const logger = createWorkerLogger();

const databaseUrl = process.env.WORKER_DATABASE_URL;
if (!databaseUrl) {
  // fail fast, name the variable (same policy as the API's config validation)
  logger.fatal(
    { variable: 'WORKER_DATABASE_URL' },
    'WORKER_DATABASE_URL is required (owner-role URL, see ENVIRONMENT_VARIABLES.md)',
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });

// P2: no registered handlers — producers land with the cases slice. Until
// then the dispatcher idles honestly (claim filter = zero types).
const dispatcher = new OutboxDispatcher(pool, new Map(), { logger });

const loop = startDispatcherLoop(
  dispatcher,
  POLL_MS,
  (err) => logger.error({ err }, 'outbox tick failed'),
  logger,
);
const heartbeat = startWorker(() => {
  logger.info(
    { handled_types: dispatcher.handledTypes().length },
    'worker heartbeat',
  );
}, HEARTBEAT_MS);

logger.info(
  { poll_ms: POLL_MS, handled_types: dispatcher.handledTypes().length },
  'worker started (outbox dispatcher)',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker stopping');
  loop.stop();
  heartbeat.stop();
  await pool.end().catch((err: unknown) =>
    logger.warn({ err }, 'pool end failed during shutdown'),
  );
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
