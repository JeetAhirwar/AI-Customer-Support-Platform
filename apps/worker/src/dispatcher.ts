import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { createWorkerLogger } from './logger';

/**
 * Outbox dispatcher (ADR-002) — drains `outbox_events` from Postgres.
 *
 * Claim model: one transaction per tick. `FOR UPDATE SKIP LOCKED` claims a
 * batch (concurrent dispatchers never double-claim); each handler runs; rows
 * finalize to `published` / retry (`pending` + backoff) / `dead` (DLQ) — all
 * inside the SAME transaction. A crash mid-batch rolls the transaction back
 * and the rows are reclaimed on the next tick: at-least-once, no stuck
 * `processing` states, no reaper job.
 *
 * Connection: the OWNER role (WORKER_DATABASE_URL) — claiming drains all
 * tenants by design, so RLS tenant policies would block it (ADR-003 two-role
 * model; the API role is INSERT-only on this table).
 *
 * Handlers MUST be idempotent keyed on `event.id` (delivery is at-least-once:
 * external side effects survive a rollback and may run twice).
 */

export interface OutboxEvent {
  id: string;
  tenantId: string;
  type: string;
  schemaVersion: number;
  payloadRef: string | null;
  correlationId: string | null;
  /** incremented at claim time — this attempt's number */
  attempts: number;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface DispatcherOptions {
  /** rows claimed per tick */
  batchSize: number;
  /** attempts >= maxAttempts -> state='dead' (DLQ) */
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** injectable for deterministic tests; returns [0,1) */
  jitter: () => number;
  /** structured JSON logger (ADR-008); defaults to the shared worker logger */
  logger: Logger;
}

const DEFAULTS: Omit<DispatcherOptions, 'logger'> = {
  batchSize: 10,
  maxAttempts: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 300_000,
  jitter: Math.random,
};

export interface TickResult {
  claimed: number;
  published: number;
  retried: number;
  dead: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  type: string;
  schema_version: number;
  payload_ref: string | null;
  correlation_id: string | null;
  attempts: number;
}

export class OutboxDispatcher {
  private readonly opts: Omit<DispatcherOptions, 'logger'>;
  private readonly logger: Logger;
  private ticking = false;

  constructor(
    private readonly pool: Pool,
    private readonly handlers: ReadonlyMap<string, OutboxHandler>,
    opts?: Partial<DispatcherOptions>,
  ) {
    const { logger, ...rest } = opts ?? {};
    this.opts = { ...DEFAULTS, ...rest };
    this.logger = logger ?? createWorkerLogger();
  }

  /** Event types this dispatcher can drain (claim filter). */
  handledTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Retry delay for a row that just failed attempt #`attempts`:
   * min(base · 2^(attempts−1), cap) + jitter(0..base) — bounded by cap.
   */
  backoffMs(attempts: number): number {
    const exponential = Math.min(
      this.opts.baseBackoffMs * 2 ** (attempts - 1),
      this.opts.maxBackoffMs,
    );
    const jitter = Math.floor(this.opts.jitter() * this.opts.baseBackoffMs);
    return Math.min(exponential + jitter, this.opts.maxBackoffMs);
  }

  /** One poll cycle: claim → handle → finalize (single transaction). */
  async tick(): Promise<TickResult> {
    const types = this.handledTypes();
    if (types.length === 0 || this.ticking) {
      return { claimed: 0, published: 0, retried: 0, dead: 0 };
    }
    this.ticking = true;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<ClaimedRow>(
        `WITH claimed AS (
           SELECT id FROM outbox_events
            WHERE state = 'pending'
              AND next_attempt_at <= now()
              AND type = ANY($1)
            ORDER BY created_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events e
            SET attempts = e.attempts + 1
           FROM claimed c
          WHERE e.id = c.id
          RETURNING e.id, e.tenant_id, e.type, e.schema_version,
                    e.payload_ref, e.correlation_id, e.attempts`,
        [types, this.opts.batchSize],
      );

      let published = 0;
      let retried = 0;
      let dead = 0;

      for (const row of claimed.rows) {
        const event: OutboxEvent = {
          id: row.id,
          tenantId: row.tenant_id,
          type: row.type,
          schemaVersion: row.schema_version,
          payloadRef: row.payload_ref,
          correlationId: row.correlation_id,
          attempts: row.attempts,
        };
        const handler = this.handlers.get(event.type)!; // claim filter guarantees it
        try {
          await handler(event);
          await client.query(
            `UPDATE outbox_events
                SET state = 'published', published_at = now()
              WHERE id = $1`,
            [event.id],
          );
          published++;
        } catch (err) {
          if (event.attempts >= this.opts.maxAttempts) {
            // DLQ: terminal — logged loudly, alert-ready (never silent)
            this.logger.error(
              {
                outbox_event_id: event.id,
                event_type: event.type,
                tenant_id: event.tenantId,
                attempts: event.attempts,
                correlation_id: event.correlationId,
                err,
              },
              'outbox event dead (DLQ) - operator action required',
            );
            await client.query(
              `UPDATE outbox_events SET state = 'dead' WHERE id = $1`,
              [event.id],
            );
            dead++;
          } else {
            const delay = this.backoffMs(event.attempts);
            await client.query(
              `UPDATE outbox_events
                  SET state = 'pending',
                      next_attempt_at = now() + ($2 || ' milliseconds')::interval
                WHERE id = $1`,
              [event.id, String(delay)],
            );
            retried++;
          }
        }
      }

      await client.query('COMMIT');
      return { claimed: claimed.rowCount ?? 0, published, retried, dead };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
      this.ticking = false;
    }
  }
}

export interface DispatcherRuntime {
  stop(): void;
}

/** Poll loop on top of tick(): overlapping ticks are skipped (backpressure),
 *  so a slow handler degrades to sequential batches, never a pile-up.
 *  Errors route to onError (default: structured error line, ADR-008).
 */
export function startDispatcherLoop(
  dispatcher: OutboxDispatcher,
  pollMs: number,
  onError?: (err: unknown) => void,
  logger?: Logger,
): DispatcherRuntime {
  const log = logger ?? createWorkerLogger();
  const timer = setInterval(() => {
    void dispatcher
      .tick()
      .catch((err) =>
        onError ? onError(err) : log.error({ err }, 'outbox tick failed'),
      );
  }, pollMs);
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
