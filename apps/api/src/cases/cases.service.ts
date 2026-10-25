import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors';
import { withTenant, type ScopeClient } from '../db/tenant-scope';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Cases service — the first business slice (P3 increment 1: read + lifecycle),
 * over the RLS-protected `cases` / `case_events` tables from migration 003.
 *
 * Rules honoured here:
 *  - every statement runs inside withTenant() (ADR-003) — tenant predicates
 *    are belt, RLS is braces; a cross-tenant id simply does not exist;
 *  - audit + outbox + the business row share ONE transaction: record() and
 *    append() receive the caller's client, so SECURITY.md §8's "audit-write
 *    failure fails the business transaction" is literally true (a failure
 *    rolls back the write instead of leaving a gap);
 *  - `updated_at` is written EXPLICITLY (migration 003 has no trigger) — the
 *    keyset ordering below depends on it, so every lifecycle write bumps it;
 *  - keyset pagination only, never offset (API_CONTRACTS §1);
 *  - audit metadata carries structured facts only — never a note body.
 *
 * Deliberately NOT in this increment (documented in API_CONTRACTS):
 * reply/handoff (need channel delivery state + the AI send-lock) and
 * Idempotency-Key storage (lands with messages.idempotency_key in P3b).
 * Resolve/reopen are idempotent by behaviour instead: a repeat call is a
 * no-op that returns `changed: false` rather than a duplicate transition.
 */

export const CASE_STATUSES = [
  'new',
  'open',
  'pending',
  'on_hold',
  'resolved',
  'closed',
  'reopened',
] as const;
export const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const CASE_CHANNELS = ['chat', 'email', 'voice'] as const;
/** terminal states: resolving them again is a no-op, reopening is required first */
export const RESOLVED_STATUSES = ['resolved', 'closed'] as const;

export function isResolvedStatus(status: string): boolean {
  return RESOLVED_STATUSES.some((value) => value === status);
}

export interface CaseRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  conversation_id: string | null;
  status: string;
  priority: string;
  queue_id: string | null;
  assignee_id: string | null;
  sla_due_at: Date | null;
  resolution_code: string | null;
  resolved_at: Date | null;
  reopened_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** microsecond-exact text of updated_at, for building the list cursor */
  updated_at_text: string;
  /** display joins — customer/queue/channel/assignee are same-tenant by RLS */
  customer_name: string | null;
  customer_email: string | null;
  queue_name: string | null;
  channel: string | null;
  assignee_email: string | null;
}

export interface CaseTimelineRow {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  /** microsecond-exact text of occurred_at, for building the timeline cursor */
  occurred_at_text: string;
}

export interface CaseListQuery {
  limit: number;
  /**
   * keyset position: raw `updated_at` text (as Postgres produced it) + row id.
   * Kept as TEXT, never a JS Date: Date survives only to milliseconds while
   * the column has microseconds, and a rounded cursor silently drops or
   * repeats rows written inside the same millisecond.
   */
  cursor?: { at: string; id: string };
  status?: string[];
  priority?: string[];
  assigneeId?: string;
  queueId?: string;
  channel?: string;
  sla?: 'overdue';
}

export interface CaseListPage {
  cases: CaseRow[];
  /** opaque `${updated_at text}|${id}` — pass back as ?cursor= ; null = last page */
  nextCursor: string | null;
}

export interface CaseDetailPage {
  case: CaseRow;
  timeline: CaseTimelineRow[];
  nextCursor: string | null;
}

export interface CaseTransition {
  case: CaseRow;
  /** false = already in that state; nothing was written */
  changed: boolean;
}

/** cursor text carries full microsecond precision (`...123456Z`) */
export function encodeCaseCursor(row: {
  updated_at_text: string;
  id: string;
}): string {
  return `${row.updated_at_text}|${row.id}`;
}

const TIMESTAMP_TEXT = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CASE_COLUMNS = `
      c.id, c.tenant_id, c.customer_id, c.conversation_id, c.status,
      c.priority, c.queue_id, c.assignee_id, c.sla_due_at, c.resolution_code,
      c.resolved_at, c.reopened_at, c.created_at, c.updated_at,
      ${TIMESTAMP_TEXT('c.updated_at')} AS updated_at_text,
      cu.display_name AS customer_name,
      cu.email AS customer_email,
      q.name AS queue_name,
      cv.channel AS channel,
      u.email AS assignee_email`;

/**
 * Display joins. The assignee email is reached through tenant_memberships on
 * purpose: `users` has no RLS (identity, ADR-003), so a bare users join could
 * surface any account's address — joining via the membership makes the email
 * visible only when that user is a member of THIS tenant.
 */
const CASE_FROM = `
    FROM cases c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN queues q ON q.id = c.queue_id
    LEFT JOIN conversations cv ON cv.id = c.conversation_id
    LEFT JOIN tenant_memberships tm
           ON tm.tenant_id = c.tenant_id AND tm.user_id = c.assignee_id
    LEFT JOIN users u ON u.id = tm.user_id`;

