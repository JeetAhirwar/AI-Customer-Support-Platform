import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { resetConfigCache } from '../config/env';
import { withTenant, withUser } from './tenant-scope';

/**
 * RLS enforcement integration — TESTING_STRATEGY Gate A / ADR-003.
 * Runs as the real APP role (TEST_DATABASE_URL = aicsp_app), so the policies
 * in 004_rls.js are exercised exactly as production traffic will hit them.
 * Needs a migrated test database (see auth.integration.spec.ts header).
 */

const testDbUrl = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!testDbUrl);

async function violationOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

d('RLS enforcement (004_rls)', () => {
  let pool: Pool;
  let t1: string;
  let t2: string;
  let u1: string;
  let u2: string;
  let cust1: string;

  /** Raw client with a transaction-local tenant scope (bypasses withTenant on purpose). */
  async function scopedClient(guc: string | null, value: string | null): Promise<PoolClient> {
    const client = await pool.connect();
    await client.query('BEGIN');
    if (guc && value !== null) {
      await client.query(`SELECT set_config($1, $2, true)`, [guc, value]);
    }
    return client;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    resetConfigCache();
    const { getPool } = await import('./pool');
    pool = getPool();

    const guard = await pool.query<{ rls: boolean | null }>(
      `SELECT CASE WHEN to_regclass('public.customers') IS NULL THEN NULL
                   ELSE (SELECT relrowsecurity FROM pg_class
                          WHERE oid = to_regclass('public.customers')) END AS rls`,
    );
    if (guard.rows[0]?.rls !== true) {
      throw new Error(
        'Test DB not migrated with 003_conversation+004_rls — run db:migrate with ' +
          '$env:MIGRATIONS_DATABASE_URL (owner role) pointing at the test DB',
      );
    }

    const stamp = Date.now();
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
      return res.rows[0]!.id;
    };

    t1 = await mkTenant(`RLS One ${stamp}`);
    t2 = await mkTenant(`RLS Two ${stamp}`);
    u1 = await mkUser(`rls-u1-${stamp}@example.test`);
    u2 = await mkUser(`rls-u2-${stamp}@example.test`);

    // roles/permissions are authz metadata (no RLS) — plain pool is fine
    const role1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, name) VALUES ($1, 'agent') RETURNING id`,
        [t1],
      )
    ).rows[0]!.id;
    const role2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, name) VALUES ($1, 'agent') RETURNING id`,
        [t2],
      )
    ).rows[0]!.id;
    await withTenant(t1, (c) =>
      c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [t1, u1, role1],
      ),
    );
    await withTenant(t2, (c) =>
      c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active')`,
        [t2, u2, role2],
      ),
    );

    // one business row under t1 (customers is RLS-protected)
    cust1 = (
      await withTenant(t1, (c) =>
        c.query<{ id: string }>(
          `INSERT INTO customers (tenant_id, display_name) VALUES ($1, 'RLS Probe')
           RETURNING id`,
          [t1],
        ),
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      // deleting the tenants cascades into memberships + business tables
      // (FK cascade runs as owner — verified behaviour, see ADR-003)
      await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [u1, u2]);
      await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [t1, t2]);
    }
    const { closePool } = await import('./pool');
    await closePool();
  });

  it('SELECT is scoped: own tenant sees the row, foreign tenant does not (Gate A)', async () => {
    const own = await withTenant(t1, (c) =>
      c.query(`SELECT id FROM customers WHERE id = $1`, [cust1]),
    );
    expect(own.rows).toHaveLength(1);

    const foreign = await withTenant(t2, (c) =>
      c.query(`SELECT id FROM customers WHERE id = $1`, [cust1]),
    );
    expect(foreign.rows).toHaveLength(0);
  });

  it('without any tenant scope the table reads empty — fail-closed (Gate A)', async () => {
    const r = await pool.query(`SELECT id FROM customers WHERE id = $1`, [cust1]);
    expect(r.rows).toHaveLength(0);
  });

  it('INSERT with a foreign tenant scope is rejected by WITH CHECK (Gate A)', async () => {
    const client = await scopedClient('app.tenant_id', t2);
    try {
      const message = await violationOf(() =>
        client.query(
          `INSERT INTO customers (tenant_id, display_name) VALUES ($1, 'forged')`,
          [t1],
        ),
      );
      expect(message).toMatch(/row-level security policy/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('INSERT without any scope is rejected — fail-closed (Gate A)', async () => {
    const client = await scopedClient(null, null);
    try {
      const message = await violationOf(() =>
        client.query(`INSERT INTO customers (tenant_id, display_name) VALUES ($1, 'anon')`, [t1]),
      );
      expect(message).toMatch(/row-level security policy/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it("empty GUC left after SET LOCAL reads empty (no uuid-cast error)", async () => {
    // set_config(..., true) reverts to an app.* placeholder = '' after COMMIT;
    // NULLIF in the policy must keep this a silent empty result
    const client = await scopedClient('app.tenant_id', t1);
    try {
      await client.query('COMMIT'); // scope gone; placeholder remains ''
      const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers`);
      expect(r.rows[0]!.n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('scope never leaks across statements: rolled-back transaction leaves no GUC', async () => {
    await expect(
      withTenant(t1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers`);
    expect(r.rows[0]!.n).toBe(0);
  });

  it('memberships: user scope sees only own rows, tenant scope only its tenant (Gate A)', async () => {
    const mine = await withUser(u1, (c) =>
      c.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
        [u1],
      ),
    );
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]!.tenant_id).toBe(t1);

    // u2's scope cannot read u1's membership row even with an explicit predicate
    const cross = await withUser(u2, (c) =>
      c.query(`SELECT id FROM tenant_memberships WHERE user_id = $1`, [u1]),
    );
    expect(cross.rows).toHaveLength(0);

    // tenant scope sees exactly that tenant's memberships — nothing of t2
    const tenantView = await withTenant(t1, (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships`),
    );
    expect(tenantView.rows[0]!.n).toBe(1);
    const t2FromT1 = await withTenant(t1, (c) =>
      c.query(`SELECT id FROM tenant_memberships WHERE tenant_id = $1`, [t2]),
    );
    expect(t2FromT1.rows).toHaveLength(0);
  });
});
