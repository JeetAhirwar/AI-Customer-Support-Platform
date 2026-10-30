import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors';
import { withTenant, type ScopeClient } from '../db/tenant-scope';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Cases service — the first business slice (P3 increment 1: read + lifecycle;
 * P3b: reply + handoff + Idempotency-Key + message history), over the
 * RLS-protected `cases` / `case_events` / `messages` / `handoffs` tables from
 * migration 003 (no new migration needed — 003 already carried
 * `messages.idempotency_key` with its `(tenant_id, idempotency_key)` unique
 * index and the whole `handoffs` table).
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
 *  - audit metadata carries structured facts only — never a note/reply body.
 *
 * Deliberately NOT in this increment: the `case.created` producer (no
 * case-creation endpoint exists yet) and the `AI-handled` list filter (no
 * column yet). The AI side of the send-lock (SERVICE_BOUNDARIES §4: "AI vs
 * human send-lock") lands with ai-orchestration — the human side is already
 * serialized: reply/handoff lock the case row `FOR UPDATE` and refuse
 * terminal states, so a concurrent AI send can never race a human one once
 * the AI actor exists.
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

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: string;
  actor_type: string;
  /**
   * Migration 003's `body_preview` is currently the ONLY inline content
   * column (`body_ref` points at object storage, which no channel adapter
   * writes yet) — chat-sized bodies (validated ≤ 10 000 chars) are stored
   * whole here. Reviewed when the channels/content slice lands.
   */
  body_preview: string | null;
  delivery_state: string;
  sent_at: Date | null;
  created_at: Date;
  /** microsecond-exact text of created_at, for building the message cursor */
  created_at_text: string;
}

export interface HandoffRow {
  id: string;
  case_id: string;
  reason: string;
  destination_queue_id: string | null;
  state: string;
  requested_at: Date;
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
  /** page of the conversation's message history (newest first) */
  messages: MessageRow[];
  /** opaque `${created_at text}|${id}` for `?messages_cursor=` ; null = last page */
  messagesNextCursor: string | null;
  nextCursor: string | null;
}

export interface CaseTransition {
  case: CaseRow;
  /** false = already in that state; nothing was written */
  changed: boolean;
}

export interface ReplyResult {
  message: MessageRow;
  /** true = an earlier request with the same Idempotency-Key was returned */
  idempotentReplayed: boolean;
}

