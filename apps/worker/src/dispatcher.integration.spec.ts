import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { OutboxDispatcher, type OutboxEvent } from './dispatcher';

/**
 * Dispatcher integration (TESTING_STRATEGY Gate B, ADR-002 execution note).
 * Runs against the TEST database as the OWNER role — claiming drains all
 * tenants by design (RLS would block the app role; ADR-003 two-role model).
 *   $env:TEST_WORKER_DATABASE_URL = owner URL with /ai_csp_test
 *   (postgres://aicsp:...@127.0.0.1:5432/ai_csp_test)
 * Needs the schema from migrations 003–006 applied to the test DB.
 */

const workerDbUrl = process.env.TEST_WORKER_DATABASE_URL;
const d = describe.skipIf(!workerDbUrl);

d('OutboxDispatcher integration (006_outbox, owner role)', () => {
  let pool: Pool;
  let t1: string;
  let t2: string;

  async function insertEvent(
    tenantId: string,
    type: string,
    opts?: { payload?: unknown; correlationId?: string },
  ): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (tenant_id, type, payload_ref, correlation_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        tenantId,
        type,
        opts?.payload !== undefined ? JSON.stringify(opts.payload) : null,
        opts?.correlationId ?? null,
      ],
    );
    return res.rows[0]!.id;
  }

  const rowOf = async (id: string) => {
    const res = await pool.query<{
      state: string;
      attempts: number;
      next_attempt_at: Date;
      published_at: Date | null;
    }>(
      `SELECT state, attempts, next_attempt_at, published_at
         FROM outbox_events WHERE id = $1`,
      [id],
    );
    return res.rows[0]!;
  };

  /** make due now (retry rows carry a future next_attempt_at) */
  const makeDue = (id: string) =>
    pool.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE id = $1`, [
      id,
    ]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: workerDbUrl, max: 4 });
    const guard = await pool.query<{ r: string | null }>(
      `SELECT to_regclass('public.outbox_events') AS r`,
    );
    if (!guard.rows[0]?.r) {
      throw new Error(
        'Test DB not migrated with 006_outbox — run db:migrate with the ' +
          'owner URL pointing at the test DB, see LOCAL_DEVELOPMENT_SETUP.md',
      );
    }
    const stamp = Date.now();
    const mk = async (name: string): Promise<string> => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, plan, status) VALUES ($1, 'trial', 'active') RETURNING id`,
        [name],
      );
      return r.rows[0]!.id;
    };
    t1 = await mk(`Dispatcher One ${stamp}`);
    t2 = await mk(`Dispatcher Two ${stamp}`);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM tenants WHERE id = $1 OR id = $2`, [t1, t2]);
      await pool.end();
    }
  });

  it('publishes a due event: handler receives the envelope, row finalized', async () => {
    const id = await insertEvent(t1, 'case.created', {
      payload: { case_id: 'c-42', priority: 'high' },
      correlationId: 'corr-abc',
    });

    const seen: OutboxEvent[] = [];
    const dispatcher = new OutboxDispatcher(
      pool,
      new Map([
        [
          'case.created',
          async (e: OutboxEvent) => {
            seen.push(e);
          },
        ],
      ]),
      { jitter: () => 0 },
    );

    const result = await dispatcher.tick();
    expect(result).toMatchObject({ claimed: 1, published: 1, retried: 0, dead: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id,
      tenantId: t1,
      type: 'case.created',
      schemaVersion: 1,
      correlationId: 'corr-abc',
      attempts: 1,
    });
    expect(JSON.parse(seen[0]!.payloadRef!)).toEqual({
      case_id: 'c-42',
      priority: 'high',
    });

    const row = await rowOf(id);
    expect(row.state).toBe('published');
    expect(row.attempts).toBe(1);
    expect(row.published_at).toBeTruthy();
  });

  it('failing handler retries with backoff, then dies into the DLQ at maxAttempts', async () => {
    const id = await insertEvent(t1, 'email.delivery.failed', {
      payload: { to: 'x@example.test' },
    });

    const dispatcher = new OutboxDispatcher(
      pool,
      new Map([
        [
          'email.delivery.failed',
          async () => {
            throw new Error('smtp down');
          },
        ],
      ]),
      { maxAttempts: 2, baseBackoffMs: 500, jitter: () => 0 },
    );

    // attempt 1 -> retry with ~base backoff
    // Bracket the tick: next_attempt_at is stamped while the handler runs, so
    // measuring it *after* the row query would shrink under a loaded machine
    // (observed flake: query latency ate the 100ms margin below). The window
    // is [before + 400, after + 1200] — immune to slow queries, still pinned
    // to the ~500ms base backoff.
    const before = Date.now();
    const t1res = await dispatcher.tick();
    expect(t1res).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
    let row = await rowOf(id);
    const after = Date.now();
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 400); // ~500ms, clock-skew margin
    expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(after + 1200);

    // attempt 2 (>= maxAttempts) -> dead
    await makeDue(id);
    const t2res = await dispatcher.tick();
    expect(t2res).toMatchObject({ claimed: 1, retried: 0, dead: 1 });
    row = await rowOf(id);
    expect(row.state).toBe('dead');
    expect(row.attempts).toBe(2);
    expect(row.published_at).toBeNull();
  });

  it('SKIP LOCKED: concurrent dispatchers never double-claim an event', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await insertEvent(t1, 'case.assigned', { payload: { n: i } }));
    }

    const calls = new Map<string, number>();
    const make = () =>
      new OutboxDispatcher(
        pool,
        new Map([
          [
            'case.assigned',
            async (e: OutboxEvent) => {
              calls.set(e.id, (calls.get(e.id) ?? 0) + 1);
            },
          ],
        ]),
        { batchSize: 10, jitter: () => 0 },
      );

    const [a, b] = await Promise.all([make().tick(), make().tick()]);
    const published = a.published + b.published;
    expect(published).toBe(6);
    // every event handled exactly once (no double claims)
    expect(calls.size).toBe(6);
    for (const id of ids) expect(calls.get(id)).toBe(1);
  });

  it('unhandled types are left pending for other workers (claim filter)', async () => {
    const handled = await insertEvent(t2, 'knowledge.indexing.completed');
    const foreign = await insertEvent(t2, 'voice.call.ended');

    const dispatcher = new OutboxDispatcher(
      pool,
      new Map([
        ['knowledge.indexing.completed', async () => undefined],
      ]),
    );
    await dispatcher.tick();

    expect((await rowOf(handled)).state).toBe('published');
    const untouched = await rowOf(foreign);
    expect(untouched.state).toBe('pending');
    expect(untouched.attempts).toBe(0);
  });

  it('drains across tenants (worker is deliberately cross-tenant)', async () => {
    const e1 = await insertEvent(t1, 'case.resolved');
    const e2 = await insertEvent(t2, 'case.resolved');

    const dispatcher = new OutboxDispatcher(
      pool,
      new Map([['case.resolved', async () => undefined]]),
    );
    const result = await dispatcher.tick();
    expect(result).toMatchObject({ claimed: 2, published: 2 });
    expect((await rowOf(e1)).state).toBe('published');
    expect((await rowOf(e2)).state).toBe('published');
  });

  it('at-least-once: a rolled-back finalize leaves the row due for re-claim', async () => {
    // simulate a handler whose finalize transaction died: claim it, fail the
    // handler, then verify the row is still claimable (retry path) — external
    // side effects that happened before the crash may run again (documented).
    const id = await insertEvent(t1, 'tenant.config.published');
    const dispatcher = new OutboxDispatcher(
      pool,
      new Map([
        [
          'tenant.config.published',
          async () => {
            throw new Error('finalize transaction lost');
          },
        ],
      ]),
      { maxAttempts: 10, jitter: () => 0 },
    );
    await dispatcher.tick(); // attempt 1 -> pending again
    await makeDue(id);
    const second = await dispatcher.tick(); // reclaimed -> attempts=2
    expect(second.claimed).toBe(1);
    const row = await rowOf(id);
    expect(row.attempts).toBe(2);
    expect(row.state).toBe('pending');
  });
});
