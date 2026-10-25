import pino from 'pino';
import { buildPinoOptions, resolveLogLevel } from '@aicsp/shared';

/**
 * Worker logger (ADR-008 §1/§5): same shared options builder as the API —
 * structured JSON to stdout, LOG_LEVEL fail-fast, identical redaction list.
 * No correlation mixin here: the worker has no HTTP requests; outbox events
 * carry their own `correlation_id` which handlers log explicitly.
 */
export function createWorkerLogger(): pino.Logger {
  return pino(
    buildPinoOptions({
      level: resolveLogLevel(process.env.LOG_LEVEL),
      service: 'worker',
    }),
  );
}
