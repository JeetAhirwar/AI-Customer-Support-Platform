import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { AppModule } from '../app.module';
import { resetConfigCache } from '../config/env';
import { withTenant } from '../db/tenant-scope';
import { hashPassword } from '../auth/password';
import { TenancyService } from '../tenancy/tenancy.service';

/**
 * P3 increment 1 — cases read + lifecycle, over the REAL app on injected HTTP
 * (same harness as cross-tenant.integration.spec.ts). Gates A + B:
 *
 *  Gate A (authz): permission-key default-deny (viewer reads, cannot write),
 *    cross-tenant 404s indistinguishable from unknown ids, 401 without a token
 *  Gate B (data): keyset pagination walks every row exactly once, filters are
 *    schema-validated, lifecycle writes land atomically — business row +
 *    case_event + outbox event + audit row together — and a repeated resolve
 *    is a no-op instead of a duplicate transition
 *
 * Also asserts the SECURITY.md §8 detail that is easy to regress: audit
 * metadata records THAT a note was added, never what it says.
 *
 * Needs a migrated TEST_DATABASE_URL (see auth.integration.spec.ts header);
 * in CI the anti-skip gate fails the job if this suite ever stops running.
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

const PASSWORD = 'CasesApi!Pass123';
const NOTE_BODY = 'Top secret internal note 9f3a';

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
}

interface Envelope {
  error: { code: string; message: string; correlation_id: string };
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
}

interface CasePayload {
  id: string;
  status: string;
  priority: string;
  channel: string | null;
  customer_name: string | null;
  queue_name: string | null;
  assignee_email: string | null;
  resolution_code: string | null;
  resolved_at: string | null;
  reopened_at: string | null;
  updated_at: string;
  sla_due_at: string | null;
}

interface ListPayload {
  cases: CasePayload[];
  next_cursor: string | null;
}

interface DetailPayload {
  case: CasePayload;
  timeline: { id: string; event_type: string; metadata: Record<string, unknown> }[];
  next_cursor: string | null;
}

d('P3 cases API (real app, HTTP)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  let tenantA: string;
  let tenantB: string;
  const usersA: Record<'owner' | 'admin' | 'agent' | 'viewer', string> =
    {} as never;
  const tokens: Record<'owner' | 'admin' | 'agent' | 'viewer', string> =
    {} as never;
  let tokenB: string;

  // tenant A fixtures — five cases so pagination has real pages to walk
  const ids = {
    overdue: randomUUID(),
    resolvedSeed: randomUUID(),
    plain: randomUUID(),
    notes: randomUUID(),
    lifecycle: randomUUID(),
    foreign: randomUUID(), // tenant B's case, seen through tenant B's eyes
  };

  /** Fastify's inject typing demands the full InjectOptions shape; see
   * cross-tenant.integration.spec.ts for why this adapter exists. */
  const inject = async (req: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<InjectResponse> => {
    const instance = app.getHttpAdapter().getInstance() as unknown as {
      inject: (opts: Record<string, unknown>) => Promise<InjectResponse>;
    };
    return instance.inject({
      method: req.method ?? 'GET',
      url: req.url,
      ...(req.headers !== undefined ? { headers: req.headers } : {}),
      ...(req.payload !== undefined ? { payload: req.payload } : {}),
    });
  };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const createUser = async (email: string, hash: string): Promise<string> => {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
      [email],
    );
    const id = u.rows[0]!.id;
    await pool.query(
      `INSERT INTO credentials (user_id, password_hash, algorithm)
       VALUES ($1, $2, 'argon2id')`,
      [id, hash],
    );
    return id;
  };

  const addMembership = async (
    userId: string,
    tenantId: string,
    role: string,
  ): Promise<void> => {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`,
      [tenantId, role],
    );
    await withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [tenantId, userId, r.rows[0]!.id],
      ),
    );
  };

  const login = async (email: string): Promise<string> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json<LoginResult>().accessToken;
  };

  /** Business fixtures are tenant-scoped rows → written inside withTenant (RLS). */
  const seedFixtures = async (stamp: number): Promise<void> => {
    await withTenant(tenantA, async (c) => {
      const customer = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, display_name, email)
         VALUES ($1, 'Ada Lovelace', $2) RETURNING id`,
        [tenantA, `cases-a-${stamp}@customer.test`],
      );
      const queue = await c.query<{ id: string }>(
        `INSERT INTO queues (tenant_id, name) VALUES ($1, $2) RETURNING id`,
        [tenantA, `General ${stamp}`],
      );
      const conversation = await c.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, channel, customer_id, status)
         VALUES ($1, 'chat', $2, 'open') RETURNING id`,
        [tenantA, customer.rows[0]!.id],
      );
      const customerId = customer.rows[0]!.id;
      const queueId = queue.rows[0]!.id;
      const conversationId = conversation.rows[0]!.id;

      const insertCase = (
        id: string,
        values: {
          status: string;
          priority: string;
          queueId?: string | null;
          assigneeId?: string | null;
          slaDueAt?: string | null;
          conversationId?: string | null;
          resolutionCode?: string | null;
          resolvedAt?: string | null;
        },
      ): Promise<unknown> =>
        c.query(
          `INSERT INTO cases
             (id, tenant_id, customer_id, conversation_id, status, priority,
              queue_id, assignee_id, sla_due_at, resolution_code, resolved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            tenantA,
            customerId,
            values.conversationId ?? null,
            values.status,
            values.priority,
            values.queueId ?? null,
            values.assigneeId ?? null,
            values.slaDueAt ?? null,
            values.resolutionCode ?? null,
            values.resolvedAt ?? null,
          ],
        );

      await insertCase(ids.overdue, {
        status: 'open',
        priority: 'high',
        queueId,
        assigneeId: usersA.agent,
        slaDueAt: new Date(Date.now() - 3_600_000).toISOString(),
        conversationId,
      });
      await insertCase(ids.resolvedSeed, {
        status: 'resolved',
        priority: 'normal',
        resolutionCode: 'fixed',
        resolvedAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      await insertCase(ids.plain, { status: 'open', priority: 'low' });
      await insertCase(ids.notes, { status: 'open', priority: 'normal' });
      await insertCase(ids.lifecycle, {
        status: 'open',
        priority: 'urgent',
        conversationId,
      });

      // timeline fixture for keyset paging (distinct, explicit occurred_at)
      for (const [index, minutes] of [3, 2, 1].entries()) {
        await c.query(
          `INSERT INTO case_events
             (tenant_id, case_id, event_type, actor_type, metadata, occurred_at)
           VALUES ($1, $2, $3, 'system', '{}'::jsonb, now() - make_interval(mins => $4::int))`,
          [tenantA, ids.plain, `fixture.event.${index}`, minutes],
        );
      }
    });

    await withTenant(tenantB, async (c) => {
      const customer = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, display_name, email)
         VALUES ($1, 'Bob', $2) RETURNING id`,
        [tenantB, `cases-b-${stamp}@customer.test`],
      );
      await c.query(
        `INSERT INTO cases (id, tenant_id, customer_id, status, priority)
         VALUES ($1, $2, $3, 'open', 'normal')`,
        [ids.foreign, tenantB, customer.rows[0]!.id],
      );
    });
  };

  /**
   * Which lifecycle events reached the outbox. Ordered by created_at: the id
   * is gen_random_uuid() — random, not monotonic — so ordering by it would
   * shuffle events written in different transactions.
   */
  const outboxTypes = async (tenantId: string): Promise<string[]> => {
    const res = await withTenant(tenantId, (c) =>
      c.query<{ type: string }>(
        `SELECT type FROM outbox_events
          WHERE tenant_id = $1 AND type IN ('case.resolved', 'case.reopened')
          ORDER BY created_at`,
        [tenantId],
      ),
    );
    return res.rows.map((row) => row.type);
  };

  const auditRows = async (
    tenantId: string,
    action: string,
  ): Promise<{ action: string; metadata: Record<string, unknown> }[]> => {
    const res = await withTenant(tenantId, (c) =>
      c.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action, metadata FROM audit_events
          WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
        [tenantId, action],
      ),
    );
    return res.rows;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl!;
    resetConfigCache();
    const { getPool } = await import('../db/pool');
    pool = getPool();

    const migrated = await pool.query<{ r: string | null }>(
      `SELECT to_regclass('public.cases') AS r`,
    );
    if (!migrated.rows[0]?.r) {
      throw new Error(
        'Test DB not migrated — run db:migrate with $env:MIGRATIONS_DATABASE_URL ' +
          '(owner role) pointing at the test DB, see LOCAL_DEVELOPMENT_SETUP.md',
      );
    }

    const stamp = Date.now();
    const mkTenant = async (name: string): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO tenants (name, plan, status) VALUES ($1, 'trial', 'active') RETURNING id`,
          [name],
        )
      ).rows[0]!.id;

    tenantA = await mkTenant(`Cases Alpha ${stamp}`);
    tenantB = await mkTenant(`Cases Beta ${stamp}`);

    const tenancy = new TenancyService();
    await tenancy.ensureDefaultRoles(tenantA);
    await tenancy.ensureDefaultRoles(tenantB);

    const hash = await hashPassword(PASSWORD);
    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      const email = `casesapi-a-${role}-${stamp}@example.test`;
      usersA[role] = await createUser(email, hash);
      await addMembership(usersA[role], tenantA, role);
    }
    const emailB = `casesapi-b-admin-${stamp}@example.test`;
    const userB = await createUser(emailB, hash);
    await addMembership(userB, tenantB, 'admin');

    await seedFixtures(stamp);

    // REAL app boot — same wiring as main.ts (filter + middleware + interceptor)
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      tokens[role] = await login(`casesapi-a-${role}-${stamp}@example.test`);
    }
    tokenB = await login(emailB);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool && tenantA) {
      await pool.query(
        `DELETE FROM users WHERE email LIKE 'casesapi-%@example.test'`,
      );
      await pool.query(`DELETE FROM tenants WHERE id = $1 OR id = $2`, [
        tenantA,
        tenantB,
      ]);
    }
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('default-deny: 401 without a token (Gate A)', async () => {
    const res = await inject({ url: '/v1/cases' });
    expect(res.statusCode).toBe(401);
    expect(res.json<Envelope>().error.code).toBe('unauthorized');

    const detail = await inject({ url: `/v1/cases/${ids.overdue}` });
    expect(detail.statusCode).toBe(401);
  });

  it('lists only the caller tenant, with display joins and no tenant_id leak', async () => {
    const res = await inject({ url: '/v1/cases', headers: auth(tokens.viewer) });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListPayload>();
    expect(body.cases).toHaveLength(5);
    expect(body.next_cursor).toBeNull();
    expect(body.cases.some((c) => c.id === ids.foreign)).toBe(false);
    expect(body.cases.some((c) => 'tenant_id' in (c as object))).toBe(false);

    const overdue = body.cases.find((c) => c.id === ids.overdue);
    expect(overdue?.customer_name).toBe('Ada Lovelace');
    expect(overdue?.queue_name).toMatch(/^General /);
    expect(overdue?.channel).toBe('chat');
    expect(overdue?.assignee_email).toContain('@example.test');

    // no conversation/queue → the LEFT JOINs degrade to null, never a drop
    const plain = body.cases.find((c) => c.id === ids.plain);
    expect(plain?.channel).toBeNull();
    expect(plain?.queue_name).toBeNull();
  });

  it('paginates by keyset: every row exactly once across pages (Gate B)', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/v1/cases?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await inject({ url, headers: auth(tokens.agent) });
      expect(res.statusCode).toBe(200);
      const body = res.json<ListPayload>();
      seen.push(...body.cases.map((c) => c.id));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3); // 5 cases at limit 2 = 2 + 2 + 1
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(
      [ids.overdue, ids.resolvedSeed, ids.plain, ids.notes, ids.lifecycle].sort(),
    );
  });

  it('filters by status, SLA and priority — invalid values rejected (Gate B)', async () => {
    const resolved = await inject({
      url: '/v1/cases?status=resolved',
      headers: auth(tokens.agent),
    });
    expect(resolved.statusCode).toBe(200);
    const resolvedBody = resolved.json<ListPayload>();
    expect(resolvedBody.cases.map((c) => c.id)).toEqual([ids.resolvedSeed]);

    const overdue = await inject({
      url: '/v1/cases?sla=overdue',
      headers: auth(tokens.agent),
    });
    expect(overdue.statusCode).toBe(200);
    expect(overdue.json<ListPayload>().cases.map((c) => c.id)).toEqual([
      ids.overdue,
    ]);

    const combined = await inject({
      url: '/v1/cases?status=open&priority=urgent',
      headers: auth(tokens.agent),
    });
    expect(combined.statusCode).toBe(200);
    expect(combined.json<ListPayload>().cases.map((c) => c.id)).toEqual([
      ids.lifecycle,
    ]);

    for (const url of [
      '/v1/cases?status=closedd',
      '/v1/cases?priority=critical',
      '/v1/cases?channel=sms',
      '/v1/cases?sla=soon',
      '/v1/cases?limit=0',
      '/v1/cases?limit=101',
      '/v1/cases?cursor=nope',
      '/v1/cases?assignee_id=not-a-uuid',
    ]) {
      const res = await inject({ url, headers: auth(tokens.agent) });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<Envelope>().error.code).toBe('validation_failed');
    }
  });

  it('returns detail + timeline, paging the timeline by keyset (Gate B)', async () => {
    const first = await inject({
      url: `/v1/cases/${ids.plain}?limit=2`,
      headers: auth(tokens.viewer),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<DetailPayload>();
    expect(firstBody.case.id).toBe(ids.plain);
    expect(firstBody.timeline).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await inject({
      url: `/v1/cases/${ids.plain}?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      headers: auth(tokens.viewer),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<DetailPayload>();
    expect(secondBody.timeline).toHaveLength(1);
    expect(secondBody.next_cursor).toBeNull();

    const seen = [...firstBody.timeline, ...secondBody.timeline].map((e) => e.id);
    expect(new Set(seen).size).toBe(3);
    expect(firstBody.timeline[0]!.event_type).toBe('fixture.event.2');
  });

  it('404 for an unknown id and for a foreign-tenant id — indistinguishable (Gate A)', async () => {
    const unknown = await inject({
      url: `/v1/cases/${randomUUID()}`,
      headers: auth(tokens.viewer),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<Envelope>().error.code).toBe('not_found');

    // tenant A's viewer probing tenant B's case through the same route
    const foreign = await inject({
      url: `/v1/cases/${ids.foreign}`,
      headers: auth(tokens.viewer),
    });
    expect(foreign.statusCode).toBe(404);
    const unknownError = unknown.json<Envelope>().error;
    const foreignError = foreign.json<Envelope>().error;
    // identical envelope: only correlation_id (per request) may differ
    expect({ code: foreignError.code, message: foreignError.message }).toEqual({
      code: unknownError.code,
      message: unknownError.message,
    });

    // tenant B sees its own case and only its own case
    const mine = await inject({ url: '/v1/cases', headers: auth(tokenB) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json<ListPayload>().cases.map((c) => c.id)).toEqual([
      ids.foreign,
    ]);
  });

  it('viewer can read but cannot write (permission default-deny, Gate A)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.lifecycle}/notes`,
      headers: auth(tokens.viewer),
      payload: { body: 'viewer should not be able to write this' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Envelope>().error.code).toBe('permission_denied');
    expect(res.json<Envelope>().error.message).toContain('cases.reply');

    const detail = await inject({
      url: `/v1/cases/${ids.lifecycle}`,
      headers: auth(tokens.viewer),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<DetailPayload>().timeline).toHaveLength(0);
  });

  it('agent adds an internal note — timeline updated, audit carries no body (Gate B)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.notes}/notes`,
      headers: auth(tokens.agent),
      payload: { body: NOTE_BODY },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ note: { event_type: string; metadata: Record<string, unknown> } }>();
    expect(created.note.event_type).toBe('note');
    expect(created.note.metadata).toEqual({
      body: NOTE_BODY,
      visibility: 'internal',
    });

    const detail = await inject({
      url: `/v1/cases/${ids.notes}`,
      headers: auth(tokens.agent),
    });
    const timeline = detail.json<DetailPayload>().timeline;
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.metadata.body).toBe(NOTE_BODY);

    // SECURITY §8: the trail records THAT a note was added, not what it says
    const audit = await auditRows(tenantA, 'case.note.added');
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.map((row) => row.metadata))).not.toContain(
      NOTE_BODY,
    );
    for (const row of audit) {
      expect(row.metadata).toEqual({ event_type: 'note', visibility: 'internal' });
    }
  });

  it('rejects malformed note bodies and unknown fields', async () => {
    for (const payload of [
      { body: '' },
      { body: 42 },
      { body: NOTE_BODY, extra: true },
      ['body'],
    ]) {
      const res = await inject({
        method: 'POST',
        url: `/v1/cases/${ids.notes}/notes`,
        headers: auth(tokens.agent),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json<Envelope>().error.code).toBe('validation_failed');
    }

    const missing = await inject({
      method: 'POST',
      url: `/v1/cases/${randomUUID()}/notes`,
      headers: auth(tokens.agent),
      payload: { body: NOTE_BODY },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('agent resolves a case: row + event + outbox + audit commit together (Gate B)', async () => {
    expect(await outboxTypes(tenantA)).toEqual([]);

    const res = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.lifecycle}/resolve`,
      headers: auth(tokens.agent),
      payload: { resolution_code: 'fixed.by.agent' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ case: CasePayload; changed: boolean }>();
    expect(body.changed).toBe(true);
    expect(body.case.status).toBe('resolved');
    expect(body.case.resolution_code).toBe('fixed.by.agent');
    expect(body.case.resolved_at).not.toBeNull();

    const detail = await inject({
      url: `/v1/cases/${ids.lifecycle}`,
      headers: auth(tokens.agent),
    });
    const events = detail.json<DetailPayload>().timeline;
    const resolved = events.find((e) => e.event_type === 'case.resolved');
    expect(resolved).toBeDefined();
    expect(resolved!.metadata.previous_status).toBe('open');

    expect(await outboxTypes(tenantA)).toEqual(['case.resolved']);
    const audit = await auditRows(tenantA, 'case.resolved');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({
      previous_status: 'open',
      resolution_code: 'fixed.by.agent',
    });
  });

  it('a repeated resolve is a no-op, not a duplicate transition (Gate B)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.lifecycle}/resolve`,
      headers: auth(tokens.agent),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ changed: boolean }>().changed).toBe(false);

    expect(await outboxTypes(tenantA)).toEqual(['case.resolved']);
    expect(await auditRows(tenantA, 'case.resolved')).toHaveLength(1);
    const events = await inject({
      url: `/v1/cases/${ids.lifecycle}`,
      headers: auth(tokens.agent),
    });
    const timeline = events.json<DetailPayload>().timeline;
    expect(timeline.filter((e) => e.event_type === 'case.resolved')).toHaveLength(1);
  });

  it('agent reopens a resolved case; reopening twice is a no-op (Gate B)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.lifecycle}/reopen`,
      headers: auth(tokens.agent),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ case: CasePayload; changed: boolean }>();
    expect(body.changed).toBe(true);
    expect(body.case.status).toBe('reopened');
    expect(body.case.reopened_at).not.toBeNull();

    const again = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.lifecycle}/reopen`,
      headers: auth(tokens.agent),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ changed: boolean }>().changed).toBe(false);

    // exactly these two events — compared as a set; order is not the contract
    expect((await outboxTypes(tenantA)).sort()).toEqual(
      ['case.resolved', 'case.reopened'].sort(),
    );
    expect(await auditRows(tenantA, 'case.reopened')).toHaveLength(1);
  });

  it('lifecycle transitions across tenants are 404, never a mutation (Gate A)', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.overdue}/resolve`,
      headers: auth(tokenB), // tenant B admin, real permission in ITS tenant
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<Envelope>().error.code).toBe('not_found');

    const untouched = await inject({
      url: `/v1/cases/${ids.overdue}`,
      headers: auth(tokens.agent),
    });
    expect(untouched.json<DetailPayload>().case.status).toBe('open');

    // ...and an admin of the right tenant may resolve it
    const ok = await inject({
      method: 'POST',
      url: `/v1/cases/${ids.overdue}/resolve`,
      headers: auth(tokens.admin),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ changed: boolean }>().changed).toBe(true);
  });
});