export interface HandoffResult {
  handoff: HandoffRow;
  /** false = a handoff is already in `requested` state for this case */
  created: boolean;
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

const messageColumns = (prefix: string): string =>
  `
        ${prefix}id, ${prefix}conversation_id, ${prefix}direction,
        ${prefix}actor_type, ${prefix}body_preview, ${prefix}delivery_state,
        ${prefix}sent_at, ${prefix}created_at,
        ${TIMESTAMP_TEXT(`${prefix}created_at`)} AS created_at_text`;

/** `m.`-aliased form for SELECTs; the bare form serves INSERT … RETURNING */
const MESSAGE_COLUMNS = messageColumns('m.');

/** same shape as the timeline/list cursor: `${timestamp text}|${id}` */
const encodeMessageCursor = (row: MessageRow): string =>
  `${row.created_at_text}|${row.id}`;

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
   * by ?cursor=) + the first page of the conversation's message history
   * (messages, newest first, keyset-paginated by ?messages_cursor= with
   * ?message_limit= — two independent cursors because they page two
   * different tables). Case events = the case's own timeline (notes,
   * transitions); message history = every message of the case's
   * conversation, all directions/actors (customer + agent + AI).
   * A case id from another tenant is indistinguishable from an unknown one.
   */
  async detail(
    tenantId: string,
    caseId: string,
    timelineLimit: number,
    timelineCursor?: { at: string; id: string },
    messagesLimit = 50,
    messagesCursor?: { at: string; id: string },
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

      // --- message history: one more query in the same transaction. A case
      // without a conversation (a bare record) has none by definition.
      let messages: MessageRow[] = [];
      let messagesNextCursor: string | null = null;
      if (row.conversation_id) {
        const mParams: unknown[] = [tenantId, row.conversation_id];
        let mClause = '';
        if (messagesCursor) {
          mParams.push(messagesCursor.at, messagesCursor.id);
          mClause = ` AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)`;
        }
        mParams.push(messagesLimit + 1);
        const msgRes = await client.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS}
           FROM messages m
          WHERE m.tenant_id = $1 AND m.conversation_id = $2${mClause}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $${mParams.length}`,
          mParams,
        );
        messages = msgRes.rows.slice(0, messagesLimit);
        const lastMsg = messages[messages.length - 1];
        messagesNextCursor =
          msgRes.rows.length > messagesLimit && lastMsg
            ? encodeMessageCursor(lastMsg)
            : null;
      }

      return {
        case: row,
        timeline,
        messages,
        messagesNextCursor,
        nextCursor:
          rows.length > timelineLimit && last
            ? `${last.occurred_at_text}|${last.id}`
            : null,
      };
    });
  }

  /**
   * Agent reply — appends an outbound `messages` row to the case's
   * conversation (P3b). Semantics:
   *  - the case must be re-openable (never resolved/closed: the reply would
   *    reach a customer after the case ended — reopen first instead);
   *  - the case must have a conversation (a bare record cannot carry a
   *    channel reply);
   *  - the case row is locked FOR UPDATE, which serializes concurrent
   *    human sends — the human half of the AI vs human send-lock;
   *  - `Idempotency-Key` (API_CONTRACTS §1): with a key, the
   *    `(tenant_id, idempotency_key)` unique index collapses a retry to the
   *    ORIGINAL message (`idempotentReplayed: true`, no duplicate row, no
   *    second audit/outbox event). A key already bound to a different
   *    conversation of the tenant is a conflict — the retry would otherwise
   *    "succeed" against the wrong thread;
   *  - delivery_state starts 'pending' honestly: no channel adapter exists
   *    yet, so nothing has been delivered — the channels slice owns
   *    pending → sent → delivered/failed;
   *  - audit (action message.sent) + outbox (message.sent — additive event
   *    catalog entry for the widget live stream) + the message row + the
   *    updated_at bump commit in ONE transaction; audit metadata never
   *    carries the body.
   */
  async reply(
    tenantId: string,
    caseId: string,
    actorId: string,
    input: { body: string; idempotencyKey?: string },
  ): Promise<ReplyResult> {
    return withTenant(tenantId, async (client) => {
      const current = await this.mustFind(client, tenantId, caseId, true);
      if (isResolvedStatus(current.status)) {
        throw new AppException(
          'conflict',
          'This case is resolved — reopen it before replying',
        );
      }
      if (!current.conversation_id) {
        throw new AppException(
          'conflict',
          'This case has no conversation to reply on',
        );
      }

      const insertRes = await client.query<MessageRow>(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, actor_type, body_preview,
            idempotency_key, delivery_state)
         VALUES ($1, $2, 'outbound', 'agent', $3, $4, 'pending')
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING ${messageColumns('')}`,
        [tenantId, current.conversation_id, input.body, input.idempotencyKey ?? null],
      );

      let message = insertRes.rows[0];
      let replayed = false;
      if (!message) {
        // the key already exists for this tenant — the API contract says
        // duplicates return the ORIGINAL result, or conflict when it would
        // land on a different thread
        const existingRes = await client.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS}
             FROM messages m
            WHERE m.tenant_id = $1 AND m.idempotency_key = $2`,
          [tenantId, input.idempotencyKey],
        );
        message = existingRes.rows[0]!;
        if (message.conversation_id !== current.conversation_id) {
          throw new AppException(
            'conflict',
            'Idempotency-Key was already used for a different conversation',
          );
        }
        replayed = true;
      }

      if (!replayed) {
        await client.query(`UPDATE cases SET updated_at = now() WHERE id = $1`, [
          caseId,
        ]);
        await this.audit.record(
          {
            tenantId,
            actorType: 'user',
            actorId,
            action: 'message.sent',
            targetType: 'message',
            targetId: message.id,
            outcome: 'success',
            metadata: {
              case_id: caseId,
              conversation_id: current.conversation_id,
              direction: 'outbound',
              delivery_state: 'pending',
            },
          },
          client,
        );
        await this.outbox.append(client, {
          tenantId,
          type: 'message.sent',
          payloadRef: JSON.stringify({
            case_id: caseId,
            message_id: message.id,
            conversation_id: current.conversation_id,
            channel: current.channel,
          }),
        });
      }
      return { message, idempotentReplayed: replayed };
    });
  }

  /**
   * Agent handoff request (P3b) — inserts a `handoffs` row in state
   * `requested`, the `handoff.requested` case_event (which preserves the
   * optional summary next to the reason, as timeline metadata), the
   * `handoff.requested` OUTBOX event (API_CONTRACTS §3 catalog — the
   * routing/notifications consumers key off it) and the audit row.
   * Semantics:
   *  - only on non-terminal cases;
   *  - destination eligibility: the queue must exist in THIS tenant (a
   *    foreign-tenant queue id is 404, indistinguishable from unknown) and,
   *    when both channels are known, must match the case's channel;
   *  - one ACTIVE handoff per case: requesting again while one is in
   *    `requested` state returns the existing row (`created: false`) rather
   *    than queuing duplicates — idempotent by behaviour, like resolve;
   *  - the summary (context for the receiving human) lives in the
   *    case_event metadata — audit metadata records the reason (short,
   *    factual) but never the summary/body content.
   */
  async requestHandoff(
    tenantId: string,
    caseId: string,
    actorId: string,
    input: { reason: string; summary?: string; destinationQueueId?: string },
  ): Promise<HandoffResult> {
    return withTenant(tenantId, async (client) => {
      const current = await this.mustFind(client, tenantId, caseId, true);
      if (isResolvedStatus(current.status)) {
        throw new AppException(
          'conflict',
          'This case is resolved — reopen it before requesting a handoff',
        );
      }
      if (input.destinationQueueId) {
        const queue = await client.query<{ id: string; channel: string | null }>(
          `SELECT id, channel FROM queues WHERE id = $1::uuid`,
          [input.destinationQueueId],
        );
        const q = queue.rows[0];
        if (!q) {
          throw new AppException('not_found', 'Destination queue not found');
        }
        if (q.channel && current.channel && q.channel !== current.channel) {
          throw new AppException(
            'conflict',
            'Destination queue is bound to a different channel',
          );
        }
      }

      const active = await client.query<HandoffRow>(
        `SELECT id, case_id, reason, destination_queue_id, state, requested_at
           FROM handoffs
          WHERE tenant_id = $1 AND case_id = $2 AND state = 'requested'
          ORDER BY requested_at DESC, id DESC
          LIMIT 1`,
        [tenantId, caseId],
      );
      if (active.rows[0]) return { handoff: active.rows[0], created: false };

      const insert = await client.query<HandoffRow>(
        `INSERT INTO handoffs
           (tenant_id, case_id, reason, destination_queue_id, source_refs,
            state, requested_at)
         VALUES ($1, $2, $3, $4::uuid, '[]'::jsonb, 'requested', now())
         RETURNING id, case_id, reason, destination_queue_id, state,
                   requested_at`,
        [tenantId, caseId, input.reason, input.destinationQueueId ?? null],
      );
      const handoff = insert.rows[0]!;

      const metadata: Record<string, unknown> = {
        reason: input.reason,
        destination_queue_id: handoff.destination_queue_id,
        handoff_id: handoff.id,
        state: 'requested',
      };
      if (input.summary !== undefined) metadata.summary = input.summary;
      await this.transitionEvent(client, tenantId, caseId, actorId, {
        eventType: 'handoff.requested',
        metadata,
      });
      await client.query(`UPDATE cases SET updated_at = now() WHERE id = $1`, [
        caseId,
      ]);
      await this.outbox.append(client, {
        tenantId,
        type: 'handoff.requested',
        payloadRef: JSON.stringify({
          case_id: caseId,
          handoff_id: handoff.id,
          reason: input.reason,
          destination_queue_id: handoff.destination_queue_id,
        }),
      });
      await this.audit.record(
        {
          tenantId,
          actorType: 'user',
          actorId,
          action: 'case.handoff.requested',
          targetType: 'handoff',
          targetId: handoff.id,
          outcome: 'success',
          metadata: {
            case_id: caseId,
            reason: input.reason,
            destination_queue_id: handoff.destination_queue_id,
            state: 'requested',
          },
        },
        client,
      );
      return { handoff, created: true };
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
