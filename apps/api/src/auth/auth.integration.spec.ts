import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { resetConfigCache } from '../config/env';
import { TenancyService } from '../tenancy/tenancy.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { verifyAccessToken } from './tokens';

/**
 * DB-backed auth integration (Gate-A building block; TESTING_STRATEGY.md).
 * Runs only when TEST_DATABASE_URL points at a migrated test database:
 *   $env:TEST_DATABASE_URL = 'postgres://aicsp_app:.../ai_csp_test'
 *   # migrations run as table OWNER (ADR-003):
 *   $env:MIGRATIONS_DATABASE_URL = 'postgres://aicsp:.../ai_csp_test'
 *   pnpm --filter @aicsp/api db:migrate
 *   pnpm --filter @aicsp/api test
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

d('auth integration against test database', () => {
  let pool: Pool;
  let auth: AuthService;
  let tenantId: string;
  let userId: string;
  let loginEmail: string;
  let refresh1: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    resetConfigCache();
    const { getPool } = await import('../db/pool');
    pool = getPool();

    const migrated = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('public.tenants') AS t`,
    );
    if (!migrated.rows[0]?.t) {
      throw new Error(
        'Test DB not migrated — run db:migrate with $env:MIGRATIONS_DATABASE_URL ' +
          '(owner role) pointing at the test DB, see LOCAL_DEVELOPMENT_SETUP.md',
      );
    }

    auth = new AuthService(new TenancyService(), new AuditService());
    loginEmail = `integration-${Date.now()}@example.test`;

    const tenantRes = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, plan, status)
       VALUES ($1, 'trial', 'active') RETURNING id`,
      ['Integration Test Tenant'],
    );
    tenantId = tenantRes.rows[0]!.id;

    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
      [loginEmail],
    );
    userId = userRes.rows[0]!.id;

    const passwordHash = await hashPassword('Synthetic!Pass123');
    await pool.query(
      `INSERT INTO credentials (user_id, password_hash, algorithm)
       VALUES ($1, $2, 'argon2id')`,
      [userId, passwordHash],
    );
  }, 30_000);

  afterAll(async () => {
    if (pool && userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    if (pool && tenantId) await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('login issues access + refresh tokens for a valid account', async () => {
    const result = await auth.login(loginEmail, 'Synthetic!Pass123', {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.tokenType).toBe('Bearer');
    expect(result.user.email).toBe(loginEmail);
    // user has no memberships yet → empty list, no tenant claim
    expect(result.memberships).toEqual([]);
    expect(verifyAccessToken(result.accessToken).tid).toBeUndefined();
    refresh1 = result.refreshToken;
  }, 30_000);

  it('wrong password and unknown account return the SAME generic error', async () => {
    const wrongPass = auth
      .login(loginEmail, 'wrong-password', {})
      .then(() => 'no-error')
      .catch((e: Error) => e.message);
    const unknown = auth
      .login('nobody-here@example.test', 'wrong-password', {})
      .then(() => 'no-error')
      .catch((e: Error) => e.message);

    const [a, b] = await Promise.all([wrongPass, unknown]);
    expect(a).toBe('Invalid credentials');
    expect(b).toBe('Invalid credentials');
    expect(a).toBe(b); // indistinguishable → no account enumeration
  }, 30_000);

  it('refresh rotates the token and reuse of the old one revokes the family', async () => {
    const rotated = await auth.refresh(refresh1, { ip: '127.0.0.1' });
    expect(rotated.refreshToken).not.toBe(refresh1);

    // presenting the consumed token = reuse → must fail and kill the family
    await expect(auth.refresh(refresh1, {})).rejects.toThrow('Invalid credentials');

    const family = await pool.query<{ revoked: number }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
         FROM sessions WHERE user_id = $1`,
      [userId],
    );
    const total = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`,
      [userId],
    );
    expect(family.rows[0]!.revoked).toBe(total.rows[0]!.n);
  }, 30_000);

  it('logout revokes the session (subsequent refresh fails)', async () => {
    const fresh = await auth.login(loginEmail, 'Synthetic!Pass123', {});
    await auth.logout(fresh.refreshToken);
    await expect(
      auth.refresh(fresh.refreshToken, {}),
    ).rejects.toThrow('Invalid credentials');
  }, 30_000);
});
