/**
 * 005_audit — audit_events (Phase 2, DATABASE_DESIGN §5):
 *   audit_events(id, tenant_id, actor_type, actor_id, action, target_type,
 *     target_id, outcome, correlation_id, metadata jsonb, occurred_at)
 *   — append-only; no message bodies (spec).
 *
 * Append-only enforcement (SECURITY.md §8, ADR-003):
 *   - RLS tenant policy (USING + WITH CHECK) — self-contained here because
 *     004_rls predates this table;
 *   - UPDATE/DELETE revoked from the app role `aicsp_app` (INSERT-only for
 *     the application; the owner role `aicsp` retains full DML for retention
 *     jobs and admin repair — documented exception process).
 *   Read API: GET /v1/audit-events (admin only, keyset pagination).
 *   Enforcement tests: src/audit/audit.integration.spec.ts (Gate A/B).
 *
 * Conventions (§1): uuid PK, tenant_id FK -> tenants ON DELETE CASCADE,
 * tenant-leading indexes. occurred_at is the append timestamp (no
 * created_at/updated_at pair on an immutable table).
 */

const { PgLiteral } = require('node-pg-migrate');
const raw = (sql) => PgLiteral.create(sql);

const tenantExpr = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

exports.up = (pgm) => {
  pgm.createTable(
    'audit_events',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: 'tenants(id)',
        onDelete: 'cascade',
      },
      actor_type: { type: 'text', notNull: true },
      // no FK: actors may be deleted later; the audit trail must outlive them
      actor_id: { type: 'uuid' },
      // dotted convention e.g. 'auth.login', 'tenant.switch', 'rbac.role_changed'
      action: { type: 'text', notNull: true },
      target_type: { type: 'text' },
      // text (not uuid): targets include composite keys ('session', 'config:v3')
      target_id: { type: 'text' },
      outcome: { type: 'text', notNull: true },
      correlation_id: { type: 'text' },
      // structured, redacted-safe facts only — never message bodies (spec §5)
      metadata: { type: 'jsonb', notNull: true, default: raw(`'{}'::jsonb`) },
      occurred_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      // append-only: no updated_at
    },
    { ifNotExists: true },
  );

  // keyset pagination on (tenant_id, occurred_at, id) + common filters
  pgm.createIndex('audit_events', ['tenant_id', 'occurred_at', 'id'], {
    name: 'audit_events_tenant_occurred_idx',
  });
  pgm.createIndex('audit_events', ['tenant_id', 'action'], {
    name: 'audit_events_tenant_action_idx',
  });
  pgm.createIndex('audit_events', ['tenant_id', 'actor_id'], {
    name: 'audit_events_tenant_actor_idx',
  });

  pgm.sql(
    `ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check
       CHECK (actor_type IN ('user','system','ai','integration'));`,
  );
  pgm.sql(
    `ALTER TABLE audit_events ADD CONSTRAINT audit_events_outcome_check
       CHECK (outcome IN ('success','failure','denied'));`,
  );

  // --- RLS (tenant-scoped, same shape as 004_rls) ---
  pgm.sql(`ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY audit_events_tenant_scope ON audit_events
       USING (tenant_id = ${tenantExpr})
       WITH CHECK (tenant_id = ${tenantExpr});`,
  );

  // --- append-only for the app role ---
  // The default privileges set at provisioning (GRANT SELECT, INSERT, UPDATE,
  // DELETE ... TO aicsp_app) applied at CREATE TABLE time — revoke the
  // mutating verbs right after. Requires the operator-created role (INFRA-01
  // runbook); fails loudly if the database was never provisioned.
  pgm.sql(`REVOKE UPDATE, DELETE ON audit_events FROM aicsp_app;`);
};

exports.down = (pgm) => {
  pgm.dropTable('audit_events', { ifExists: true });
};
