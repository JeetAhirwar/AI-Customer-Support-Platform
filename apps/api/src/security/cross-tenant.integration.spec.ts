import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from '../app.module';
import { resetConfigCache } from '../config/env';
import { withTenant } from '../db/tenant-scope';
import { hashPassword } from '../auth/password';
import { signAccessToken } from '../auth/tokens';
import { TenancyService } from '../tenancy/tenancy.service';

/**
 * QA-005 cross-tenant negative suite (TESTING_STRATEGY Gates A + B) — the P2
 * release gate. Drives the REAL app over injected HTTP as two independent
 * tenants and proves the isolation contract end to end:
 *
 *  1. default-deny without a token
 *  2. workspace picker scoped to the caller
 *  3. audit trail never crosses tenants, including a direct actor_id probe
 *  4. a FORGED `tid` claim (correct signature, wrong tenant) is not authorization
 *  5. a FORGED `role` claim cannot escalate past what the DB says
 *  6. the role matrix on an admin-only route
 *  7. revocation takes effect on the next request (no token caching)
 *  8. a cross-tenant switch is indistinguishable from an unknown tenant
 *
 * The DB-level half (RLS over every tenant-scoped table) lives in
 * `src/db/rls.integration.spec.ts`; this file covers the HTTP/guard half.
 * Needs a migrated TEST_DATABASE_URL (see auth.integration.spec.ts header).
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

const PASSWORD = 'CrossTenant!Pass123';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

d('QA-005 cross-tenant negatives (real app, HTTP)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  let tenantA: string;
  let tenantB: string;
  const usersA: Record<'owner' | 'admin' | 'agent' | 'viewer', string> = {} as never;
  let userB: string;
  let emailB: string;

  const tokens = {} as Record<'owner' | 'admin' | 'agent' | 'viewer', string>;
  let refreshB: string;

  /**
   * Fastify's `inject` typing demands the full InjectOptions shape (10+
   * required fields); these suites only ever pass method/url/headers/payload,
   * so adapt to the minimal contract the tests actually use.
   */
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
    // tenant_memberships is RLS-protected (004): writes need the tenant scope
    await withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [tenantId, userId, r.rows[0]!.id],
      ),
    );
  };

  const login = async (email: string): Promise<LoginResult> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return res.json<LoginResult>();
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    resetConfigCache();
    const { getPool } = await import('../db/pool');
    pool = getPool();

    const migrated = await pool.query<{ r: string | null }>(
      `SELECT to_regclass('public.tenant_memberships') AS r`,
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

    tenantA = await mkTenant(`QA005 Alpha ${stamp}`);
    tenantB = await mkTenant(`QA005 Beta ${stamp}`);

    // roles/permission seeds drive the matrix assertions below
    const tenancy = new TenancyService();
    await tenancy.ensureDefaultRoles(tenantA);
    await tenancy.ensureDefaultRoles(tenantB);

    const hash = await hashPassword(PASSWORD);
    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      const email = `qa005-a-${role}-${stamp}@example.test`;
      usersA[role] = await createUser(email, hash);
      await addMembership(usersA[role], tenantA, role);
    }
    userB = await createUser(`qa005-b-admin-${stamp}@example.test`, hash);
    emailB = `qa005-b-admin-${stamp}@example.test`;
    await addMembership(userB, tenantB, 'admin');

    // REAL app boot — same wiring as main.ts (filter + middleware + interceptor)
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // logins double as tenant-B audit fixtures (auth.login is audited)
    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      const result = await login(`qa005-a-${role}-${stamp}@example.test`);
      tokens[role] = result.accessToken;
    }
    refreshB = (await login(emailB)).refreshToken;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool && tenantA) {
      // users go first (credentials FK), then tenants cascade into
      // memberships, sessions and audit rows
      await pool.query(
        `DELETE FROM users WHERE email LIKE 'qa005-%@example.test'`,
      );
      await pool.query(`DELETE FROM tenants WHERE id = $1 OR id = $2`, [
        tenantA,
        tenantB,
      ]);
    }
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('default-deny: tenant-scoped routes 401 without a token (Gate A)', async () => {
    const audit = await inject({ url: '/v1/audit-events' });
    expect(audit.statusCode).toBe(401);
    expect(audit.json<Envelope>().error.code).toBe('unauthorized');

    const mine = await inject({ url: '/v1/tenants/mine' });
    expect(mine.statusCode).toBe(401);
    expect(mine.json<Envelope>().error.code).toBe('unauthorized');
  });

  it('workspace picker returns only the caller memberships (Gate A)', async () => {
    const res = await inject({
      url: '/v1/tenants/mine',
      headers: auth(tokens.owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ memberships: { tenant_id: string; role: string }[] }>();
    expect(body.memberships.length).toBeGreaterThan(0);
    expect(body.memberships.every((m) => m.tenant_id === tenantA)).toBe(true);
    expect(body.memberships.some((m) => m.tenant_id === tenantB)).toBe(false);
  });

  it('audit trail never crosses tenants, even with a direct actor probe (Gate A/B)', async () => {
    const list = await inject({
      url: '/v1/audit-events?limit=100',
      headers: auth(tokens.owner),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      events: { actor_id: string | null; tenant_id?: string }[];
    }>();
    // tenant A has 4 audited logins; tenant B's admin login must not appear
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.some((e) => e.actor_id === userB)).toBe(false);
    // tenant_id is never serialized to clients at all
    expect(body.events.some((e) => 'tenant_id' in e)).toBe(false);

    // deliberately probe for the foreign actor: same route, empty result
    const probe = await inject({
      url: `/v1/audit-events?actor_id=${userB}&limit=100`,
      headers: auth(tokens.owner),
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json<{ events: unknown[] }>().events).toHaveLength(0);
  });

  it('a forged tid claim is not authorization (valid signature, foreign tenant)', async () => {
    // correct secret, correct user — only the tenant claim is a lie
    const forged = signAccessToken({
      sub: usersA.owner,
      email: 'qa005-a-owner@example.test',
      tid: tenantB,
      role: 'owner',
    });
    const res = await inject({
      url: '/v1/audit-events',
      headers: auth(forged),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Envelope>().error.code).toBe('permission_denied');
  });

  it('a forged role claim cannot escalate past the DB role', async () => {
    // viewer token claiming to be owner — RolesGuard re-reads membership
    const forged = signAccessToken({
      sub: usersA.viewer,
      email: 'qa005-a-viewer@example.test',
      tid: tenantA,
      role: 'owner',
    });
    const forgedRes = await inject({
      url: '/v1/audit-events',
      headers: auth(forged),
    });
    expect(forgedRes.statusCode).toBe(403);
    expect(forgedRes.json<Envelope>().error.code).toBe('permission_denied');

    // the honest viewer token is denied the same way — claim and DB agree
    const honest = await inject({
      url: '/v1/audit-events',
      headers: auth(tokens.viewer),
    });
    expect(honest.statusCode).toBe(403);
    expect(honest.json<Envelope>().error.code).toBe(
      forgedRes.json<Envelope>().error.code,
    );
  });

  it('role matrix: only owner/admin reach the audit trail (Gate A)', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const res = await inject({
        url: '/v1/audit-events?limit=1',
        headers: auth(tokens[role]),
      });
      expect(res.statusCode, `${role} should read the audit trail`).toBe(200);
    }
    for (const role of ['agent', 'viewer'] as const) {
      const res = await inject({
        url: '/v1/audit-events?limit=1',
        headers: auth(tokens[role]),
      });
      expect(res.statusCode, `${role} must be denied`).toBe(403);
      expect(res.json<Envelope>().error.code).toBe('permission_denied');
    }
  });

  it('revocation takes effect on the next request (SECURITY, no token caching)', async () => {
    expect(
      (await inject({ url: '/v1/audit-events?limit=1', headers: auth(tokens.admin) }))
        .statusCode,
    ).toBe(200);

    await withTenant(tenantA, (c) =>
      c.query(
        `UPDATE tenant_memberships SET status = 'disabled'
          WHERE user_id = $1 AND tenant_id = $2`,
        [usersA.admin, tenantA],
      ),
    );
    try {
      const denied = await inject({
        url: '/v1/audit-events?limit=1',
        headers: auth(tokens.admin),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json<Envelope>().error.code).toBe('permission_denied');
    } finally {
      await withTenant(tenantA, (c) =>
        c.query(
          `UPDATE tenant_memberships SET status = 'active'
            WHERE user_id = $1 AND tenant_id = $2`,
          [usersA.admin, tenantA],
        ),
      );
    }
  });

  it('cross-tenant switch is indistinguishable from an unknown tenant (no existence leak)', async () => {
    // refresh tokens are single-use (rotation) — each probe needs its own
    const foreign = await inject({
      method: 'POST',
      url: '/v1/auth/switch-tenant',
      payload: { refreshToken: refreshB, tenant_id: tenantA },
    });
    expect(foreign.statusCode).toBe(403);

    const secondSession = await login(emailB);
    const unknown = await inject({
      method: 'POST',
      url: '/v1/auth/switch-tenant',
      payload: { refreshToken: secondSession.refreshToken, tenant_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknown.statusCode).toBe(403);

    // identical code AND message: probing cannot reveal that tenantA exists
    const a = foreign.json<Envelope>().error;
    const b = unknown.json<Envelope>().error;
    expect(a.code).toBe('permission_denied');
    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);

    // the denied switch granted nothing: B still sees only B
    const bOwn = await inject({
      url: '/v1/tenants/mine',
      headers: auth(secondSession.accessToken),
    });
    expect(bOwn.statusCode).toBe(200);
    const bMemberships = bOwn.json<{ memberships: { tenant_id: string }[] }>()
      .memberships;
    expect(bMemberships.length).toBeGreaterThan(0);
    expect(bMemberships.every((m) => m.tenant_id === tenantB)).toBe(true);
  });

  it('sanity: fixture tenants are distinct uuids', () => {
    expect(tenantA).toMatch(UUID);
    expect(tenantB).toMatch(UUID);
    expect(tenantA).not.toBe(tenantB);
  });
});
