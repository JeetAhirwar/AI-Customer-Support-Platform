import { Injectable } from '@nestjs/common';
import { withTenant, type ScopeClient } from '../db/tenant-scope';
import { getCorrelationId } from '../observability/correlation';

/**
 * Audit trail (SERVICE_BOUNDARIES §10 audit — leaf module; depends on nothing).
 *  - append-only: the app role can only INSERT (migration 005 revokes
 *    UPDATE/DELETE; RLS tenant policy on the table);
 *  - failure semantics (SECURITY.md §8): record() REJECTS on write failure
 *    and callers MUST await it before completing a sensitive transaction —
 *    "audit-write failure fails the business transaction", never a silent gap;
 *  - no message bodies in metadata (DATABASE_DESIGN §5) — structured,
 *    redacted-safe facts only;
 *  - read path: GET /v1/audit-events, admin-only via RolesGuard (owner/admin
 *    hold `audit.view` in the permission catalog).
 */

/** actor vocabulary per DATABASE_DESIGN §5; actions are dotted names. */
export type AuditActorType = 'user' | 'system' | 'ai' | 'integration';
export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEventInput {
  tenantId: string;
  actorType: AuditActorType;
  /** no FK on purpose — the trail outlives actors (spec) */
  actorId?: string | null;
  /** dotted convention, e.g. 'auth.login', 'tenant.switch' */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: AuditOutcome;
  correlationId?: string | null;
  /** structured, redacted-safe facts only — never message bodies */
  metadata?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

export interface AuditListQuery {
  action?: string;
  actorId?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  /** keyset position: (occurred_at, id) of the last item already delivered */
  cursor?: { occurredAt: Date; id: string };
  limit: number;
}

export interface AuditListPage {
  events: AuditEventRow[];
  /** opaque `${occurredAt ISO}|${id}` — pass back as ?cursor= ; null = last page */
  nextCursor: string | null;
}

function encodeCursor(row: { occurred_at: Date; id: string }): string {
  return `${row.occurred_at.toISOString()}|${row.id}`;
}

@Injectable()
export class AuditService {
  /**
   * Appends one event inside a tenant-scoped transaction (RLS). Rejects if the
   * insert fails — callers propagate (SECURITY.md §8 no-silent-gap rule).
   *
   * Optional `client` lets a caller share ITS transaction, so audit + business
   * rows + outbox events commit or roll back together ("audit-write failure
   * fails the business transaction" becomes literally true instead of true
   * only for the request's response). Prefer passing a client whenever a
   * business write is being audited; without one this opens its own scope.
   */
  async record(event: AuditEventInput, client?: ScopeClient): Promise<void> {
    // correlation defaults from the request context (ADR-008 §2) — one id
    // threads logs + audit + envelope; explicit parameter still wins.
    const sql = `INSERT INTO audit_events
           (tenant_id, actor_type, actor_id, action, target_type, target_id,
            outcome, correlation_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
    const values = [
      event.tenantId,
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      event.outcome,
      event.correlationId ?? getCorrelationId() ?? null,
      JSON.stringify(event.metadata ?? {}),
    ];
    if (client) {
      await client.query(sql, values);
      return;
    }
    await withTenant(event.tenantId, (scope) => scope.query(sql, values));
  }

  /**
   * Keyset pagination on (occurred_at, id) DESC — newest first, never offset
   * (API_CONTRACTS §conventions). Tenant isolation comes from RLS + the
   * explicit tenant_id predicate (withTenant sets the scope).
   */
  async list(tenantId: string, query: AuditListQuery): Promise<AuditListPage> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (query.action) add('action = ?', query.action);
    if (query.actorId) add('actor_id = ?', query.actorId);
    if (query.outcome) add('outcome = ?', query.outcome);
    if (query.targetType) add('target_type = ?', query.targetType);
    if (query.targetId) add('target_id = ?', query.targetId);
    if (query.from) add('occurred_at >= ?', query.from);
    if (query.to) add('occurred_at <= ?', query.to);
    if (query.cursor) {
      params.push(query.cursor.occurredAt, query.cursor.id);
      conditions.push(
        `(occurred_at, id) < ($${params.length - 1}::timestamptz, ` +
          `$${params.length}::uuid)`,
      );
    }

    params.push(query.limit + 1); // one extra row detects a next page
    const rows = await withTenant(tenantId, (client) =>
      client.query<AuditEventRow>(
        `SELECT id, actor_type, actor_id, action, target_type, target_id,
                outcome, correlation_id, metadata, occurred_at
           FROM audit_events
          WHERE ${conditions.join(' AND ')}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      ),
    );

    const hasMore = rows.rows.length > query.limit;
    const events = hasMore ? rows.rows.slice(0, query.limit) : rows.rows;
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }
}
