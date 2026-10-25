import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { AppModule } from '../app.module';
import { resetConfigCache } from '../config/env';
import { withTenant } from '../db/tenant-scope';
import { hashPassword } from '../auth/password';

/**
 * Observability integration (TESTING_STRATEGY Gate B, ADR-008 execution
 * note) — boots the REAL AppModule (middleware + APP_FILTER + APP_INTERCEPTOR)
 * and drives it over injected HTTP as the app role:
 *  - X-Correlation-ID: accepted / echoed / sanitized (no CRLF injection)
 *  - error envelope correlation_id === response header id (one thread)
 *  - audit rows carry the request's correlation id (login flow)
 *  - GET /metrics Prometheus text + http counters, scraper not counted
 * Needs a migrated test database (see auth.integration.spec.ts header).
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

const SAFE = /^[A-Za-z0-9._:\-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = unknown>(): T;
}

d('observability integration (correlation + metrics, real app boot)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let tenantId: string;
  let userId: string;
  let email: string;
  const password = 'Observability!Pass123';

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

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    resetConfigCache();
    const { getPool } = await import('../db/pool');
    pool = getPool();

    const migrated = await pool.query<{ r: string | null }>(
      `SELECT to_regclass('public.audit_events') AS r`,
    );
    if (!migrated.rows[0]?.r) {
      throw new Error(
        'Test DB not migrated — run db:migrate with $env:MIGRATIONS_DATABASE_URL ' +
          '(owner role) pointing at the test DB, see LOCAL_DEVELOPMENT_SETUP.md',
      );
    }

    // fixtures: tenant + user + creds + owner membership (login audited)
    const stamp = Date.now();
    email = `obs-${stamp}@example.test`;
    tenantId = (
      await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, plan, status)
         VALUES ($1, 'trial', 'active') RETURNING id`,
        [`Obs Tenant ${stamp}`],
      )
    ).rows[0]!.id;
    userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
        [email],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO credentials (user_id, password_hash, algorithm)
       VALUES ($1, $2, 'argon2id')`,
      [userId, await hashPassword(password)],
    );
    const roleId = (
      await pool.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, name) VALUES ($1, 'owner') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    // memberships are RLS-scoped (004): insert inside the tenant scope
    await withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [tenantId, userId, roleId],
      ),
    );

    // REAL app boot — same wiring as main.ts (filter/middleware/interceptor
    // now all live in AppModule; only pino/ports differ from prod)
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      // abortOnError:false — a boot failure must surface as an exception in
      // tests instead of process.exit(1) killing the vitest worker silently
      { logger: false, abortOnError: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool && userId) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('echoes a minted uuid X-Correlation-ID when the caller sends none', async () => {
    const res = await inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-correlation-id'])).toMatch(UUID);
  });

  it('accepts and echoes a caller-supplied id', async () => {
    const res = await inject({
      url: '/health',
      headers: { 'x-correlation-id': 'obs-trace-99' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('obs-trace-99');
  });

  it('sanitizes hostile ids (no CRLF ever reaches the response)', async () => {
    const res = await inject({
      url: '/health',
      headers: { 'x-correlation-id': 'evil\r\nX-Injected: pwn' },
    });
    const value = String(res.headers['x-correlation-id']);
    expect(value).toMatch(UUID);
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).not.toContain('pwn');
  });

  it('error envelope correlation_id === response header (one thread)', async () => {
    const res = await inject({
      url: '/v1/audit-events?limit=1',
      headers: { 'x-correlation-id': 'obs-401-id' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { correlation_id: string } }>();
    expect(body.error.correlation_id).toBe('obs-401-id');
    expect(res.headers['x-correlation-id']).toBe('obs-401-id');
  });

  it('audit rows carry the request correlation id end-to-end', async () => {
    const trace = `obs-login-${Date.now()}`;
    const login = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-correlation-id': trace },
      payload: { email, password },
    });
    expect(login.statusCode).toBeLessThan(300);
    const token = login.json<{ accessToken: string }>().accessToken;
    expect(token).toBeTruthy();

    const list = await inject({
      url: '/v1/audit-events?limit=20',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      events: { action: string; correlation_id: string | null }[];
    }>();
    const loginEvent = body.events.find((e) => e.action === 'auth.login');
    expect(loginEvent).toBeDefined();
    expect(loginEvent!.correlation_id).toBe(trace);
  });

  it('exposes Prometheus text at /metrics with http + process baselines', async () => {
    const res = await inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.body).toContain('http_requests_total');
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toMatch(/process_[a-z_]+|nodejs_/);
    // /health got counted (route template label), /metrics never counts itself
    expect(res.body).toContain('route="/health"');
    expect(res.body).not.toContain('route="/metrics"');
    expect(res.body).not.toMatch(/route="\/v1\/audit-events\/[0-9a-f]{8}/); // no raw ids as labels
  });

  it('keeps metrics labels bounded to route templates', async () => {
    // two authenticated calls against the same template -> same label pair
    const login = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'wrong-password' },
    });
    expect(login.statusCode).toBe(401);
    const res = await inject({ url: '/metrics' });
    expect(res.body).toContain('route="/v1/auth/login"');
    expect(res.body).not.toContain('wrong-password'); // never in metrics either
  });
});
