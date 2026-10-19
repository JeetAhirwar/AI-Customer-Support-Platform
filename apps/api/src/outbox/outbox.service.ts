import { Injectable } from '@nestjs/common';
import type { ScopeClient } from '../db/tenant-scope';

/**
 * Transactional outbox (ADR-002, DATABASE_DESIGN §5) — the durability source
 * of truth for async work. Producers call append() WITH their business
 * transaction: the event row commits or rolls back atomically with the domain
 * rows ("write-then-publish" of two unrelated operations is forbidden).
 *
 * Dispatch happens in the worker (OutboxDispatcher, owner role, SKIP LOCKED
 * claims). Delivery is at-least-once — handlers must be idempotent keyed on
 * event id. The app role is INSERT-only on outbox_events (006_outbox revokes
 * UPDATE/DELETE); there is no public read endpoint — outbox is plumbing.
 */

export interface OutboxAppendInput {
  tenantId: string;
  /** dotted catalog name per API_CONTRACTS §3, e.g. 'case.created' */
  type: string;
  /** P2: small serialized JSON payload string; never message bodies */
  payloadRef?: string | null;
  schemaVersion?: number;
  /** X-Correlation-ID from ingress, propagated end-to-end */
  correlationId?: string | null;
}

@Injectable()
export class OutboxService {
  /**
   * Appends one event using the CALLER's scoped transaction (`withTenant`
   * client) — this is what makes the write atomic with the business change.
   * Rejects if the insert fails; callers propagate (never swallow).
   * Returns the generated event id (the at-least-once dedup key for handlers).
   */
  async append(client: ScopeClient, event: OutboxAppendInput): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO outbox_events
         (tenant_id, type, schema_version, payload_ref, correlation_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        event.tenantId,
        event.type,
        event.schemaVersion ?? 1,
        event.payloadRef ?? null,
        event.correlationId ?? null,
      ],
    );
    return res.rows[0]!.id;
  }
}
