# ADR-003: Tenant Isolation Strategy and Database Foundations

| Field | Value |
|---|---|
| Status | **ACCEPTED** (app-layer live; RLS scheduled) |
| Date | 2026-10-16 |
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
