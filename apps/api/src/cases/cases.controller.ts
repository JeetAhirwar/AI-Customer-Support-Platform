import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppException } from '../common/errors';
import { RolesGuard } from '../rbac/roles.guard';
import { RequirePermissions } from '../rbac/permissions.decorator';
import {
  CASE_CHANNELS,
  CASE_PRIORITIES,
  CASE_STATUSES,
  CasesService,
  type CaseRow,
  type CaseTimelineRow,
  type HandoffRow,
  type MessageRow,
} from './cases.service';

/**
 * Cases API (API_CONTRACTS §2; P3 increment 1: read + lifecycle — P3b:
 * reply + handoff + Idempotency-Key + message history).
 *
 * Authz is declared PER ENDPOINT (SECURITY.md §auth: "permission checks
 * default-deny; new endpoints require an explicit authz decision in code
 * review") — the RolesGuard re-resolves the membership from the DB on every
 * call, so revocation and role edits apply to the next request:
 *
 *   GET  /v1/cases              cases.view   (owner/admin/agent/viewer)
 *   GET  /v1/cases/{id}         cases.view   (timeline = ?cursor= on case_events;
 *                                            messages = ?messages_cursor=/?message_limit=)
 *   POST /v1/cases/{id}/notes   cases.reply  (owner/admin/agent — viewer 403)
 *   POST /v1/cases/{id}/reply   cases.reply  (Idempotency-Key honoured; 409 on a
 *                                            resolved case / reused key)
 *   POST /v1/cases/{id}/handoff cases.reply  (agent escalation; one active
 *                                            handoff per case; queue eligibility)
 *   POST /v1/cases/{id}/resolve cases.reply  (idempotent: changed=false if already)
 *   POST /v1/cases/{id}/reopen  cases.reply  (only from resolved/closed)
 *
 * `cases.manage` stays reserved for assignment/queue changes (founder
 * decision 2026-10-25: agents resolve their own cases; handoff = requesting
 * escalation, not reassignment — if a handoff ever starts mutating
 * assignment/queues it moves to `cases.manage`).
 *
 * The handoff ACCEPT endpoint (`handoff.accepted`) lands with the routing
 * slice; `case.created` waits for a case-creation endpoint.
 */

interface RequestWithClaims extends FastifyRequest {
  user?: { sub?: string; tid?: string };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RESOLUTION_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const DEFAULT_TIMELINE_LIMIT = 100;
export const MAX_TIMELINE_LIMIT = 200;
export const MAX_NOTE_LENGTH = 5000;
/** chat-sized body stored whole in `body_preview` (see cases.service) */
export const MAX_REPLY_LENGTH = 10_000;
export const MAX_HANDOFF_REASON = 512;
export const MAX_HANDOFF_SUMMARY = 5000;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;
/** no control characters (a newline inside a key cannot appear in a header) */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7E]{1,128}$/;

function invalid(message: string, details?: unknown): AppException {
  return new AppException('validation_failed', message, details);
}

/** query/form values arrive as string | string[]; take the last scalar form */
function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[value.length - 1]) : undefined;
  }
  return String(value);
}

/** `?status=new,open` and `?status=new&status=open` are both accepted */
function asList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseUuid(value: unknown, field: string): string {
  const raw = asString(value);
  if (!raw || !UUID_RE.test(raw)) {
    throw invalid(`${field} must be a UUID`);
  }
  return raw.toLowerCase();
}

export function parseLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const raw = asString(value);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw invalid('limit must be an integer');
  const parsed = Number(raw);
  if (parsed < 1 || parsed > max) {
    throw invalid(`limit must be between 1 and ${max}`);
  }
  return parsed;
}

/**
 * `timestamp|id` keyset position — wire format shared by list and timeline.
 * The timestamp stays TEXT: Postgres stores microseconds, JS Date does not,
 * and rounding the cursor would skip or repeat rows written in the same
 * millisecond (exactly what a single-transaction import produces).
 */
export function parseCaseCursor(
  value: unknown,
): { at: string; id: string } | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const match = CURSOR_RE.exec(raw);
  if (!match) throw invalid('cursor is malformed');
  if (Number.isNaN(new Date(match[1]!).getTime())) {
    throw invalid('cursor is malformed');
  }
  return { at: match[1]!, id: match[2]!.toLowerCase() };
}

/** Multi-valued filter: absent → undefined, otherwise validated member-wise. */
export function parseEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  const raw = asList(value);
  if (raw.length === 0) return undefined;
  const invalidValues = raw.filter((entry) => !allowed.includes(entry as T));
  if (invalidValues.length > 0) {
    throw invalid(
      `${field} must be one of: ${allowed.join(', ')}`,
      { received: invalidValues },
    );
  }
  return raw as T[];
}

export function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) {
    throw invalid(`${field} must be one of: ${allowed.join(', ')}`, {
      received: raw,
    });
  }
  return raw as T;
}

