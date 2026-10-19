# PROGRESS TRACKER
## AI Customer Support Platform

**Current phase: Phase 2 (Foundation) — IN PROGRESS · infra ✅ + scaffold ✅ + auth ✅ + tenancy/RBAC ✅ + case/message schema + RLS ✅ + audit log ✅ + outbox/queue ✅ (2026-10-19) · next: observability**
Last updated: 2026-10-19

## Status board

| Phase | Scope | Status |
|---|---|---|
| P0 Discovery | Read 5 DOCX docs, inspect environment, discovery report | **COMPLETED** (2026-10-15) |
| P1 Architecture & stack approval | ADRs, service boundaries, security model, API contracts; stack approval | **COMPLETED** (2026-10-16): founder approved D-01=A', D-02=TypeScript+NestJS/Fastify, D-03=native/E:, D-07=yes, D-13=chat-first + D-14=claymorphism; final ADRs 001/010–014 issued; full Phase-1 doc set written |
| P2 Foundation | Git/CI, auth, tenants, RBAC, case/message schema, audit, outbox/queue, observability | **IN PROGRESS** — infra ✅; scaffold ✅; **auth ✅; tenancy+RBAC ✅ (2026-10-16); case/message schema + RLS ✅ (2026-10-19); audit log ✅ (2026-10-19); outbox/queue ✅ (2026-10-19)**; observability next |
| P3 Chat vertical slice | Widget, chat adapter, knowledge ingestion + RAG, grounded AI, handoff, agent workspace | NOT STARTED |
| P4 Email | Inbound/outbound, threading, dedup, delivery states, bounce, attachments | NOT STARTED |
| P5 Inbound voice | Mock first; then provider, speech pipeline, transfer, consent, fallback | NOT STARTED |
| P6 Tenant config & quality | Setup wizard, AI policy versioning + publish/rollback, eval dashboard, analytics | NOT STARTED |
| P7 Hardening & pilot | Security review, load tests, runbooks, restore drill, controlled pilot | NOT STARTED |

## Completed tasks (P0)
- ✅ Verified project root `E:\AIknotsit-Office-Work\AI-Customer-Support-Platform` (contains only `Documentation/`; no code; no git)
- ✅ Located all **5 mandatory DOCX** documents — all read **completely** (paragraphs + tables, via OOXML extraction; no media/embeds skipped):
  1. `AI_Customer_Support_Platform_Problem_Solution_Brief.docx`
  2. `AI_Customer_Support_Platform_PRD_v1.docx`
  3. `AI_Customer_Support_Platform_Software_Architecture_v1.docx`
  4. `AI_Customer_Support_Platform_UI_UX_Blueprint_v1.docx`
  5. `AI_Customer_Support_Platform_Development_Implementation_Plan_v1.docx`
- ✅ Environment audit (read-only): Git 2.39, Node 22.23.1, npm 10.9.8, Python 3.14.5, Java 17, VS Code present; **no Docker/Postgres/Redis**; C: ≈1.2 GB free, E: ≈257 GB free
- ✅ Created `PROJECT_DISCOVERY_REPORT.md`, `TECH_STACK_EVALUATION.md`, `TECH_STACK_RECOMMENDATION.md`, `DECISIONS_PENDING.md`, `PROGRESS_TRACKER.md`
- ✅ (2026-10-16) **Founder CONFIRMED** D-01=A', D-02=TypeScript+NestJS/Fastify, D-03=native-on-E:, D-07=yes, D-13=chat-first; plus new directive D-14=claymorphism
- ✅ (2026-10-16) Promoted drafts → **final ADRs**: ADR-001, ADR-010, ADR-011, ADR-012, ADR-013, ADR-014 + `adr/README.md` index; drafts file marked superseded
- ✅ (2026-10-16) Wrote Phase-1 doc set: `ARCHITECTURE.md`, `SERVICE_BOUNDARIES.md`, `SECURITY.md`, `DATABASE_DESIGN.md`, `API_CONTRACTS.md`, `ENVIRONMENT_VARIABLES.md`, `LOCAL_DEVELOPMENT_SETUP.md`, `TESTING_STRATEGY.md`, `CHANGELOG.md`
- ✅ (2026-10-16) **Git repo initialized** (ADR-012) + `.gitignore` + `.env.example` + root `README.md`; ignore rules verified (`.env` ignored, `.env.example` tracked). First commit made the same day after separate authorization (`6e903df`)
- ✅ (2026-10-16) D-03 environment verification (read-only): E: **257.2 GB free** (confirmed via two methods), project-root **Modify permission** confirmed for developer user; C: ≈1.1 GB free (Docker still blocked)