const CASE_SELECT = `SELECT ${CASE_COLUMNS}${CASE_FROM}`;

const TIMELINE_COLUMNS = `
      e.id, e.event_type, e.actor_type, e.actor_id, e.metadata, e.occurred_at,
      ${TIMESTAMP_TEXT('e.occurred_at')} AS occurred_at_text`;

@Injectable()
export class CasesService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Keyset page of cases, newest activity first. */
  async list(tenantId: string, q: CaseListQuery): Promise<CaseListPage> {
    return withTenant(tenantId, async (client) => {
      const conditions = ['c.tenant_id = $1'];
      const params: unknown[] = [tenantId];
      const add = (sql: string, value: unknown): void => {
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
      };

      if (q.status?.length) add('c.status = ANY(?::text[])', q.status);
      if (q.priority?.length) add('c.priority = ANY(?::text[])', q.priority);
      if (q.assigneeId) add('c.assignee_id = ?::uuid', q.assigneeId);
      if (q.queueId) add('c.queue_id = ?::uuid', q.queueId);
      if (q.channel) add('cv.channel = ?', q.channel);
      if (q.sla === 'overdue') {
        conditions.push(
          `c.sla_due_at IS NOT NULL AND c.sla_due_at < now() ` +
            `AND c.status NOT IN ('resolved', 'closed')`,
        );
      }
      if (q.cursor) {
        params.push(q.cursor.at);
        const ts = `$${params.length}`;
        params.push(q.cursor.id);
        conditions.push(
          `(c.updated_at, c.id) < (${ts}::timestamptz, $${params.length}::uuid)`,
        );
      }
      params.push(q.limit + 1); // one extra row = "there is another page"

      const res = await client.query<CaseRow>(
        `${CASE_SELECT}
       WHERE ${conditions.join('\n         AND ')}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $${params.length}`,
        params,
      );
      const rows = res.rows;
      const cases = rows.slice(0, q.limit);
      const last = cases[cases.length - 1];
      return {
        cases,
        nextCursor:
          rows.length > q.limit && last ? encodeCaseCursor(last) : null,
      };
    });
  }

  /**
   * Case detail + its timeline (case_events, newest first, keyset-paginated
   * by the same ?cursor= parameter). Message history arrives with the reply
   * slice — case_events is the case's own timeline (notes, transitions).
   * A case id from another tenant is indistinguishable from an unknown one.
   */
  async detail(
    tenantId: string,
    caseId: string,
    timelineLimit: number,
    timelineCursor?: { at: string; id: string },
  ): Promise<CaseDetailPage> {
    return withTenant(tenantId, async (client) => {
      const caseRes = await client.query<CaseRow>(
        `${CASE_SELECT}
       WHERE c.tenant_id = $1 AND c.id = $2`,
        [tenantId, caseId],
      );
      const row = caseRes.rows[0];
      if (!row) throw new AppException('not_found', 'Case not found');

      const params: unknown[] = [tenantId, caseId];
      let cursorClause = '';
      if (timelineCursor) {
        params.push(timelineCursor.at, timelineCursor.id);
        cursorClause = ` AND (e.occurred_at, e.id) < ($3::timestamptz, $4::uuid)`;
      }
      params.push(timelineLimit + 1);

      const timelineRes = await client.query<CaseTimelineRow>(
        `SELECT ${TIMELINE_COLUMNS}
           FROM case_events e
          WHERE e.tenant_id = $1 AND e.case_id = $2${cursorClause}
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT $${params.length}`,
        params,
      );
      const rows = timelineRes.rows;
      const timeline = rows.slice(0, timelineLimit);
      const last = timeline[timeline.length - 1];
      return {
        case: row,
        timeline,
        nextCursor:
          rows.length > timelineLimit && last
            ? `${last.occurred_at_text}|${last.id}`
            : null,
      };
    });
  }

  /**
   * Internal note — never customer-visible: it is a case_event (timeline),
   * not a message (channel). Bumps updated_at so the list's "last activity"
   * ordering reflects it. The body lives in the timeline metadata only; the
   * audit row records that a note was added, not what it said.
   */
  async addNote(
    tenantId: string,
    caseId: string,
    actorId: string,
    body: string,
  ): Promise<CaseTimelineRow> {
    return withTenant(tenantId, async (client) => {
      await this.mustFind(client, tenantId, caseId);
      const event = await client.query<CaseTimelineRow>(
        `INSERT INTO case_events
           (tenant_id, case_id, event_type, actor_type, actor_id, metadata)
         VALUES ($1, $2, 'note', 'agent', $3, $4)
         RETURNING id, event_type, actor_type, actor_id, metadata, occurred_at,
                   ${TIMESTAMP_TEXT('occurred_at')} AS occurred_at_text`,
        [
          tenantId,
          caseId,
          actorId,
          JSON.stringify({ body, visibility: 'internal' }),
        ],
      );
      await client.query(`UPDATE cases SET updated_at = now() WHERE id = $1`, [
        caseId,
      ]);
      await this.audit.record(
        {
          tenantId,
          actorType: 'user',
          actorId,
          action: 'case.note.added',
          targetType: 'case',
          targetId: caseId,
          outcome: 'success',
          metadata: { event_type: 'note', visibility: 'internal' },
        },
        client,
      );
      return event.rows[0]!;
    });
  }

  /** Lifecycle: resolve. Repeat call = no-op (`changed: false`), no duplicate event. */
  async resolve(
    tenantId: string,
    caseId: string,
    actorId: string,
    resolutionCode?: string,
  ): Promise<CaseTransition> {
    return withTenant(tenantId, async (client) => {
      const current = await this.mustFind(client, tenantId, caseId, true);
      if (isResolvedStatus(current.status)) {
        return { case: current, changed: false };
      }
      const previousStatus = current.status;
      await client.query(
        `UPDATE cases
            SET status = 'resolved', resolved_at = now(),
                resolution_code = $2, updated_at = now()
          WHERE id = $1 AND tenant_id = $3`,
        [caseId, resolutionCode ?? null, tenantId],
      );
      const updated = await this.mustFind(client, tenantId, caseId);
      await this.transitionEvent(client, tenantId, caseId, actorId, {
        eventType: 'case.resolved',
        metadata: {
          previous_status: previousStatus,
          resolution_code: resolutionCode ?? null,
        },
      });
      await this.outbox.append(client, {
        tenantId,
        type: 'case.resolved',
        payloadRef: JSON.stringify({
          case_id: caseId,
          previous_status: previousStatus,
          resolution_code: resolutionCode ?? null,
        }),
      });
      await this.audit.record(
        {
          tenantId,
          actorType: 'user',
          actorId,
          action: 'case.resolved',
          targetType: 'case',
          targetId: caseId,
          outcome: 'success',
          metadata: {
            previous_status: previousStatus,
            resolution_code: resolutionCode ?? null,
          },
        },
        client,
      );
      return { case: updated, changed: true };
    });
  }

  /** Lifecycle: reopen — only from a resolved/closed case; otherwise a no-op. */
  async reopen(
    tenantId: string,
    caseId: string,
    actorId: string,
  ): Promise<CaseTransition> {
    return withTenant(tenantId, async (client) => {
      const current = await this.mustFind(client, tenantId, caseId, true);
      if (!isResolvedStatus(current.status)) {
        return { case: current, changed: false };
      }
      const previousStatus = current.status;
      await client.query(
        `UPDATE cases
            SET status = 'reopened', reopened_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [caseId, tenantId],
      );
      const updated = await this.mustFind(client, tenantId, caseId);
      await this.transitionEvent(client, tenantId, caseId, actorId, {
        eventType: 'case.reopened',
        metadata: { previous_status: previousStatus },
      });
      await this.outbox.append(client, {
        tenantId,
        type: 'case.reopened',
        payloadRef: JSON.stringify({
          case_id: caseId,
          previous_status: previousStatus,
        }),
      });
      await this.audit.record(
        {
          tenantId,
          actorType: 'user',
          actorId,
          action: 'case.reopened',
          targetType: 'case',
          targetId: caseId,
          outcome: 'success',
          metadata: { previous_status: previousStatus },
        },
        client,
      );
      return { case: updated, changed: true };
    });
  }

  /**
   * Loads one case for update (`FOR UPDATE OF c` locks only `cases` — the
   * joined display tables stay unlocked), or throws not_found. 404 is returned
   * for a foreign-tenant id exactly as for an unknown one.
   */
  private async mustFind(
    client: ScopeClient,
    tenantId: string,
    caseId: string,
    lock = false,
  ): Promise<CaseRow> {
    const res = await client.query<CaseRow>(
      `${CASE_SELECT}
       WHERE c.tenant_id = $1 AND c.id = $2${lock ? ' FOR UPDATE OF c' : ''}`,
      [tenantId, caseId],
    );
    const row = res.rows[0];
    if (!row) throw new AppException('not_found', 'Case not found');
    return row;
  }

  /** Timeline entry for a lifecycle transition (append-only table). */
  private async transitionEvent(
    client: ScopeClient,
    tenantId: string,
    caseId: string,
    actorId: string,
    input: { eventType: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await client.query(
      `INSERT INTO case_events
         (tenant_id, case_id, event_type, actor_type, actor_id, metadata)
       VALUES ($1, $2, $3, 'agent', $4, $5)`,
      [
        tenantId,
        caseId,
        input.eventType,
        actorId,
        JSON.stringify(input.metadata),
      ],
    );
  }
}