/**
 * Rejects unknown fields (API_CONTRACTS §1: "unknown fields on high-risk
 * endpoints rejected") — a typo'd key must fail loudly instead of silently
 * becoming a no-op the caller believes succeeded.
 */
export function parseObjectBody(
  body: unknown,
  allowed: readonly string[],
  options: { optional?: boolean } = {},
): Record<string, unknown> {
  if (body === undefined || body === null) {
    if (options.optional) return {};
    throw invalid('request body is required');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !allowed.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw invalid(`unknown field(s): ${unknownKeys.join(', ')}`, {
      allowed: [...allowed],
    });
  }
  return record;
}

export function parseNoteBody(body: unknown): { body: string } {
  const record = parseObjectBody(body, ['body']);
  const value = record.body;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid('body must be a non-empty string');
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw invalid(`body must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return { body: value };
}

export function parseResolveBody(body: unknown): {
  resolution_code?: string;
} {
  const record = parseObjectBody(body, ['resolution_code'], {
    optional: true,
  });
  const code = record.resolution_code;
  if (code === undefined) return {};
  if (typeof code !== 'string' || !RESOLUTION_CODE_RE.test(code)) {
    throw invalid(
      'resolution_code must be 1-64 characters of letters, digits, ".", "_" or "-"',
    );
  }
  return { resolution_code: code };
}

export function parseReplyBody(body: unknown): { body: string } {
  const record = parseObjectBody(body, ['body']);
  const value = record.body;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid('body must be a non-empty string');
  }
  if (value.length > MAX_REPLY_LENGTH) {
    throw invalid(`body must be at most ${MAX_REPLY_LENGTH} characters`);
  }
  return { body: value };
}

/**
 * Optional `Idempotency-Key` header (API_CONTRACTS §1) — printable ASCII
 * only, ≤ 128 chars: it is echoed nowhere and stored verbatim, but a key
 * built of control characters cannot even arrive as a proper HTTP header.
 */
export function parseIdempotencyKey(raw: unknown): string | undefined {
  const value = asString(raw);
  if (value === undefined || value === '') return undefined;
  if (!IDEMPOTENCY_KEY_RE.test(value)) {
    throw invalid(
      'Idempotency-Key must be 1-128 printable ASCII characters',
    );
  }
  return value;
}

export function parseHandoffBody(body: unknown): {
  reason: string;
  destination_queue_id?: string;
  summary?: string;
} {
  const record = parseObjectBody(body, [
    'reason',
    'destination_queue_id',
    'summary',
  ]);
  const reason = record.reason;
  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > MAX_HANDOFF_REASON
  ) {
    throw invalid(
      `reason must be a non-empty string of at most ${MAX_HANDOFF_REASON} characters`,
    );
  }
  const result: {
    reason: string;
    destination_queue_id?: string;
    summary?: string;
  } = { reason };
  if (record.destination_queue_id !== undefined) {
    result.destination_queue_id = parseUuid(
      record.destination_queue_id,
      'destination_queue_id',
    );
  }
  const summary = record.summary;
  if (summary !== undefined) {
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      throw invalid('summary must be a non-empty string');
    }
    if (summary.length > MAX_HANDOFF_SUMMARY) {
      throw invalid(
        `summary must be at most ${MAX_HANDOFF_SUMMARY} characters`,
      );
    }
    result.summary = summary;
  }
  return result;
}

/** The tenant is ALWAYS the verified JWT `tid` claim — never a parameter. */
function tenantOf(req: RequestWithClaims): string {
  const tid = req.user?.tid;
  if (!tid) {
    throw new AppException(
      'permission_denied',
      'No active tenant membership for this operation',
    );
  }
  return tid;
}

function actorOf(req: RequestWithClaims): string {
  const sub = req.user?.sub;
  if (!sub) {
    throw new AppException(
      'permission_denied',
      'No active tenant membership for this operation',
    );
  }
  return sub;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toApiCase(row: CaseRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    channel: row.channel ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_email: row.customer_email ?? null,
    conversation_id: row.conversation_id ?? null,
    queue_id: row.queue_id ?? null,
    queue_name: row.queue_name ?? null,
    assignee_id: row.assignee_id ?? null,
    assignee_email: row.assignee_email ?? null,
    sla_due_at: iso(row.sla_due_at),
    resolution_code: row.resolution_code ?? null,
    resolved_at: iso(row.resolved_at),
    reopened_at: iso(row.reopened_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function toApiTimelineEvent(
  row: CaseTimelineRow,
): Record<string, unknown> {
  return {
    id: row.id,
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    metadata: row.metadata,
    occurred_at: iso(row.occurred_at),
  };
}

export function toApiMessage(row: MessageRow): Record<string, unknown> {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    direction: row.direction,
    actor_type: row.actor_type,
    body: row.body_preview,
    delivery_state: row.delivery_state,
    sent_at: iso(row.sent_at),
    created_at: iso(row.created_at),
  };
}

export function toApiHandoff(row: HandoffRow): Record<string, unknown> {
  return {
    id: row.id,
    case_id: row.case_id,
    reason: row.reason,
    destination_queue_id: row.destination_queue_id,
    state: row.state,
    requested_at: iso(row.requested_at),
  };
}

@UseGuards(RolesGuard)
@Controller('v1/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  @RequirePermissions('cases.view')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() req: RequestWithClaims,
  ): Promise<{ cases: Record<string, unknown>[]; next_cursor: string | null }> {
    const cursor = parseCaseCursor(query.cursor);
    const page = await this.cases.list(tenantOf(req), {
      limit: parseLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT),
      cursor,
      status: parseEnumList(query.status, CASE_STATUSES, 'status'),
      priority: parseEnumList(query.priority, CASE_PRIORITIES, 'priority'),
      assigneeId:
        query.assignee_id === undefined
          ? undefined
          : parseUuid(query.assignee_id, 'assignee_id'),
      queueId:
        query.queue_id === undefined
          ? undefined
          : parseUuid(query.queue_id, 'queue_id'),
      channel: parseEnum(query.channel, CASE_CHANNELS, 'channel'),
      sla: parseEnum(query.sla, ['overdue'] as const, 'sla'),
    });
    return { cases: page.cases.map(toApiCase), next_cursor: page.nextCursor };
  }

  /** ?limit=/?cursor= page the timeline; ?message_limit=/?messages_cursor=
   *  page the conversation's message history; the case object is always complete. */
  @Get(':id')
  @RequirePermissions('cases.view')
  async detail(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: RequestWithClaims,
  ): Promise<{
    case: Record<string, unknown>;
    timeline: Record<string, unknown>[];
    next_cursor: string | null;
    messages: Record<string, unknown>[];
    messages_next_cursor: string | null;
  }> {
    // same wire format as the list cursor (`timestamp|id`), different column
    const page = await this.cases.detail(
      tenantOf(req),
      parseUuid(id, 'id'),
      parseLimit(query.limit, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT),
      parseCaseCursor(query.cursor),
      parseLimit(query.message_limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT),
      parseCaseCursor(query.messages_cursor),
    );
    return {
      case: toApiCase(page.case),
      timeline: page.timeline.map(toApiTimelineEvent),
      next_cursor: page.nextCursor,
      messages: page.messages.map(toApiMessage),
      messages_next_cursor: page.messagesNextCursor,
    };
  }

  @Post(':id/notes')
  @RequirePermissions('cases.reply')
  async addNote(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: RequestWithClaims,
  ): Promise<{ note: Record<string, unknown> }> {
    const note = parseNoteBody(body);
    const event = await this.cases.addNote(
      tenantOf(req),
      parseUuid(id, 'id'),
      actorOf(req),
      note.body,
    );
    return { note: toApiTimelineEvent(event) };
  }

  /** 201 always; on a replayed Idempotency-Key the ORIGINAL message comes
   *  back with `idempotent_replayed: true` (API_CONTRACTS §1). */
  @Post(':id/reply')
  @HttpCode(201)
  @RequirePermissions('cases.reply')
  async reply(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Req() req: RequestWithClaims,
  ): Promise<{
    message: Record<string, unknown>;
    idempotent_replayed: boolean;
  }> {
    const input = parseReplyBody(body);
    const result = await this.cases.reply(tenantOf(req), parseUuid(id, 'id'), actorOf(req), {
      body: input.body,
      idempotencyKey: parseIdempotencyKey(idempotencyKey),
    });
    return {
      message: toApiMessage(result.message),
      idempotent_replayed: result.idempotentReplayed,
    };
  }

  /** 201 when a handoff was requested; an already-active one returns it
   *  with `created: false` (idempotent by behaviour, like resolve). */
  @Post(':id/handoff')
  @HttpCode(201)
  @RequirePermissions('cases.reply')
  async handoff(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: RequestWithClaims,
  ): Promise<{
    handoff: Record<string, unknown>;
    created: boolean;
  }> {
    const input = parseHandoffBody(body);
    const result = await this.cases.requestHandoff(
      tenantOf(req),
      parseUuid(id, 'id'),
      actorOf(req),
      {
        reason: input.reason,
        summary: input.summary,
        destinationQueueId: input.destination_queue_id,
      },
    );
    return { handoff: toApiHandoff(result.handoff), created: result.created };
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermissions('cases.reply')
  async resolve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: RequestWithClaims,
  ): Promise<{ case: Record<string, unknown>; changed: boolean }> {
    const input = parseResolveBody(body);
    const result = await this.cases.resolve(
      tenantOf(req),
      parseUuid(id, 'id'),
      actorOf(req),
      input.resolution_code,
    );
    return { case: toApiCase(result.case), changed: result.changed };
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermissions('cases.reply')
  async reopen(
    @Param('id') id: string,
    @Req() req: RequestWithClaims,
  ): Promise<{ case: Record<string, unknown>; changed: boolean }> {
    const result = await this.cases.reopen(
      tenantOf(req),
      parseUuid(id, 'id'),
      actorOf(req),
    );
    return { case: toApiCase(result.case), changed: result.changed };
  }
}