## Completed tasks (INFRA-01 — local infrastructure)
- ✅ (2026-10-16) Founder approved: *"install approved"*
- ✅ Installed on E: (per-user processes, no admin, no services): **PostgreSQL 17.6** (EDB binaries zip; DB `ai_csp`, role `aicsp`, `pgcrypto`+`uuid-ossp`), **Redis 8.10.2** Windows port (AOF on), **SeaweedFS 4.48** (S3 API, bucket `aicsp-files`), **Mailpit v1.31.6** (SMTP 1025 / UI 8025)
- ✅ Verified: PG connect/version/app-role login/`pg_dump` backup; Redis PING + key persistence across restart; Mailpit SMTP send + API; SeaweedFS signed PutBucket/List/Put/Get + anonymous 403
- ✅ Resilience: **stop → cold start → full re-verify = ALL CHECKS PASSED**; data persisted across cycle
- ✅ Runbook scripts: `Infrastructure/local-development/scripts/{start-infra,stop-infra,infra-verify}.ps1` + `s3-verify.py`
- ✅ `.env` created (git-ignored) with generated secrets; docs synced (`LOCAL_DEVELOPMENT_SETUP` §2/§7, ADR-011 amendment, `DECISIONS_PENDING` D-15)
- ✅ **D-15 = SeaweedFS CONFIRMED** 2026-10-16 (founder) — object storage settled; ⚠️ **pgvector not bundled** → Phase-3 task (ADR-005)

## Completed tasks (P2 — scaffold)
- ✅ (2026-10-16) **Monorepo scaffold**: pnpm 12.11.2 (corepack, packageManager pinned) + Turborepo 2.11; `apps/api` (NestJS 11 + Fastify, `/health`), `apps/worker` (runtime + heartbeat + graceful shutdown), `packages/shared`; `tsconfig.base.json` (strict, CommonJS for backend); CI `.github/workflows/ci.yml` (typecheck→build→test)
- ✅ `pnpm install` OK (136 pkgs; esbuild build approved via `pnpm-workspace.yaml` `allowBuilds` — pnpm 12 setting location); `pnpm-lock.yaml` created (committed in root commit `6e903df`)
- ✅ Verified: **typecheck 3/3 · build 3/3 · vitest 4/4**; API boot → `/health` **200**; worker heartbeat + clean stop
- ✅ Secrets hygiene: `s3-verify.py` reads creds from `.env` (no hardcoded secrets); `s3.config` git-ignored + auto-generated by `start-infra.ps1`; `.gitignore` extended for infra `bin/ downloads/ backups/`

## Completed tasks (P2 — auth module)
- ✅ **Migration tool: node-pg-migrate** (delegated by founder *"jo tumhe sahi lage"*; to be formalized in planned ADR-003) — scripts `db:migrate` / `db:migrate:down`
- ✅ **Migration `001_identity`** applied to dev DB `ai_csp` **and** test DB `ai_csp_test` (newly created; role `aicsp` granted `CREATEDB` via temporary loopback-trust — `pg_hba.conf` restored to scram and verified)
- ✅ Schema per DATABASE_DESIGN §2: `tenants`, `users` (global), `credentials` (Argon2id), `sessions` (rotating refresh: `token_hash` sha256, `refresh_family_id`, `revoke_reason` CHECK) + indexes/constraints
- ✅ **Auth module** `POST /v1/auth/{login,refresh,logout}`: JWT HS256 access (15m) + opaque rotating refresh (30d, hashed at rest); **reuse detection revokes the whole family**; all failures = one generic `401 Invalid credentials` (anti-enumeration, incl. dummy-hash timing equalization)
- ✅ Rate limiting per IP (10/min) + per account (5/min), `429` + `Retry-After` (in-memory; Redis-backed swap seam documented)
- ✅ Fail-fast config (`src/config/env.ts`): missing-var errors list **names only**; repo-root `.env` auto-load for local dev; `DATABASE_POOL_MAX` honored
- ✅ Deps added: `@node-rs/argon2` (prebuilt, no install scripts), `jsonwebtoken`, `pg`, `node-pg-migrate` (+types)
- ✅ Tests: unit (password/tokens/rate-limit/config) + **4 DB integration tests** (login, generic-error indistinguishability, rotation+reuse family revocation, logout) — all green
- ✅ Live HTTP smoke (built `dist/main.js`): 401 generic → 200 login → 200 refresh(rotated) → 401 reuse → 200 logout → 401 post-logout refresh → **429 at attempt 5**; temp rows cleaned up

