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

  // ---------------------------------------------------------------------
  // Matrix: every table 004_rls enables RLS on (the customers cases above
  // were the only ones proven before this pass — the other 7 policies from
  // 003_conversation had no enforcement test at all).
  // ---------------------------------------------------------------------

  type Chain = Record<string, string>;

  let chain1: Chain;
  let chain2: Chain;

  /** One row per tenant-scoped table, in FK order, inside a single scope. */
  const buildChain = async (tenant: string, tag: string): Promise<Chain> =>
    withTenant(tenant, async (c) => {
      const one = async (sql: string, params: unknown[]): Promise<string> => {
        const r = await c.query<{ id: string }>(sql, params);
        return r.rows[0]!.id;
      };

      const customer = await one(
        `INSERT INTO customers (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
        [tenant, `RLS ${tag}`],
      );
      const queue = await one(
        `INSERT INTO queues (tenant_id, name) VALUES ($1, $2) RETURNING id`,
        [tenant, `RLS ${tag}`],
      );
      const identity = await one(
        `INSERT INTO customer_identities (tenant_id, customer_id, channel, external_id)
         VALUES ($1, $2, 'chat', $3) RETURNING id`,
        [tenant, customer, `rls-${tag}`],
      );
      const conversation = await one(
        `INSERT INTO conversations (tenant_id, channel, customer_id)
         VALUES ($1, 'chat', $2) RETURNING id`,
        [tenant, customer],
      );
      const caseId = await one(
        `INSERT INTO cases (tenant_id, customer_id, conversation_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenant, customer, conversation],
      );
      const message = await one(
        `INSERT INTO messages (tenant_id, conversation_id, direction, actor_type)
         VALUES ($1, $2, 'inbound', 'customer') RETURNING id`,
        [tenant, conversation],
      );
      const caseEvent = await one(
        `INSERT INTO case_events (tenant_id, case_id, event_type, actor_type)
         VALUES ($1, $2, 'case.opened', 'system') RETURNING id`,
        [tenant, caseId],
      );
      const handoff = await one(
        `INSERT INTO handoffs (tenant_id, case_id, reason) VALUES ($1, $2, 'rls probe') RETURNING id`,
        [tenant, caseId],
      );

      return {
        queues: queue,
        customers: customer,
        customer_identities: identity,
        conversations: conversation,
        cases: caseId,
        messages: message,
        case_events: caseEvent,
        handoffs: handoff,
      };
    });

  beforeAll(async () => {
    chain1 = await buildChain(t1, 'one');
    chain2 = await buildChain(t2, 'two');
  }, 60_000);

  const TABLES = [
    {
      table: 'queues',
      insertSql: `INSERT INTO queues (tenant_id, name) VALUES ($1, $2)`,
      insertArgs: (tenant: string): unknown[] => [tenant, 'forged queue'],
    },
    {
      table: 'customers',
      insertSql: `INSERT INTO customers (tenant_id, display_name) VALUES ($1, $2)`,
      insertArgs: (tenant: string): unknown[] => [tenant, 'forged customer'],
    },
    {
      table: 'customer_identities',
      insertSql: `INSERT INTO customer_identities (tenant_id, customer_id, channel, external_id)
                  VALUES ($1, $2, 'chat', $3)`,
      insertArgs: (tenant: string, chain: Chain): unknown[] => [
        tenant,
        chain.customers!,
        'forged-external-id',
      ],
    },
    {
      table: 'conversations',
      insertSql: `INSERT INTO conversations (tenant_id, channel, customer_id)
                  VALUES ($1, 'chat', $2)`,
      insertArgs: (tenant: string, chain: Chain): unknown[] => [
        tenant,
        chain.customers!,
      ],
    },
    {
      table: 'cases',
      insertSql: `INSERT INTO cases (tenant_id, customer_id) VALUES ($1, $2)`,
      insertArgs: (tenant: string, chain: Chain): unknown[] => [
        tenant,
        chain.customers!,
      ],
    },
    {
      table: 'messages',
      insertSql: `INSERT INTO messages (tenant_id, conversation_id, direction, actor_type)
                  VALUES ($1, $2, 'inbound', 'customer')`,
      insertArgs: (tenant: string, chain: Chain): unknown[] => [
        tenant,
        chain.conversations!,
      ],
    },
    {
      table: 'case_events',
      insertSql: `INSERT INTO case_events (tenant_id, case_id, event_type, actor_type)
                  VALUES ($1, $2, 'forged', 'system')`,
      insertArgs: (tenant: string, chain: Chain): unknown[] => [tenant, chain.cases!],
    },
    {
      table: 'handoffs',
      insertSql: `INSERT INTO handoffs (tenant_id, case_id, reason) VALUES ($1, $2, $3)`,
      insertArgs: (tenant: string, chain: Chain): unknown[] => [
        tenant,
        chain.cases!,
        'forged handoff',
      ],
    },
  ] as const;

  it.each(TABLES)('$table: RLS enabled with a tenant policy (Gate A)', async ({ table }) => {
    const rls = await pool.query<{ rls: boolean | null }>(
      `SELECT relrowsecurity AS rls FROM pg_class WHERE oid = to_regclass($1)`,
      [`public.${table}`],
    );
    expect(rls.rows[0]?.rls, `${table} must have RLS on`).toBe(true);

    const policies = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    expect(policies.rows[0]!.n).toBeGreaterThan(0);
  });

  it.each(TABLES)(
    '$table: own tenant sees the row, foreign tenant and no scope read empty (Gate A)',
    async ({ table }) => {
      const id1 = chain1[table]!;
      const own = await withTenant(t1, (c) =>
        c.query(`SELECT id FROM ${table} WHERE id = $1`, [id1]),
      );
      expect(own.rows, `${table} must be visible to its own tenant`).toHaveLength(1);

      const foreign = await withTenant(t2, (c) =>
        c.query(`SELECT id FROM ${table} WHERE id = $1`, [id1]),
      );
      expect(foreign.rows).toHaveLength(0);

      const noScope = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id1]);
      expect(noScope.rows).toHaveLength(0);

      // …and the mirror direction: t2's own fixture row is visible to t2 but
      // hidden from t1, so "foreign tenant reads empty" is proven both ways and
      // chain2 (built in beforeAll) is actually asserted on.
      const id2 = chain2[table]!;
      const mirrored = await withTenant(t2, (c) =>
        c.query(`SELECT id FROM ${table} WHERE id = $1`, [id2]),
      );
      expect(mirrored.rows, `${table} must be visible to its own tenant (t2)`).toHaveLength(1);
      const back = await withTenant(t1, (c) =>
        c.query(`SELECT id FROM ${table} WHERE id = $1`, [id2]),
      );
      expect(back.rows, `${table} must stay hidden from t1`).toHaveLength(0);
    },
  );

  it.each(TABLES)(
    '$table: forged tenant INSERT fails WITH CHECK, scopeless INSERT is fail-closed (Gate A)',
    async ({ table, insertSql, insertArgs }) => {
      const forged = await scopedClient('app.tenant_id', t2);
      try {
        // claims t1's tenant + t1's parent rows while scoped as t2
        const message = await violationOf(() =>
          forged.query(insertSql, insertArgs(t1, chain1)),
        );
        expect(message, `${table} must reject a foreign-tenant insert`)
          .toMatch(/row-level security policy/);
      } finally {
        await forged.query('ROLLBACK').catch(() => undefined);
        forged.release();
      }

      const anon = await scopedClient(null, null);
      try {
        const message = await violationOf(() =>
          anon.query(insertSql, insertArgs(t1, chain1)),
        );
        expect(message, `${table} must reject a scopeless insert`)
          .toMatch(/row-level security policy/);
      } finally {
        await anon.query('ROLLBACK').catch(() => undefined);
        anon.release();
      }

      // nothing was written: both attempts rolled back
      const count = await withTenant(t1, (c) =>
        c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect(count.rows[0]!.n).toBeGreaterThan(0);
      const foreignView = await withTenant(t2, (c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE id = $1`,
          [chain1[table]!],
        ),
      );
      expect(foreignView.rows[0]!.n).toBe(0);
    },
  );
});
