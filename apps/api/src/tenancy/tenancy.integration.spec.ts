import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppException } from '../common/errors';
import { resetConfigCache } from '../config/env';
import { AuthService } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import { verifyAccessToken } from '../auth/tokens';
import { withTenant } from '../db/tenant-scope';
import { TenancyService } from './tenancy.service';

/**
 * Tenancy + RBAC integration (TESTING_STRATEGY Gate A building block).
 * Needs a migrated TEST_DATABASE_URL (see auth.integration.spec.ts header).
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

const PASSWORD = 'Synthetic!Pass123';

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

d('tenancy + RBAC integration', () => {
  let pool: Pool;
  let tenancy: TenancyService;
  let auth: AuthService;
  let t1: string;
  let t2: string;
  let emailA: string;
  let emailB: string;

  async function createUser(email: string): Promise<string> {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
      [email],
    );
    const id = u.rows[0]!.id;
    const hash = await hashPassword(PASSWORD);
    await pool.query(
      `INSERT INTO credentials (user_id, password_hash, algorithm)
       VALUES ($1, $2, 'argon2id')`,
      [id, hash],
    );
    return id;
  }

  async function addMembership(userId: string, tenantId: string, role: string) {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`,
      [tenantId, role],
    );
    // tenant_memberships is RLS-protected (004_rls): writes need tenant scope
    await withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [tenantId, userId, r.rows[0]!.id],
      ),
    );
  }

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
        'Test DB not migrated with 002_rbac+ — run db:migrate with ' +
          '$env:MIGRATIONS_DATABASE_URL (owner role) pointing at the test DB, ' +
          'see LOCAL_DEVELOPMENT_SETUP.md',
      );
    }

    tenancy = new TenancyService();
    auth = new AuthService(tenancy);

    const stamp = Date.now();
    emailA = `tenancy-a-${stamp}@example.test`;
    emailB = `tenancy-b-${stamp}@example.test`;

    const mkTenant = async (name: string): Promise<string> => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, plan, status) VALUES ($1, 'trial', 'active') RETURNING id`,
        [name],
      );
      return res.rows[0]!.id;
    };
    t1 = await mkTenant(`Tenant One ${stamp}`);
    t2 = await mkTenant(`Tenant Two ${stamp}`);
    await tenancy.ensureDefaultRoles(t1);
    await tenancy.ensureDefaultRoles(t2);

    const userA = await createUser(emailA);
    const userB = await createUser(emailB);
    await addMembership(userA, t1, 'admin');
    await addMembership(userB, t2, 'agent');
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM users WHERE email LIKE 'tenancy-%@example.test'`);
      await pool.query(`DELETE FROM tenants WHERE id = $1 OR id = $2`, [t1, t2]);
    }
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('ensureDefaultRoles seeds 4 roles with the documented permissions', async () => {
    const roles = await pool.query<{ name: string }>(
      `SELECT name FROM roles WHERE tenant_id = $1 ORDER BY name`,
      [t1],
    );
    expect(roles.rows.map((r) => r.name).sort()).toEqual([
      'admin',
      'agent',
      'owner',
      'viewer',
    ]);

    const adminPerms = await pool.query<{ permission_key: string }>(
      `SELECT rp.permission_key
         FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.tenant_id = $1 AND r.name = 'admin'`,
      [t1],
    );
    expect(adminPerms.rows.length).toBeGreaterThanOrEqual(8);

    const viewerPerms = await pool.query<{ permission_key: string }>(
      `SELECT rp.permission_key
         FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.tenant_id = $1 AND r.name = 'viewer'`,
      [t1],
    );
    expect(viewerPerms.rows.map((r) => r.permission_key)).toEqual(['cases.view']);
  });

  it('membershipsForUser returns only the caller tenant (Gate A)', async () => {
    const userA = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [emailA])
    ).rows[0]!.id;
    const memberships = await tenancy.membershipsForUser(userA);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.tenant_id).toBe(t1);
    expect(memberships[0]!.role).toBe('admin');
  });

  it('resolveMembership is null across tenants (Gate A)', async () => {
    const userA = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [emailA])
    ).rows[0]!.id;
    expect(await tenancy.resolveMembership(userA, t2)).toBeNull();

    const own = await tenancy.resolveMembership(userA, t1);
    expect(own?.role).toBe('admin');
    expect(own?.permission_keys).toContain('cases.manage');
    expect(own?.permission_keys).not.toContain('unknown.key');
  });

  it('disabling a membership takes effect immediately (SECURITY)', async () => {
    const userA = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [emailA])
    ).rows[0]!.id;
    await withTenant(t1, (c) =>
      c.query(
        `UPDATE tenant_memberships SET status = 'disabled' WHERE user_id = $1 AND tenant_id = $2`,
        [userA, t1],
      ),
    );
    expect(await tenancy.resolveMembership(userA, t1)).toBeNull();
    expect(await tenancy.membershipsForUser(userA)).toHaveLength(0);
    await withTenant(t1, (c) =>
      c.query(
        `UPDATE tenant_memberships SET status = 'active' WHERE user_id = $1 AND tenant_id = $2`,
        [userA, t1],
      ),
    );
    expect(await tenancy.resolveMembership(userA, t1)).not.toBeNull();
  });

  it('login embeds tid claim + memberships; cross-tenant switch is denied (Gate A)', async () => {
    const loginA = await auth.login(emailA, PASSWORD, {});
    expect(loginA.memberships).toHaveLength(1);
    expect(loginA.memberships[0]!.tenant_id).toBe(t1);
    expect(verifyAccessToken(loginA.accessToken).tid).toBe(t1);

    // user B (tenant t2) probing tenant t1 → generic permission_denied
    const loginB = await auth.login(emailB, PASSWORD, {});
    expect(loginB.memberships[0]!.tenant_id).toBe(t2);
    expect(
      await appCodeOf(() => auth.switchTenant(loginB.refreshToken, t1, {})),
    ).toBe('permission_denied');
    expect(
      await appCodeOf(() => auth.switchTenant(loginA.refreshToken, t2, {})),
    ).toBe('permission_denied');
  }, 30_000);

  it('switch-tenant to own tenant works and refresh preserves the active tenant', async () => {
    const login = await auth.login(emailA, PASSWORD, {});
    const switched = await auth.switchTenant(login.refreshToken, t1, {});
    expect(verifyAccessToken(switched.accessToken).tid).toBe(t1);
    expect(verifyAccessToken(switched.accessToken).role).toBe('admin');

    const refreshed = await auth.refresh(switched.refreshToken, {});
    expect(verifyAccessToken(refreshed.accessToken).tid).toBe(t1);
    expect(refreshed.memberships[0]!.tenant_id).toBe(t1);
  }, 30_000);
});