## Completed tasks (P2 — tenancy + RBAC)
- ✅ **Migration `002_rbac`** (dev + test DB): `roles`, `role_permissions`, `teams`, `tenant_memberships` (+ `sessions.active_tenant_id`); invitations table deferred to the invite/email-outbox slice
- ✅ **Tenant authority model** (API_CONTRACTS §13): JWT `tid` claim minted only after server-side membership verification; `POST /v1/auth/switch-tenant` re-verifies membership (cross-tenant probe → generic `permission_denied`, no existence leak); active tenant persisted per session and preserved across refresh
- ✅ **Global `JwtAuthGuard`** (every route 401s without Bearer JWT unless `@Public()`) + `GET /v1/tenants/mine` (workspace picker)
- ✅ **RBAC**: per-tenant roles (`owner/admin/agent/viewer`) seeded via `ensureDefaultRoles`, permission catalog (`cases.*`, `knowledge.manage`, `members.manage`, `settings.manage`, `audit.view`, `ai.config.manage`), `RolesGuard` + `@RequireRoles` — **membership re-read from DB per request** (revocation immediate, SECURITY §auth)
- ✅ **Uniform error envelope** `{error:{code,message,correlation_id,details?}}` (API_CONTRACTS) via global filter: stable codes `unauthorized/permission_denied/validation_failed/rate_limited/...`; 5xx logged with correlation id, internals never leaked
- ✅ **ADR-003 written + accepted** (tenant isolation: predicates live, RLS scheduled with case schema; migrations tool formalized)
- ✅ Tests: guards unit (JWT ×6, roles ×5, envelope ×6) + **tenancy DB integration ×6** incl. Gate-A negatives (cross-tenant switch denied both directions, membership isolation, immediate revocation, tid claim round-trip via switch+refresh)

## Completed tasks (P2 — case/message schema + RLS execution)
- ✅ (2026-10-19) **Migration `003_conversation`** (dev + test DB, DATABASE_DESIGN §2–4): `queues`, `customers`, `customer_identities`, `conversations`, `cases`, `messages`, `case_events`, `handoffs` — uuid PKs, `tenant_id` FK `ON DELETE CASCADE`, composite indexes leading with `tenant_id`, partial unique (lower(email) / external_thread_id where present), CHECKs for status/priority/direction/actor/delivery/channel/state enums; `routing_rules`/`agent_presence` deferred to the routing slice
- ✅ (2026-10-19) **ADR-003 RLS executed — migration `004_rls`**: RLS enabled + single `USING/WITH CHECK` policy on the 8 business tables + `tenant_memberships` (tenant **or** own-user GUC); `NULLIF(current_setting(…), '')` tolerates the post-`SET LOCAL` empty placeholder (fail-closed, never a cast error); authz metadata/identity tables predicate-protected (rationale in ADR-003 execution note)
- ✅ (2026-10-19) **Least-privilege app role `aicsp_app`** (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) created cluster-wide via one-time loopback-trust dance (`pg_hba` restored to scram + verified); DML granted on current tables + `ALTER DEFAULT PRIVILEGES` for future ones (both DBs); `DATABASE_URL`/`TEST_DATABASE_URL` → app role, new `MIGRATIONS_DATABASE_URL` → owner (`db:migrate` uses `--database-url-var`)
- ✅ (2026-10-19) **Scope helpers** `src/db/tenant-scope.ts` (`withTenant`/`withUser`: dedicated connection, `BEGIN` → `set_config($1,$2,true)` bind params → `COMMIT`/`ROLLBACK`); `TenancyService.membershipsForUser` → `withUser`, `resolveMembership` → `withTenant`
- ✅ (2026-10-19) **Empirical probes recorded** (ADR-003 execution note): FK `ON DELETE CASCADE` bypasses RLS (owner-style RI triggers → tenant cleanup wipes children); `SET LOCAL` reverts to `''` placeholder (drove the `NULLIF` design)
- ✅ (2026-10-19) **Gate-A RLS enforcement tests** `src/db/rls.integration.spec.ts` ×7 **as the app role**: foreign-tenant SELECT empty + INSERT `WITH CHECK` violation, no-scope fail-closed read/write, `''` GUC reads empty (no cast error), rolled-back scope leaves no GUC, membership visibility (own-user/tenant/foreign-user negatives)
- ✅ Runbook updates: `start-infra.ps1` (SeaweedFS `-s3.port.iceberg=0` — port 8181 held by a system agent; **hardcoded S3 fallback creds removed** → generated into `.env` at first run, local S3 keys rotated), `infra-verify.ps1` (two-role credential parsing + `app-role login: aicsp_app@ai_csp` + hardened version/extension/backup checks)
- ✅ Pre-commit **secrets audit clean** (90 tracked/to-add files × 9 secret values from `.env`, zero leaks; `.env` git-ignored confirmed)

