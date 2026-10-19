/**
 * 004_rls — Row-level security execution (ADR-003, Phase 2).
 *
 * App connects as least-privilege role `aicsp_app` (NOSUPERUSER NOCREATEDB
 * NOCREATEROLE NOBYPASSRLS — created once by the operator; Database ops doc).
 * Migrations keep running as table owner `aicsp` (MIGRATIONS_DATABASE_URL),
 * which bypasses RLS — DDL and policy management stay simple.
 *
 * Every app query runs inside withTenant()/withUser() (src/db/tenant-scope.ts):
 *   BEGIN; SELECT set_config('app.tenant_id', $1, true); ...; COMMIT
 * NULLIF(...) tolerates both "GUC never set" (NULL) and "SET LOCAL reverted to
 * empty string after COMMIT" (postgres leaves an app.* placeholder = ''), so the
 * ::uuid cast can never error — worst case the predicate is NULL = fail-closed.
 *
 * Scope (ADR-003 execution note):
 *   RLS  = business data + memberships (customers, customer_identities,
 *          conversations, cases, messages, case_events, handoffs, queues,
 *          tenant_memberships)
 *   NoRLS = identity (users/credentials/sessions — global, keyed by uuid) and
 *          authz metadata (tenants/roles/role_permissions/teams — required
 *          cross-context at login/authz by design, contains no business data;
 *          repository predicates carry the isolation).
 * Enforcement tests: src/db/rls.integration.spec.ts (Gate A).
 */

const tenantExpr = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
const userExpr = `NULLIF(current_setting('app.user_id', true), '')::uuid`;

const TENANT_SCOPED_TABLES = [
  'customers',
  'customer_identities',
  'conversations',
  'cases',
  'messages',
  'case_events',
  'handoffs',
  'queues',
];

exports.up = (pgm) => {
  for (const table of TENANT_SCOPED_TABLES) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(
      `CREATE POLICY ${table}_tenant_scope ON ${table}
         USING (tenant_id = ${tenantExpr})
         WITH CHECK (tenant_id = ${tenantExpr});`,
    );
  }

  // Memberships are visible either under the acting tenant context (admin/
  // guard flows) or the user's own context (login workspace picker, where the
  // tenant is not known yet). WITH CHECK mirrors USING.
  pgm.sql(`ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(
    `CREATE POLICY tenant_memberships_scope ON tenant_memberships
       USING (tenant_id = ${tenantExpr} OR user_id = ${userExpr})
       WITH CHECK (tenant_id = ${tenantExpr} OR user_id = ${userExpr});`,
  );
};

exports.down = (pgm) => {
  for (const table of TENANT_SCOPED_TABLES) {
    pgm.sql(`DROP POLICY IF EXISTS ${table}_tenant_scope ON ${table};`);
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
  pgm.sql(`DROP POLICY IF EXISTS tenant_memberships_scope ON tenant_memberships;`);
  pgm.sql(`ALTER TABLE tenant_memberships DISABLE ROW LEVEL SECURITY;`);
};
