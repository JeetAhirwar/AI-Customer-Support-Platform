import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AppException } from '../common/errors';
import { resetConfigCache } from '../config/env';
import { TenancyService } from '../tenancy/tenancy.service';
import { AuthService } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import { withTenant } from '../db/tenant-scope';
import { AuditService } from './audit.service';

/**
 * Audit trail integration (TESTING_STRATEGY Gate A/B):
 *  - tenant isolation of audit rows (RLS policy from 005_audit)
 *  - append-only enforcement (UPDATE/DELETE revoked from the app role)
 *  - SECURITY.md §8: auth flows emit events; denied cross-tenant probes are
 *    recorded; audit-write failure propagates (no silent gaps)
 *  - keyset pagination + filters
 * Runs as the real APP role (TEST_DATABASE_URL = aicsp_app). Needs a
 * migrated test database (see auth.integration.spec.ts header).
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

const PASSWORD = 'Synthetic!Pass123';

async function violationOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function appCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppException
      ? String((err.getResponse() as { code?: string }).code)
      : `unexpected:${err}`;
  }
}

d('audit trail integration (005_audit)', () => {
  let pool: Pool;
  let audit: AuditService;
  let tenancy: TenancyService;
  let auth: AuthService;
  let t1: string;
  let t2: string;
  let adminId: string; // member of t1 only
  let authUserId: string; // member of both (for switch flows)
  let authEmail: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    resetConfigCache();
    const { getPool } = await import('../db/pool');
    pool = getPool();

    const guard = await pool.query<{ rls: boolean | null }>(
      `SELECT CASE WHEN to_regclass('public.audit_events') IS NULL THEN NULL
                   ELSE (SELECT relrowsecurity FROM pg_class
                          WHERE oid = to_regclass('public.audit_events')) END AS rls`,
    );
    if (guard.rows[0]?.rls !== true) {
      throw new Error(
        'Test DB not migrated with 005_audit — run db:migrate with ' +
          '$env:MIGRATIONS_DATABASE_URL (owner role) pointing at the test DB',
      );
    }

    tenancy = new TenancyService();
    audit = new AuditService();
    auth = new AuthService(tenancy, audit);

    const stamp = Date.now();
    authEmail = `audit-auth-${stamp}@example.test`;

    const mkTenant = async (name: string): Promise<string> => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, plan, status) VALUES ($1, 'trial', 'active') RETURNING id`,
        [name],
      );
      return res.rows[0]!.id;
    };
    const mkUser = async (email: string): Promise<string> => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
        [email],
      );
      const id = res.rows[0]!.id;
      const hash = await hashPassword(PASSWORD);
      await pool.query(
        `INSERT INTO credentials (user_id, password_hash, algorithm)
         VALUES ($1, $2, 'argon2id')`,
        [id, hash],
      );
      return id;
    };
    const addMembership = async (userId: string, tenantId: string, role: string) => {
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

    t1 = await mkTenant(`Audit One ${stamp}`);
    t2 = await mkTenant(`Audit Two ${stamp}`);
    await tenancy.ensureDefaultRoles(t1);
    await tenancy.ensureDefaultRoles(t2);

    adminId = await mkUser(`audit-admin-${stamp}@example.test`);
    await addMembership(adminId, t1, 'admin');

    authUserId = await mkUser(authEmail);
    await addMembership(authUserId, t1, 'admin');
    await addMembership(authUserId, t2, 'agent');
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM users WHERE email LIKE 'audit-%@example.test'`);
      await pool.query(`DELETE FROM tenants WHERE id = $1 OR id = $2`, [t1, t2]);
    }
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('record() appends under the tenant scope; actor FK-free so the trail outlives actors', async () => {
    const ghostActor = randomUUID(); // deliberately not a real user
    await audit.record({
      tenantId: t1,
      actorType: 'user',
      actorId: ghostActor,
      action: 'test.ghost_actor',
      outcome: 'success',
      metadata: { note: 'no FK on actor_id — survives user deletion (spec §5)' },
    });

    const page = await audit.list(t1, { action: 'test.ghost_actor', limit: 10 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.actor_id).toBe(ghostActor);
    expect(page.events[0]!.outcome).toBe('success');
  });

  it('list() never leaks across tenants (Gate A)', async () => {
    await audit.record({
      tenantId: t1,
      actorType: 'system',
      action: 'test.cross_tenant',
      outcome: 'success',
    });
    const inT1 = await audit.list(t1, { action: 'test.cross_tenant', limit: 10 });
    const inT2 = await audit.list(t2, { action: 'test.cross_tenant', limit: 10 });
    expect(inT1.events).toHaveLength(1);
    expect(inT2.events).toHaveLength(0);
  });

  it('append-only: app role can INSERT but UPDATE/DELETE are revoked (005_audit)', async () => {
    const upd = await violationOf(() =>
      pool.query(`UPDATE audit_events SET outcome = 'success' WHERE false`),
    );
    expect(upd).toMatch(/permission denied/i);

    const del = await violationOf(() =>
      pool.query(`DELETE FROM audit_events WHERE false`),
    );
    expect(del).toMatch(/permission denied/i);
  });

  it('RLS WITH CHECK rejects writing audit rows into another tenant', async () => {
    const violation = await violationOf(() =>
      withTenant(t1, (c) =>
        c.query(
          `INSERT INTO audit_events (tenant_id, actor_type, action, outcome)
           VALUES ($1, 'system', 'test.forge', 'success')`,
          [t2],
        ),
      ),
    );
    expect(violation).toMatch(/row-level security policy/i);
  });

  it('login emits auth.login success; wrong password emits a failure under the default tenant', async () => {
    await auth.login(authEmail, PASSWORD, { ip: '127.0.0.1', userAgent: 'vitest' });

    const ok = await audit.list(t1, {
      action: 'auth.login',
      actorId: authUserId,
      outcome: 'success',
      limit: 10,
    });
    expect(ok.events).toHaveLength(1);
    expect(ok.events[0]!.target_type).toBe('session');
    expect(ok.events[0]!.metadata).toMatchObject({ ip: '127.0.0.1' });

    await expect(
      auth.login(authEmail, 'wrong-password', { ip: '127.0.0.1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const failed = await audit.list(t1, {
      action: 'auth.login',
      actorId: authUserId,
      outcome: 'failure',
      limit: 10,
    });
    expect(failed.events).toHaveLength(1);
    expect(failed.events[0]!.metadata).toMatchObject({
      reason: 'invalid_credentials',
    });

    // unknown accounts have no tenant anchor — documented log-only edge
    await expect(
      auth.login(`nobody-${Date.now()}@example.test`, 'x', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const stillOne = await audit.list(t1, {
      action: 'auth.login',
      outcome: 'failure',
      limit: 10,
    });
    expect(stillOne.events).toHaveLength(1);
  });

  it('switch-tenant denial is recorded under the current tenant (Gate-A probe signal)', async () => {
    // u is a member of t1+t2 — use a FRESH tenant they cannot access
    const foreign = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, plan, status)
       VALUES ($1, 'trial', 'active') RETURNING id`,
      [`Audit Foreign ${Date.now()}`],
    );
    const foreignId = foreign.rows[0]!.id;

    const login = await auth.login(authEmail, PASSWORD, {});
    const code = await appCodeOf(() =>
      auth.switchTenant(login.refreshToken, foreignId, { ip: '10.0.0.9' }),
    );
    expect(code).toBe('permission_denied');

    const denied = await audit.list(t1, {
      action: 'tenant.switch',
      outcome: 'denied',
      limit: 10,
    });
    expect(denied.events).toHaveLength(1);
    expect(denied.events[0]!.target_id).toBe(foreignId);
    expect(denied.events[0]!.metadata).toMatchObject({
      attempted_tenant_id: foreignId,
    });

    await pool.query(`DELETE FROM tenants WHERE id = $1`, [foreignId]);
  });

  it('switch-tenant success is recorded under the TARGET tenant, invisible from the source', async () => {
    const login = await auth.login(authEmail, PASSWORD, {});
    const res = await auth.switchTenant(login.refreshToken, t2, {});
    expect(res.accessToken).toBeTruthy();

    const inTarget = await audit.list(t2, {
      action: 'tenant.switch',
      actorId: authUserId,
      outcome: 'success',
      limit: 10,
    });
    expect(inTarget.events).toHaveLength(1);
    expect(inTarget.events[0]!.target_id).toBe(t2);

    const inSource = await audit.list(t1, {
      action: 'tenant.switch',
      actorId: authUserId,
      outcome: 'success',
      limit: 10,
    });
    expect(inSource.events).toHaveLength(0);
  });

  it('logout and refresh-reuse detection are audited under the session tenant', async () => {
    const login = await auth.login(authEmail, PASSWORD, { ip: '127.0.0.1' });
    const activeTid = t1; // login always anchors on the default (first) membership

    await auth.logout(login.refreshToken, { ip: '127.0.0.1' });
    const logouts = await audit.list(activeTid, {
      action: 'auth.logout',
      actorId: authUserId,
      limit: 10,
    });
    expect(logouts.events.length).toBeGreaterThanOrEqual(1);
    expect(logouts.events[0]!.outcome).toBe('success');

    // rotation: r1 -> r2; re-presenting revoked r1 = reuse -> family revoked + audited
    const fresh = await auth.login(authEmail, PASSWORD, {});
    const rotated = await auth.refresh(fresh.refreshToken, {});
    await expect(
      auth.refresh(fresh.refreshToken, { ip: '127.0.0.1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const reuseRows = [
      ...(await audit.list(t1, { action: 'auth.refresh_reuse', limit: 10 })).events,
      ...(await audit.list(t2, { action: 'auth.refresh_reuse', limit: 10 })).events,
    ];
    expect(reuseRows).toHaveLength(1);
    expect(reuseRows[0]!.outcome).toBe('failure');
    expect(reuseRows[0]!.metadata).toMatchObject({
      refresh_family_id: expect.any(String),
    });
    expect(rotated.refreshToken).toBeTruthy();
  });

  it('keyset pagination walks every row exactly once (newest first)', async () => {
    const base = Date.now();
    for (let i = 0; i < 7; i++) {
      await withTenant(t1, (c) =>
        c.query(
          `INSERT INTO audit_events
             (tenant_id, actor_type, action, outcome, occurred_at, metadata)
           VALUES ($1, 'system', $2, 'success', $3, '{}')`,
          [t1, `test.page_${i}`, new Date(base + i * 1000)],
        ),
      );
    }

    let cursor: { occurredAt: Date; id: string } | undefined;
    const actions: string[] = [];
    for (;;) {
      const page = await audit.list(t1, { limit: 3, cursor });
      for (const ev of page.events) {
        if (ev.action.startsWith('test.page_')) actions.push(ev.action);
      }
      if (!page.nextCursor) break;
      const [iso, id] = page.nextCursor.split('|');
      cursor = { occurredAt: new Date(iso!), id: id! };
    }
    expect(actions).toHaveLength(7);
    expect(new Set(actions).size).toBe(7);
    // newest first: page_6 down to page_0
    expect(actions[0]).toBe('test.page_6');
    expect(actions[actions.length - 1]).toBe('test.page_0');
  });

  it('filters compose: action + outcome + actor + time window', async () => {
    const page = await audit.list(t1, {
      action: 'auth.login',
      outcome: 'success',
      actorId: authUserId,
      from: new Date(Date.now() - 24 * 3600 * 1000),
      to: new Date(Date.now() + 60_000),
      limit: 50,
    });
    expect(page.events.length).toBeGreaterThanOrEqual(1);
    for (const ev of page.events) {
      expect(ev.action).toBe('auth.login');
      expect(ev.outcome).toBe('success');
      expect(ev.actor_id).toBe(authUserId);
    }
  });

  it('record() rejects on write failure — SECURITY §8 no-silent-gap (callers propagate)', async () => {
    // tenant_id has an FK to tenants — a bogus tenant makes the INSERT fail,
    // proving record() surfaces the error instead of swallowing it
    const message = await violationOf(() =>
      audit.record({
        tenantId: randomUUID(),
        actorType: 'system',
        action: 'test.unwritable',
        outcome: 'success',
      }),
    );
    expect(message).not.toBe('no-error');
    expect(message).toMatch(/foreign key|violates/i);
  });
});