## Completed tasks (P2 — audit log execution)
- ✅ (2026-10-19) **Migration `005_audit`** (dev + test DB, DATABASE_DESIGN §5): `audit_events(id, tenant_id, actor_type, actor_id, action, target_type, target_id, outcome, correlation_id, metadata jsonb, occurred_at)` — uuid PK, `tenant_id` FK `ON DELETE CASCADE`, no FK on `actor_id` (trail outlives actors), `target_id` text (composite keys), CHECKs on actor_type (`user/system/ai/integration`) + outcome (`success/failure/denied`); indexes `(tenant_id, occurred_at, id)` keyset + `(tenant_id, action)` + `(tenant_id, actor_id)`
- ✅ (2026-10-19) **Append-only + RLS enforced in-schema**: tenant policy (`USING/WITH CHECK`, same `NULLIF` shape as 004) + **`REVOKE UPDATE, DELETE ON audit_events FROM aicsp_app`** — the app role is INSERT-only; owner `aicsp` keeps full DML for retention/admin (documented exception)
- ✅ (2026-10-19) **`AuditService`** (global leaf module, SERVICE_BOUNDARIES §10): `record()` appends via `withTenant` and **rejects on write failure** — callers await it, so audit-write failure fails the sensitive transaction (SECURITY §8, no silent gaps); `list()` keyset pagination `(occurred_at, id) DESC` + filters (action/actor/outcome/target/time window); no message bodies in metadata (spec)
- ✅ (2026-10-19) **Auth event hooks** (FR-018): `auth.login` success + failure (`invalid_credentials`/`account_inactive` under the user's default-tenant anchor; unknown accounts are log-only — no tenant to anchor to), `tenant.switch` success (under TARGET tenant) + **denied** (under current tenant with `attempted_tenant_id` — Gate-A probe signal), `auth.logout`, `auth.refresh_reuse` (leaked-token signal, recorded before failing); session-scoped events fall back to the default membership; refresh rotation stays in `sessions` (documented)
- ✅ (2026-10-19) **`GET /v1/audit-events`** (API_CONTRACTS row pre-existing): admin-only via `RolesGuard` + `@RequireRoles('owner','admin')` (the roles holding `audit.view`), tenant from verified JWT `tid`, query validation (cursor `ISO|uuid`, limit 1–100 default 50, enum/uuid/ISO filters → `validation_failed`), response `{ events[], next_cursor }`
- ✅ (2026-10-19) **Gate-A/B tests** `src/audit/audit.integration.spec.ts` ×11 **as the app role** + `audit.controller.spec.ts` ×6: cross-tenant list isolation, WITH CHECK forge rejection, **UPDATE/DELETE denied (append-only)**, login/switch/logout/reuse emission incl. denied-probe row + success-in-target-only, keyset walk (7 rows exactly once, newest first), filter composition, `record()` write-failure propagation
- ✅ Fix found via live boot: `RolesGuard` needs `TenancyService` → `AuditModule` imports `TenancyModule` (unit tests don't wire modules — boot smoke caught it)
- ✅ Live HTTP smoke extended: admin `GET /v1/audit-events` → 200 with the `auth.login` event (ip/ua metadata), bad cursor → 400, bad limit → 400, no token → 401; full auth chain re-verified (429@5, reuse 401, switch-foreign 403)

## Completed tasks (P2 — outbox/queue execution, ADR-002)
- ✅ (2026-10-19) **ADR-002 written + accepted** (queue & transactional-outbox pattern): Postgres `outbox_events` = durability source of truth; worker dispatch via per-batch `FOR UPDATE SKIP LOCKED` transactions; at-least-once + handler idempotency on event id; retries `min(base·2^(n-1), cap) + jitter`; DLQ = `state='dead'` (operator action); handler registry partitions the stream by event type; Redis/BullMQ staged *behind* the outbox when volume demands (TECH_STACK_EVALUATION recommended path)
- ✅ (2026-10-19) **Migration `006_outbox`** (dev + test DB, DATABASE_DESIGN §5): `outbox_events(id, tenant_id, type, schema_version, payload_ref, correlation_id, state, attempts, next_attempt_at, created_at, published_at)` — `CHECK (state IN ('pending','published','dead'))`, **global partial claim index** `(next_attempt_at) WHERE state='pending'` (cross-tenant drain by design — documented exception to tenant-leading), tenant diagnostics index `(tenant_id, type, created_at)`; RLS tenant policy + **`REVOKE UPDATE, DELETE … FROM aicsp_app`** (API role append-only, like 005_audit)
- ✅ (2026-10-19) **`OutboxService`** (global leaf module): `append(client, event)` takes the **caller's withTenant transaction** — the event commits/rolls back atomically with the business rows (the transactional-outbox proof, tested); returns the event id (the at-least-once dedup key); `X-Correlation-ID` flows into `correlation_id`; payload discipline = audit-style (no message bodies)
- ✅ (2026-10-19) **`OutboxDispatcher`** (worker, `pg` dep added): claim → handle → finalize in ONE transaction (crash → rollback → re-claim; no stuck `processing` states, no reaper); claims only registered event types (unhandled stay pending for future workers); DLQ logged loudly (alert-ready); `startDispatcherLoop` poll loop with overlapping-tick backpressure; worker connects as **owner role** via new `WORKER_DATABASE_URL` (cross-tenant claims would be blocked by RLS — ADR-003 two-role model; exits at startup naming the variable if missing); `start` script loads repo-root `.env` via `--env-file-if-exists`
- ✅ (2026-10-19) **Env contract**: `WORKER_DATABASE_URL`, `WORKER_POLL_MS`, `TEST_WORKER_DATABASE_URL` rows (ENVIRONMENT_VARIABLES + `.env.example`); turbo `test.env` extended (strict env-mode was dropping the new test var — integration suite silently skipped until declared)
- ✅ (2026-10-19) **Gate-B tests ×17**: API `outbox.integration.spec.ts` ×5 as the app role — **atomicity (rolled-back append disappears)**, cross-tenant isolation + WITH CHECK forge, append-only (UPDATE/DELETE denied), no-scope fail-closed; worker `dispatcher.integration.spec.ts` ×6 as the owner role — publish path with envelope round-trip, retry→backoff→DLQ chain (`next_attempt_at` ≈ now+base), **SKIP LOCKED under two concurrent dispatchers (exactly-once claims)**, unhandled types left pending, cross-tenant drain, re-claim after finalize loss; worker `dispatcher.spec.ts` ×4 — backoff math (exponential/cap/jitter bound), empty-registry no-op, claim-filter surface, poll-loop wiring + onError
- ✅ Verified: worker boot (missing var → exit 1 naming it; with var → `[worker] started (outbox dispatcher, poll=1000ms, types=0)`); API unchanged paths re-smoked

## Tests run
- Infra verification matrix 2026-10-16: **ALL CHECKS PASSED** (twice: post-install + post stop/start cycle). S3 signed round-trip: 5/5.
- App tests 2026-10-16 (scaffold): **vitest 4/4** + typecheck 3/3 + build 3/3; API `/health` live check → 200; worker heartbeat boot check.
- App tests 2026-10-16 (auth): **workspace vitest 27/27 across 8 files — 6/6 turbo tasks green** (api 24 incl. 4 DB-integration on `ai_csp_test`, worker 2, shared 1) + typecheck/build green; live HTTP smoke matrix all expected codes (401/200/200/401/200/401/429@5).
- App tests 2026-10-16 (tenancy+RBAC): **workspace vitest 50/50 across 12 files — 6/6 turbo tasks green** (api 47 incl. 10 DB-integration incl. Gate-A cross-tenant negatives, worker 2, shared 1) + typecheck/build green; live HTTP smoke all expected codes incl. `/v1/tenants/mine` (401/200) and cross-tenant `switch-tenant` → **403 permission_denied**.
- Infra verification matrix 2026-10-19 (post-RLS role split): **ALL CHECKS PASSED** — `app-role login: aicsp_app@ai_csp`, pg_dump 55.8 KB, SeaweedFS S3 5/5 (after `-s3.port.iceberg=0` fix).
- App tests 2026-10-19 (case/message + RLS): **workspace vitest 57/57 across 13 files — 6/6 turbo tasks green** (api 54 incl. 7 RLS-enforcement DB tests as the app role + auth/tenancy 10 DB-integration, worker 2, shared 1) + typecheck/build green; live HTTP smoke all expected codes (health 200, login 200, `/v1/tenants/mine` 401/200, switch-foreign 403, refresh rotation, reuse 401, logout chain, **429@5**) with the API running as `aicsp_app`.
- App tests 2026-10-19 (audit log): **workspace vitest 74/74 across 15 files — 6/6 turbo tasks green** (api 71 incl. 11 audit DB-integration as the app role + 6 controller unit + prior suites, worker 2, shared 1) + typecheck/build green; live HTTP smoke extended (audit list 200 with `auth.login` event, bad cursor/limit 400, no token 401) — full auth chain re-verified.
- App tests 2026-10-19 (outbox/queue): **workspace vitest 89/89 across 17 files — 6/6 turbo tasks green** (api 76 incl. 5 outbox Gate-B DB tests as the app role, worker 12 incl. 6 dispatcher integration as the owner role + 4 unit, shared 1) + typecheck/build green; worker boot verified both paths (fail-fast without `WORKER_DATABASE_URL`, dispatcher idle with it). Redis not required for this slice (BullMQ deferred per ADR-002 §7).
- DOCX extraction: 5/5. Git ignore rules: `.env` ignored, `.env.example` trackable.

## Current blockers
- ~~**B-1:** Local infrastructure install approval~~ → **RESOLVED** (approved + installed + verified 2026-10-16)
- ~~**B-2:** First git commit~~ → **RESOLVED** (root commit `6e903df`, 55 files, 2026-10-16, founder-approved). **Pushes: both executed 2026-10-16** under separate *"push approved"* each time; future pushes need fresh approval (ADR-012 amendment)
- ~~Pending confirmation: **D-15**~~ → **RESOLVED** (founder confirmed SeaweedFS 2026-10-16)
- Future (scheduled): LLM key+cap (P3); email credentials (P4); telephony decision+number (P5); cloud account (P7); legal/consent policy (P5); segment decision (pilot); pgvector availability (P3)

## Decisions awaiting approval
See `DECISIONS_PENDING.md` (relevant now: D-04…D-12 open as scheduled). D-15 confirmed 2026-10-16; commit policy amended 2026-10-16 (routine commits pre-authorized, pushes gated); **pushes executed: 2× on 2026-10-16 + 2× on 2026-10-19 (each separately approved)**.

## Known risks
1. C: drive nearly full → Docker path blocked (mitigation: native services on E:)
2. Voice channel latency/telephony unknowns (mitigation: early mock, spike before P5 commitment)
3. AI quality/hallucination (mitigation: grounding + eval harness from P3 + autonomy ladder + kill switch)
4. Cross-tenant leakage (mitigation: RLS + repository predicates + negative tests as CI gate)
5. Timeline assumes ~20-person team — re-baseline for actual capacity after approval

## Next recommended task
**Continue P2 Foundation** (scaffold ✅, auth ✅, tenancy+RBAC ✅, case/message schema + RLS ✅, audit log ✅, outbox/queue ✅):
1. **Observability** (structured logs + correlation propagation + health/metrics baselines, ENVIRONMENT_VARIABLES `OTEL_*` ready) — then
2. Close P2 with **cross-tenant negative tests passing** (Gates A/B) as the release gate; producer wiring (`case.created` etc.) starts with the cases API (P3)
- ~~First git commit only with separate authorization (B-2)~~ → **DONE 2026-10-16**: root `6e903df` + doc-sync `6b1ca13` + auth `674248a` + push-record `7349dd4` + tenancy/RBAC `1de9898` — **all pushed to origin** (2×, each separately approved); routine commits pre-authorized, pushes gated (ADR-012 amendment)

## Resume commands
```powershell
$infra = "E:\AIknotsit-Office-Work\AI-Customer-Support-Platform\Infrastructure\local-development\scripts"
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\start-infra.ps1"    # services
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\infra-verify.ps1"   # expect: ALL CHECKS PASSED
# in E:\AIknotsit-Office-Work\AI-Customer-Support-Platform (PowerShell 5.1: no && — use ;)
pnpm install
pnpm typecheck ; pnpm build ; pnpm test          # integration tests need $env:TEST_DATABASE_URL (see .env)
pnpm --filter @aicsp/api db:migrate              # needs $env:MIGRATIONS_DATABASE_URL (owner URL from .env; dev DB)
# test DB: $env:MIGRATIONS_DATABASE_URL = owner URL with /ai_csp_test, then the same command
pnpm --filter @aicsp/api start                   # GET http://127.0.0.1:3000/health
```
