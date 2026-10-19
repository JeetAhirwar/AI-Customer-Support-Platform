import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { resetConfigCache } from '../config/env';
import { withTenant } from '../db/tenant-scope';
import { OutboxService } from './outbox.service';

/**
 * Outbox integration (TESTING_STRATEGY Gate B, ADR-002) — runs as the real
 * APP role (TEST_DATABASE_URL = aicsp_app):
 *  - atomic append: an event rolled back with its business transaction
 *    disappears (the transactional-outbox proof)
 *  - RLS isolation + WITH CHECK (006_outbox)
 *  - append-only for the app role (UPDATE/DELETE revoked)
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

d('transactional outbox (006_outbox)', () => {
  let pool: Pool;
  let outbox: OutboxService;
  let t1: string;
  let t2: string;

  const scopedCount = (tenantId: string, eventId: string) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_events WHERE id = $1`,
        [eventId],
      );
      return Number(r.rows[0]!.n);
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbUrl;
    resetConfigCache();
    const { getPool } = await import('../db/pool');
    pool = getPool();
    outbox = new OutboxService();

    const migrated = await pool.query<{ rls: boolean | null }>(
      `SELECT CASE WHEN to_regclass('public.outbox_events') IS NULL THEN NULL
                   ELSE (SELECT relrowsecurity FROM pg_class
                          WHERE oid = to_regclass('public.outbox_events')) END AS rls`,
    );
    if (migrated.rows[0]?.rls !== true) {
      throw new Error(
        'Test DB not migrated with 006_outbox — run db:migrate with ' +
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
    t1 = await mkTenant(`Outbox One ${stamp}`);
    t2 = await mkTenant(`Outbox Two ${stamp}`);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM tenants WHERE id = $1 OR id = $2`, [t1, t2]);
    }
    const { closePool } = await import('../db/pool');
    await closePool();
  });

  it('append() inside withTenant persists a pending event with defaults + round-trip', async () => {
    const eventId = await withTenant(t1, (c) =>
      outbox.append(c, {
        tenantId: t1,
        type: 'case.created',
        payloadRef: JSON.stringify({ case_id: 'c-1' }),
        correlationId: 'corr-123',
      }),
    );

    const rows = await withTenant(t1, (c) =>
      c.query<{
        tenant_id: string;
        type: string;
        schema_version: number;
        payload_ref: string;
        correlation_id: string;
        state: string;
        attempts: number;
        next_attempt_at: Date;
        published_at: Date | null;
      }>(
        `SELECT tenant_id, type, schema_version, payload_ref, correlation_id,
                state, attempts, next_attempt_at, published_at
           FROM outbox_events WHERE id = $1`,
        [eventId],
      ),
    );
    const row = rows.rows[0]!;
    expect(row.tenant_id).toBe(t1);
    expect(row.type).toBe('case.created');
    expect(row.schema_version).toBe(1);
    expect(JSON.parse(row.payload_ref)).toEqual({ case_id: 'c-1' });
    expect(row.correlation_id).toBe('corr-123');
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toBeTruthy();
    expect(row.published_at).toBeNull();
  });

  it('ATOMICITY: an event appended in a rolled-back transaction disappears', async () => {
    let leakedId = 'none';
    await expect(
      withTenant(t1, async (c) => {
        leakedId = await outbox.append(c, {
          tenantId: t1,
          type: 'case.rollback',
        });
        throw new Error('business transaction failed after append');
      }),
    ).rejects.toThrow('business transaction failed after append');

    expect(await scopedCount(t1, leakedId)).toBe(0);
  });

  it('never leaks across tenants: foreign scope reads empty; forged tenant fails WITH CHECK', async () => {
    const eventId = await withTenant(t1, (c) =>
      outbox.append(c, { tenantId: t1, type: 'case.private' }),
    );
    expect(await scopedCount(t1, eventId)).toBe(1);
    expect(await scopedCount(t2, eventId)).toBe(0);

    const forge = await violationOf(() =>
      withTenant(t1, (c) =>
        c.query(
          `INSERT INTO outbox_events (tenant_id, type) VALUES ($1, 'case.forge')`,
          [t2],
        ),
      ),
    );
    expect(forge).toMatch(/row-level security policy/i);
  });

  it('append-only for the app role: UPDATE/DELETE denied (006_outbox)', async () => {
    const upd = await violationOf(() =>
      pool.query(`UPDATE outbox_events SET state = 'published' WHERE false`),
    );
    expect(upd).toMatch(/permission denied/i);

    const del = await violationOf(() =>
      pool.query(`DELETE FROM outbox_events WHERE false`),
    );
    expect(del).toMatch(/permission denied/i);
  });

  it('fail-closed: append outside any tenant scope is rejected', async () => {
    const violation = await violationOf(() =>
      pool.query(`INSERT INTO outbox_events (tenant_id, type) VALUES ($1, 'x')`, [
        t1,
      ]),
    );
    expect(violation).toMatch(/row-level security policy/i);
  });
});
