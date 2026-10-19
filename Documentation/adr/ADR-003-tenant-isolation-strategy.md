# ADR-003: Tenant Isolation Strategy and Database Foundations

| Field | Value |
|---|---|
| Status | **ACCEPTED** (app layer + RLS **live** — execution note below) |
| Date | 2026-10-16 (RLS executed 2026-10-19) |
| Deciders | Founder (Jeet), Technical lead |
| Mandate | SECURITY.md §1 (tenant boundaries are release gates); DATABASE_DESIGN §1 references this ADR |

## Context

Cross-tenant leakage is the platform's top risk (PROGRESS_TRACKER risk #4).
SECURITY.md §1 mandates two layers: repository/service predicates on every
query **and** PostgreSQL Row-Level Security as defense-in-depth. The migration
tool for Phase-2 schema work also needed formalizing (founder delegated the
pick: *"jo tumhe sahi lage"* → node-pg-migrate).

## Decision

1. **Application layer (implemented 2026-10-16).**
   - Tenant authority is the **JWT `tid` claim**, minted only after server-side
     membership verification (`POST /v1/auth/login` / `switch-tenant`); it is
     never accepted from headers or request bodies as authority
     (API_CONTRACTS §conventions).
   - `RolesGuard` **re-reads the membership from the DB on every request** —
     role changes and membership revocations take effect immediately
     (SECURITY.md §auth); the token's `role` claim is display-only.
   - All tenant-scoped queries go through services with explicit predicates
     (`TenancyService` pattern); cross-tenant negative tests are CI gates.
2. **PostgreSQL RLS as defense-in-depth (scheduled with the case/message
   schema slice).** Policies on all tenant-owned tables:
   `USING (tenant_id = current_setting('app.tenant_id')::uuid)`, set via
   `SET LOCAL app.tenant_id` inside per-request transactions from a dedicated
   app role. Application predicates remain authoritative; RLS is the backstop.
3. **Migrations: node-pg-migrate v9** (delegated pick), CommonJS migration
   files, expression defaults via `PgLiteral.create()`; expand/contract for
   breaking schema changes; dev DB `ai_csp` + test DB `ai_csp_test` migrated
   in lockstep; `TEST_DATABASE_URL` gates DB integration tests.
4. **Phase-2 identity schema order:** auth (001) → tenancy/RBAC (002) →
   invitations (+ email outbox) → business hours/feature flags.

## Consequences

- (+) Two independent isolation layers; immediate revocation semantics; a
  verifiable Gate-A test suite already exists (cross-tenant switch denied,
  membership isolation, forged/missing token rejection).
- (+) Delegated migration-tool choice is now on the record with its quirks.
- (−) RLS adds transaction discipline (`SET LOCAL` per request) — accepted;
  the repository layer will wrap requests in transactions when RLS lands.

## Execution note (2026-10-19 — migrations 003/004 + role split)

- **Roles (least privilege).** App and integration tests connect as
  **`aicsp_app`** (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`;
  `DATABASE_URL` / `TEST_DATABASE_URL`) with `SELECT/INSERT/UPDATE/DELETE`
  on schema `public` — current tables granted explicitly, future tables via
  `ALTER DEFAULT PRIVILEGES FOR ROLE aicsp … GRANT … TO aicsp_app` (set once,
  per database). Migrations run as table owner **`aicsp`**
  (`MIGRATIONS_DATABASE_URL`, consumed only by `node-pg-migrate
  --database-url-var`); the owner bypasses RLS, keeping DDL and policy
  management simple. Role creation used the runbook's one-time loopback-trust
  dance on `pg_hba.conf` (restored to scram + verified).
- **Scope (refines "all tenant tables").** RLS is enabled on the tenant's
  **business data** — `customers`, `customer_identities`, `conversations`,
  `cases`, `messages`, `case_events`, `handoffs`, `queues` — plus
  `tenant_memberships`. **Not** RLS-protected: identity tables
  (`users`/`credentials`/`sessions`, global and keyed by uuid) and authz
  metadata (`tenants`/`roles`/`role_permissions`/`teams`) — login and the
  guard pipeline must read them across contexts by design (e.g. listing a
  user's memberships before any tenant context exists), they carry no
  business data, and every access already carries explicit tenant/user
  predicates in the repository layer.
- **Policies.** `USING/WITH CHECK (tenant_id = NULLIF(current_setting(
  'app.tenant_id', true), '')::uuid)`; memberships additionally accept
  `user_id = NULLIF(current_setting('app.user_id', true), '')::uuid` (login
  workspace picker). `NULLIF` is load-bearing: after `SET LOCAL` + `COMMIT`
  PostgreSQL leaves the `app.*` placeholder as `''`, and `''::uuid` would raise
  instead of filtering — `NULLIF` turns both "unset" and "stale empty" into
  NULL → predicate is NULL → **fail-closed** (empty reads, rejected writes).
- **Scope helpers.** `src/db/tenant-scope.ts` — `withTenant(id, fn)` /
  `withUser(id, fn)` acquire one connection, `BEGIN`,
  `SELECT set_config($1, $2, true)` (bind params, never interpolation),
  run `fn`, `COMMIT`/`ROLLBACK`. Every query against an RLS-enabled table
  must go through these helpers.
- **Empirical findings** (probed live, both recorded because they shape
  cleanup/test semantics): (a) **FK `ON DELETE CASCADE` bypasses RLS** — RI
  triggers run owner-style, so `DELETE FROM tenants …` wipes RLS-protected
  children even without scope (owner/admin operation only; the app never
  deletes tenants); (b) the `''` placeholder behaviour above.
- **Tests.** `src/db/rls.integration.spec.ts` (7 cases, Gate A) runs **as the
  app role** — foreign-tenant SELECT/INSERT negatives, no-scope fail-closed,
  `''` tolerance, rolled-back scope leak check, membership user/tenant
  visibility — so policies are exercised exactly as production traffic will
  hit them. Existing tenancy/auth flows were adapted to the scope helpers.
