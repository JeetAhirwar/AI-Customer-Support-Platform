#!/usr/bin/env node
/**
 * CI test-database provisioner — the ADR-003 two-role model, rebuilt from scratch.
 *
 * The local cluster has (LOCAL_DEVELOPMENT_SETUP.md row 1):
 *   owner `aicsp`     — runs migrations, owns every table (ownership ⇒ RLS is bypassed)
 *   app   `aicsp_app` — NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS ⇒ RLS applies,
 *                       which is what makes `rls.integration.spec.ts` and the QA-005
 *                       suite prove the real production posture instead of a fake one.
 *
 * ORDERING MATTERS: `ALTER DEFAULT PRIVILEGES` only affects tables the owner creates
 * *afterwards*, so the sequence is provision → migrate → test. It deliberately never
 * re-grants on existing tables: migrations 005/006 REVOKE UPDATE/DELETE on
 * audit_events/outbox_events from the app role on purpose, and a blanket re-grant would
 * silently undo the append-only proof.
 *
 * Idempotent (safe to run twice; a second run detects the default-ACL row and leaves it
 * alone). Reads no secrets: the CI container runs with trust auth on a job-local
 * loopback port, so there is no credential for this file to hold or leak — which is
 * exactly why it can live in the repo.
 *
 * Usage:
 *   node Infrastructure/ci/provision-test-db.mjs \
 *     --admin-url postgres://postgres@127.0.0.1:5432/postgres \
 *     --database ai_csp_test --owner aicsp --app-role aicsp_app
 *
 *   # after `db:migrate` — asserts the grants/RLS posture the tests rely on:
 *   node Infrastructure/ci/provision-test-db.mjs --admin-url ... --database ... --check-grants
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// `pg` belongs to the api workspace — resolve it from there rather than adding a root dep.
const require = createRequire(path.resolve(here, '../../apps/api/package.json'));
const { Client } = require('pg');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

/** Identifiers come from the CLI — accept only what Postgres would quote as a plain name. */
function assertIdentifier(value, label) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)} (expected [a-z_][a-z0-9_]*)`);
  }
  return value;
}

/**
 * node-postgres lets a `connectionString`'s path override a `database` option, so the
 * target database has to be set on the URL itself — otherwise every statement below is
 * silently executed against the admin database. (That bug cost one full CI simulation.)
 */
function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const adminUrl = flag('--admin-url', process.env.CI_POSTGRES_ADMIN_URL);
const database = assertIdentifier(flag('--database', 'ai_csp_test'), 'database');
const owner = assertIdentifier(flag('--owner', 'aicsp'), 'owner');
const appRole = assertIdentifier(flag('--app-role', 'aicsp_app'), 'app role');
const doCheckGrants = process.argv.includes('--check-grants');

if (!adminUrl) {
  console.error(
    'provision-test-db: missing --admin-url (superuser connection to the empty cluster)',
  );
  process.exit(2);
}

/** Runs before migrate: roles, database, default privileges. */
async function provision(client) {
  for (const [role, attrs] of [
    [owner, 'LOGIN CREATEDB'],
    [appRole, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'],
  ]) {
    const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rows.length > 0) {
      console.log(`  = role ${role} already exists`);
      continue;
    }
    await client.query(`CREATE ROLE ${role} ${attrs}`);
    console.log(`  + role ${role} (${attrs})`);
  }

  const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (db.rows.length > 0) {
    console.log(`  = database ${database} already exists`);
  } else {
    await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
    console.log(`  + database ${database} OWNER ${owner}`);
  }
}

/**
 * Runs inside the target database. Default privileges are applied only when they are
 * not already registered — re-applying them after `db:migrate` would either be a no-op
 * or, worse, invite a blanket re-grant that undoes 005/006.
 */
async function ensureGrants(client) {
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${owner}, ${appRole}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${owner}, ${appRole}`);

  const { rows } = await client.query(
    `SELECT 1 FROM pg_default_acl
      WHERE defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
        AND defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND defaclobjtype = 'r'`,
    [owner],
  );
  if (rows.length > 0) {
    console.log(`  = default privileges for ${owner} already registered`);
    return;
  }

  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
  );
  console.log(`  + default privileges: ${owner} → ${appRole} on future tables`);

  const existing = await client.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (existing.rows[0].n > 0) {
    console.warn(
      `  ! ${existing.rows[0].n} table(s) already exist — default privileges only apply to ` +
        `tables created after this point. Run provision BEFORE db:migrate.`,
    );
  }
}

/**
 * Runs after `db:migrate`. Turns "seven suites fail with permission denied" into one
 * assertion with a name, and pins the two properties the gates are actually about:
 * the app role reaches the data (grants plumbed) and cannot rewrite the audit trail
 * (005/006 append-only survives provisioning).
 */
async function checkGrants(client) {
  const { rows: tables } = await client.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'cases'`,
  );
  if (tables[0].n === 0) {
    throw new Error('no tables found — run `db:migrate` before --check-grants');
  }

  const { rows } = await client.query(
    `SELECT
       has_table_privilege($1, 'cases', 'SELECT')  AS cases_select,
       has_table_privilege($1, 'cases', 'INSERT')  AS cases_insert,
       has_table_privilege($1, 'audit_events', 'UPDATE') AS audit_update,
       has_table_privilege($1, 'audit_events', 'DELETE') AS audit_delete,
       has_table_privilege($1, 'outbox_events', 'UPDATE') AS outbox_update,
       has_table_privilege($1, 'outbox_events', 'DELETE') AS outbox_delete,
       has_schema_privilege($1, 'public', 'USAGE') AS public_usage,
       (SELECT relrowsecurity FROM pg_class WHERE relname = 'cases') AS cases_rls,
       (SELECT relrowsecurity FROM pg_class WHERE relname = 'audit_events') AS audit_rls`,
    [appRole],
  );
  const a = rows[0];
  const checks = [
    [a.cases_select, `${appRole} can SELECT cases (grants plumbed through migrations)`],
    [a.cases_insert, `${appRole} can INSERT cases (grants plumbed through migrations)`],
    [a.public_usage, `${appRole} has USAGE on schema public`],
    [!a.audit_update, `audit_events is append-only (no UPDATE for ${appRole})`],
    [!a.audit_delete, `audit_events is append-only (no DELETE for ${appRole})`],
    [!a.outbox_update, `outbox_events is append-only (no UPDATE for ${appRole})`],
    [!a.outbox_delete, `outbox_events is append-only (no DELETE for ${appRole})`],
    [a.cases_rls, 'RLS enabled on cases'],
    [a.audit_rls, 'RLS enabled on audit_events'],
  ];
  for (const [ok, label] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  const failed = checks.filter(([ok]) => !ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} grant/RLS check(s) failed`);
  }
  console.log(`check-grants: ${checks.length}/${checks.length} posture checks passed`);
}

async function main() {
  console.log(`provision-test-db: ${adminUrl.replace(/\/\/[^@]*@/, '//***@')}`);

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await provision(admin);
  } finally {
    await admin.end();
  }

  // Everything below must target the *test* database, not the admin one.
  const target = new Client({ connectionString: withDatabase(adminUrl, database) });
  await target.connect();
  try {
    await ensureGrants(target);
    console.log(`  → connected to database ${target.database}`);
    if (doCheckGrants) await checkGrants(target);
  } finally {
    await target.end();
  }

  console.log(`provision-test-db: ready (owner=${owner}, app=${appRole}, database=${database})`);
}

main().catch((err) => {
  console.error(`provision-test-db FAILED: ${err.message}`);
  process.exit(1);
});
