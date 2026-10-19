import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppException } from '../common/errors';
import { RequireRoles } from '../rbac/roles.decorator';
import { RolesGuard } from '../rbac/roles.guard';
import {
  AuditService,
  type AuditEventRow,
  type AuditListQuery,
  type AuditOutcome,
} from './audit.service';

/**
 * GET /v1/audit-events — audit trail (API_CONTRACTS: admin only,
 * tenant-scoped, filtered, keyset cursor). RolesGuard re-resolves the
 * membership from the DB on every call (revocation is immediate); owner/admin
 * are the roles holding the `audit.view` permission key (rbac/permissions.ts).
 * Export (audited) lands with the reporting slice — list-only for now.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const OUTCOMES: AuditOutcome[] = ['success', 'failure', 'denied'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface RequestWithClaims extends FastifyRequest {
  user?: { sub?: string; tid?: string };
}

function invalid(message: string): AppException {
  return new AppException('validation_failed', message);
}

function optionalFilter(
  query: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = query[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid(`${key} must be a string`);
  return value;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw invalid('limit must be an integer between 1 and 100');
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw invalid('limit must be an integer between 1 and 100');
  }
  return limit;
}

function parseDateFilter(query: Record<string, unknown>, key: string): Date | undefined {
  const raw = optionalFilter(query, key);
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw invalid(`${key} must be an ISO-8601 date`);
  return new Date(parsed);
}

function parseCursor(raw: string | undefined):
  | { occurredAt: Date; id: string }
  | undefined {
  if (raw === undefined || raw === '') return undefined;
  const match = CURSOR_RE.exec(raw);
  if (!match) {
    throw invalid('cursor is not a valid pagination cursor');
  }
  const occurredAt = Date.parse(match[1]!);
  if (Number.isNaN(occurredAt)) {
    throw invalid('cursor is not a valid pagination cursor');
  }
  return { occurredAt: new Date(occurredAt), id: match[2]! };
}

function toApiEvent(row: AuditEventRow) {
  return {
    id: row.id,
    action: row.action,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    target_type: row.target_type,
    target_id: row.target_id,
    outcome: row.outcome,
    correlation_id: row.correlation_id,
    metadata: row.metadata,
    occurred_at: row.occurred_at.toISOString(),
  };
}

@UseGuards(RolesGuard)
@RequireRoles('owner', 'admin')
@Controller('v1/audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Req() req: RequestWithClaims,
  ) {
    const tenantId = req.user?.tid;
    if (!tenantId) {
      // no active tenant in the JWT (user without memberships) — nothing to scope
      throw new AppException('permission_denied', 'No active tenant');
    }

    const actorId = optionalFilter(query, 'actor_id');
    if (actorId !== undefined && !UUID_RE.test(actorId)) {
      throw invalid('actor_id must be a UUID');
    }

    const outcome = optionalFilter(query, 'outcome');
    if (outcome !== undefined && !OUTCOMES.includes(outcome as AuditOutcome)) {
      throw invalid('outcome must be one of: success, failure, denied');
    }

    const listQuery: AuditListQuery = {
      limit: parseLimit(query.limit),
      action: optionalFilter(query, 'action'),
      actorId,
      outcome: outcome as AuditOutcome | undefined,
      targetType: optionalFilter(query, 'target_type'),
      targetId: optionalFilter(query, 'target_id'),
      from: parseDateFilter(query, 'from'),
      to: parseDateFilter(query, 'to'),
      cursor: parseCursor(optionalFilter(query, 'cursor')),
    };

    const page = await this.audit.list(tenantId, listQuery);
    return {
      events: page.events.map(toApiEvent),
      next_cursor: page.nextCursor,
    };
  }
}
