# CHANGELOG
## AI Customer Support Platform — significant project changes

## 2026-10-19
### Audit log (P2, DATABASE_DESIGN §5 + SECURITY §8 + FR-018)
- **Migration `005_audit`** (dev + test DB): `audit_events(id, tenant_id, actor_type, actor_id, action, target_type, target_id, outcome, correlation_id, metadata, occurred_at)` — append-only by design: no FK on `actor_id` (trail outlives actors), `target_id` text (composite keys), CHECKs on actor_type (`user/system/ai/integration`) + outcome (`success/failure/denied`); keyset index `(tenant_id, occurred_at, id)` + `(tenant_id, action)` + `(tenant_id, actor_id)`
- **Enforcement in-schema**: RLS tenant policy (`USING/WITH CHECK`, same fail-closed `NULLIF` shape as 004) + **`REVOKE UPDATE, DELETE … FROM aicsp_app`** — the app role is INSERT-only on audit rows; owner `aicsp` retains full DML for retention jobs/admin repair (documented exception)
- **`AuditService`** (global leaf module): `record()` appends inside `withTenant` and **rejects on write failure — callers await it, so an audit-write failure fails the sensitive transaction** (SECURITY §8, no silent gaps); `list()` keyset-paginates `(occurred_at, id) DESC` with filters (action/actor_id/outcome/target_type/target_id/from/to); metadata is structured + redacted-safe only, never message bodies (spec §5)
- **Auth event hooks**: `auth.login` success + failure (known accounts under their default-tenant anchor with `reason`; unknown accounts log-only — no tenant exists to anchor to), `tenant.switch` success (under the **target** tenant) + **denied** (under the current tenant with `attempted_tenant_id` — a cross-tenant probe now leaves a trail), `auth.logout`, `auth.refresh_reuse` (recorded before the request fails); refresh rotation stays in `sessions` (documented boundary)
- **`GET /v1/audit-events`** (API_CONTRACTS row implemented): admin-only (`RolesGuard` + `@RequireRoles('owner','admin')` — the roles holding `audit.view`), tenant from the verified JWT `tid`, validation (`cursor` = `ISO|uuid`, `limit` 1–100 default 50, enum/uuid/ISO filters → `validation_failed`), response `{ events[], next_cursor }`
- **Tests ×17** (Gate A/B): `audit.integration.spec.ts` ×11 as the app role (cross-tenant list isolation, WITH CHECK forge rejection, **UPDATE/DELETE denied = append-only proof**, event emission for login/switch-denied/switch-success/logout/reuse incl. success-visible-only-in-target, keyset walk with exactly-once semantics, filter composition, `record()` failure propagation) + `audit.controller.spec.ts` ×6 (response shape, cursor/limit/enum/uuid/date validation, no-tid → `permission_denied`)
- Live-boot finding: `RolesGuard` depends on `TenancyService` → `AuditModule` imports `TenancyModule` (module wiring isn't covered by unit tests — the boot smoke caught it)
- Verified: **vitest 74/74 across 15 files, 6/6 turbo tasks** (+typecheck/build green); live HTTP smoke: admin audit list **200 with the `auth.login` event** (ip/ua metadata), bad cursor → 400, bad limit → 400, no token → 401; full auth chain re-verified (429@5, reuse 401, switch-foreign 403)

### Case/message schema + RLS enforcement (P2, ADR-003 execution)
- **Migration `003_conversation`** (dev `ai_csp` + test `ai_csp_test`): `queues`, `customers`, `customer_identities`, `conversations`, `cases`, `messages`, `case_events`, `handoffs` per DATABASE_DESIGN §2–4 — uuid PKs, `tenant_id` FK `ON DELETE CASCADE`, tenant-leading composite indexes, partial uniques (lower(email), external thread where present), status/priority/direction/actor/delivery/channel/state CHECKs; routing rules/agent presence deferred to the routing slice
- **Migration `004_rls`**: RLS + `USING/WITH CHECK` policies on all 8 business tables + `tenant_memberships` (tenant **or** own-user scope); `NULLIF(current_setting(…), '')` makes the policy fail-closed for both "never set" and the stale `''` left by a committed `SET LOCAL` (a raw `::uuid` cast would error)
- **Least-privilege app role `aicsp_app`** (cluster-wide, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; one-time loopback-trust creation, `pg_hba` restored to scram + verified): `DATABASE_URL`/`TEST_DATABASE_URL` now point at it (tests exercise real RLS); new **`MIGRATIONS_DATABASE_URL`** holds the owner `aicsp` URL — `db:migrate` reads it via `node-pg-migrate --database-url-var`; future tables auto-granted via `ALTER DEFAULT PRIVILEGES`
- **Scope helpers** `withTenant`/`withUser` (`src/db/tenant-scope.ts`, transaction-local `set_config` with bind params); `TenancyService` membership reads moved into scopes
- **Gate-A enforcement tests ×7** (`rls.integration.spec.ts`, run as the app role): foreign-tenant SELECT/INSERT negatives, no-scope fail-closed, `''`-GUC tolerance, scope-leak-on-rollback, membership visibility matrix
- Empirical findings recorded in ADR-003 execution note: FK cascade bypasses RLS (tenant cleanup semantics); `SET LOCAL` post-commit `''` placeholder
- Runbook: `start-infra.ps1` adds SeaweedFS `-s3.port.iceberg=0` (port 8181 was held by system `identity.exe`, weed fataled on bind); `infra-verify.ps1` rewritten for the two-role model (`app-role login: aicsp_app@ai_csp`) with hardened version/extension/backup checks
- **Secrets hygiene fix (pre-commit audit caught it):** the hardcoded S3 fallback credentials in tracked `start-infra.ps1` were removed — the script now generates missing S3 credentials **into `.env`** at first run; local `.env` S3 keys rotated (old fallback values remain in git history — localhost-only SeaweedFS credentials, acceptable; documented here), `s3.config` regenerated from the rotated values; post-change secrets audit: **AUDIT-CLEAN** (90 files, 9 secret values, zero leaks)
- Verified: **infra-verify ALL CHECKS PASSED**; **vitest 57/57 across 13 files, 6/6 turbo tasks** (+typecheck/build green); live HTTP smoke all expected codes with the API running as `aicsp_app`

## 2026-10-16
### Decisions approved (founder)
- **D-01 = A'** — modular monolith with extraction path → `adr/ADR-010`
- **D-02 = TypeScript + NestJS/Fastify** → `adr/ADR-001`
- **D-03 = Native Windows services on E: (conditional)** → `adr/ADR-011` (E: free space + permissions verified)
- **D-07 = Yes — Git init + .gitignore** (no commits/pushes without separate permission) → `adr/ADR-012`
- **D-13 = Chat → Email → Voice staged MVP** → `adr/ADR-013`
- **D-14 = Claymorphism** (restrained, on blueprint design tokens) → `adr/ADR-014`
- **D-15 = SeaweedFS** — local S3-compatible object/file storage (MinIO official CDN unavailable) → confirmed 2026-10-16, recorded in `DECISIONS_PENDING` + ADR-011 amendment
- AI spending: **mock providers only** until approved cap (D-04 remains open)
- D-04…D-12 remain OPEN (D-09 target market undecided)

### Local infrastructure installed (INFRA-01, founder: "install approved")
- Installed per-user on E: (no admin, no Windows services): **PostgreSQL 17.6** (EDB binaries zip, DB `ai_csp`, role `aicsp`), **Redis 8.10.2** Windows port (AOF), **SeaweedFS 4.48** (S3 API, bucket `aicsp-files`), **Mailpit v1.31.6** (SMTP 1025 / UI 8025)
- Verified end-to-end incl. stop → cold start → re-verify cycle: **ALL CHECKS PASSED**; runbook scripts `start-infra.ps1` / `stop-infra.ps1` / `infra-verify.ps1` / `s3-verify.py`
- **D-15 (flagged 2026-10-16; CONFIRMED same day):** MinIO official binary CDN now returns 410 Gone → **SeaweedFS installed as S3-compatible replacement** (flagged per ADR-011 "never switch silently"; code unaffected — S3 API unchanged)
- Known gaps documented: **pgvector not bundled** in EDB zip → Phase-3 task (ADR-005); `pg_ctl start` hang workaround (direct launch) in runbook
- `.env` created locally (git-ignored) with generated JWT/DB secrets; docs synced: LOCAL_DEVELOPMENT_SETUP §2/§7, ADR-011 amendment, DECISIONS_PENDING D-15, PROGRESS_TRACKER
- (superseded by root commit `6e903df` below — infra runbook scripts are tracked)

### Version control (ADR-012, founder-authorized)
- **Root commit `6e903df`** (2026-10-16, founder: *"commit approved"*): 55 files, 4,525 insertions — full doc set + infra runbook + Phase-2 scaffold + lockfile; sensitive-file audit clean (no `.env`, no data/binaries)
- `origin` remote added per founder instruction: `https://github.com/JeetAhirwar/AI-Customer-Support-Platform.git`
- **Commit policy amended** (founder: *"jo tumhe sahi lage"* → option (b)): routine local commits pre-authorized (secrets audit + green tests); **pushes always require explicit approval**
- **First push approved + executed 2026-10-16** (founder: *"push approved"*) — `master` → `origin` (`https://github.com/JeetAhirwar/AI-Customer-Support-Platform.git`); future pushes need fresh approval
- **Second push 2026-10-16** (founder: *"push approved"*, same day) — tenancy+RBAC commit `1de9898`

### Phase-2 monorepo scaffold (P2 start, 2026-10-16)
- **pnpm 12.11.2 (corepack) + Turborepo 2.11** workspace: `apps/api` (NestJS 11 + Fastify, `/health` endpoint), `apps/worker` (scaffold runtime + heartbeat), `packages/shared`; strict `tsconfig.base.json` (CommonJS backend); CI pipeline `.github/workflows/ci.yml`
- Verified: `pnpm install` (136 pkgs) · typecheck 3/3 · build 3/3 · **test 4/4** · API `/health` → 200 · worker heartbeat + graceful stop
- pnpm 12 specifics recorded: build-script approval lives in `pnpm-workspace.yaml` under `allowBuilds` (esbuild); PowerShell 5.1 has no `&&`
- Secrets hygiene: `s3-verify.py` loads S3 keys from `.env`; `s3.config` git-ignored and auto-generated by `start-infra.ps1`

### Auth module (P2, 2026-10-16)
- **Migration tool: node-pg-migrate** (delegated: founder *"jo tumhe sahi lage"*; formalization planned in ADR-003); migration `001_identity` applied to dev DB `ai_csp` + new test DB `ai_csp_test` (role `aicsp` granted `CREATEDB` via temporary loopback-trust, `pg_hba.conf` restored to scram and verified)
- Schema per DATABASE_DESIGN §2: `tenants`, `users`, `credentials` (Argon2id), `sessions` (rotating refresh: sha256 `token_hash`, `refresh_family_id`, `revoke_reason` CHECK)
- `POST /v1/auth/{login,refresh,logout}`: JWT HS256 access (15m) + opaque rotating refresh (30d, stored hashed); **reuse detection revokes the whole token family**; one indistinguishable generic `401` for all auth failures (anti-enumeration + dummy-hash timing equalization); rate limits per IP 10/min + per account 5/min with `429` + `Retry-After`
- Fail-fast config loader (missing-var errors list names only; repo-root `.env` auto-load local-only); `TEST_DATABASE_URL` added to `.env.example` + ENVIRONMENT_VARIABLES; `turbo.json` passes it to `test`
- Deps: `@node-rs/argon2` (prebuilt, no install scripts), `jsonwebtoken`, `pg`, `node-pg-migrate`
- Verified: **workspace tests 27/27 (6/6 turbo tasks), typecheck + build green**; live HTTP smoke matrix — 401 generic → 200 login → 200 refresh(rotated) → 401 reuse → 200 logout → 401 post-logout → **429 at attempt 5**; temp smoke data cleaned up

### Tenancy + RBAC (P2, 2026-10-16)
- **Migration `002_rbac`** (dev + test DB): `roles`/`role_permissions`/`teams`/`tenant_memberships` + `sessions.active_tenant_id`; invitations deferred to the invite/email slice
- **Tenant authority = JWT `tid` claim** minted after server-side membership verification (never headers/bodies — API_CONTRACTS §13); `POST /v1/auth/switch-tenant` re-verifies membership (cross-tenant probe → generic `permission_denied`); active tenant preserved across refresh
- Global `JwtAuthGuard` (non-`@Public()` routes require Bearer JWT) + `GET /v1/tenants/mine`; per-tenant roles owner/admin/agent/viewer with a permission catalog; `RolesGuard` re-reads membership from DB per request (revocation immediate)
- **Uniform error envelope** `{error:{code,message,correlation_id,details?}}` with stable codes (API_CONTRACTS); 5xx logged with correlation id, internals never leaked
- **ADR-003 accepted**: tenant isolation (predicates live now; RLS scheduled with case schema) + node-pg-migrate formalized
- Verified: **workspace tests 50/50 (6/6 turbo tasks)** incl. 10 DB-integration + Gate-A cross-tenant negatives; smoke all expected codes incl. `/v1/tenants/mine` 401/200 and `switch-tenant` → **403 permission_denied**

### Added
- Phase-1 documentation set: ARCHITECTURE, SERVICE_BOUNDARIES, SECURITY, DATABASE_DESIGN, API_CONTRACTS, ENVIRONMENT_VARIABLES, LOCAL_DEVELOPMENT_SETUP, TESTING_STRATEGY
- Final ADRs 001, 010–014 + `adr/README.md` index; drafts file marked superseded
- Repo foundation: `git init`, `.gitignore`, `.env.example`, root `README.md` (committed in root commit `6e903df`)

## 2026-10-15
- Phase 0 Discovery complete: all 5 source DOCX documents read in full; `PROJECT_DISCOVERY_REPORT.md`, `TECH_STACK_EVALUATION.md`, `TECH_STACK_RECOMMENDATION.md` created; environment audit (no Docker; C: ≈1.1 GB free; E: ≈257 GB free); 13 decisions identified
