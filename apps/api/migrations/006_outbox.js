/**
 * 006_outbox — transactional outbox (Phase 2, DATABASE_DESIGN §5, ADR-002):
 *   outbox_events(id, tenant_id, type, schema_version, payload_ref,
 *     correlation_id, state, attempts, next_attempt_at, created_at,
 *     published_at)
 *
 * Atomicity model: the API appends INSIDE the business transaction
 * (OutboxService.append takes the caller's withTenant client) — commit
 * publishes, rollback erases. The worker dispatcher claims across tenants
 * with FOR UPDATE SKIP LOCKED (per-batch transaction) as the OWNER role
 * (WORKER_DATABASE_URL, ADR-003 two-role model); the app role is append-only
 * (REVOKE UPDATE/DELETE — defense-in-depth, same as 005_audit).
 *
 * Indexes:
 *   - claim index is deliberately GLOBAL (next_attempt_at, partial pending):
 *     claiming drains all tenants by design; tenant-leading would defeat it.
 *   - (tenant_id, type, created_at) for tenant-side diagnostics/replay views.
 * State machine: pending -> published | dead (CHECK); retries keep 'pending'
 * with next_attempt_at pushed into the future; dead = DLQ (operator action).
 * Enforcement/tests: apps/api outbox.integration.spec.ts (Gate B atomicity +
 * RLS) and apps/worker dispatcher tests (claim/retry/DLQ).
 */

const { PgLiteral } = require('node-pg-migrate');
const raw = (sql) => PgLiteral.create(sql);

const tenantExpr = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

exports.up = (pgm) => {
  pgm.createTable(
    'outbox_events',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: 'tenants(id)',
        onDelete: 'cascade',
      },
      // dotted catalog name per API_CONTRACTS §3 ('case.created', ...)
      type: { type: 'text', notNull: true },
      schema_version: { type: 'integer', notNull: true, default: 1 },
      // P2: small serialized JSON payload; becomes a storage URI when object
      // storage lands (P3). Never message bodies (same rule as audit_events).
      payload_ref: { type: 'text' },
      // X-Correlation-ID from ingress, propagated end-to-end (API_CONTRACTS §3)
      correlation_id: { type: 'text' },
      state: { type: 'text', notNull: true, default: 'pending' },
      attempts: { type: 'integer', notNull: true, default: 0 },
      // claim predicate drives this column; retry pushes it forward (backoff+jitter)
      next_attempt_at: {
        type: 'timestamptz',
        notNull: true,
        default: raw('now()'),
      },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      published_at: { type: 'timestamptz' },
      // append-only from the app role: no updated_at
    },
    { ifNotExists: true },
  );

  pgm.sql(
    `ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_state_check
       CHECK (state IN ('pending','published','dead'));`,
  );

  // claim index — global on purpose (cross-tenant drain), partial to keep it tiny
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS outbox_events_pending_claim_idx
       ON outbox_events (next_attempt_at)
       WHERE state = 'pending';`,
  );
  // tenant diagnostics / per-tenant replay
  pgm.createIndex('outbox_events', ['tenant_id', 'type', 'created_at'], {
    name: 'outbox_events_tenant_type_created_idx',
  });

  // --- RLS (tenant-scoped, same shape as 004/005) ---
  // The worker claims as the owner role which bypasses RLS (ADR-003 model);
  // the app role only ever appends within its own tenant scope.
  pgm.sql(`ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY outbox_events_tenant_scope ON outbox_events
       USING (tenant_id = ${tenantExpr})
       WITH CHECK (tenant_id = ${tenantExpr});`,
  );

  // --- append-only for the app role (worker uses the owner role) ---
  pgm.sql(`REVOKE UPDATE, DELETE ON outbox_events FROM aicsp_app;`);
};

exports.down = (pgm) => {
  pgm.dropTable('outbox_events', { ifExists: true });
};
