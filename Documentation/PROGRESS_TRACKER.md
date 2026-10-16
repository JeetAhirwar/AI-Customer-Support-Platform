# PROGRESS TRACKER
## AI Customer Support Platform

**Current phase: Phase 2 (Foundation) — IN PROGRESS · infra ✅ + scaffold ✅ + auth ✅ (2026-10-16) · next: tenancy + RBAC**
Last updated: 2026-10-16

## Status board

| Phase | Scope | Status |
|---|---|---|
| P0 Discovery | Read 5 DOCX docs, inspect environment, discovery report | **COMPLETED** (2026-10-15) |
| P1 Architecture & stack approval | ADRs, service boundaries, security model, API contracts; stack approval | **COMPLETED** (2026-10-16): founder approved D-01=A', D-02=TypeScript+NestJS/Fastify, D-03=native/E:, D-07=yes, D-13=chat-first + D-14=claymorphism; final ADRs 001/010–014 issued; full Phase-1 doc set written |
| P2 Foundation | Git/CI, auth, tenants, RBAC, case/message schema, audit, outbox/queue, observability | **IN PROGRESS** — infra ✅; scaffold ✅; **auth ✅ (2026-10-16)**; tenancy next |
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

## Tests run
- Infra verification matrix 2026-10-16: **ALL CHECKS PASSED** (twice: post-install + post stop/start cycle). S3 signed round-trip: 5/5.
- App tests 2026-10-16 (scaffold): **vitest 4/4** + typecheck 3/3 + build 3/3; API `/health` live check → 200; worker heartbeat boot check.
- App tests 2026-10-16 (auth): **workspace vitest 27/27 across 8 files — 6/6 turbo tasks green** (api 24 incl. 4 DB-integration on `ai_csp_test`, worker 2, shared 1) + typecheck/build green; live HTTP smoke matrix all expected codes (401/200/200/401/200/401/429@5).
- DOCX extraction: 5/5. Git ignore rules: `.env` ignored, `.env.example` trackable.

## Current blockers
- ~~**B-1:** Local infrastructure install approval~~ → **RESOLVED** (approved + installed + verified 2026-10-16)
- ~~**B-2:** First git commit~~ → **RESOLVED** (root commit `6e903df`, 55 files, 2026-10-16, founder-approved). **Push to origin still awaiting approval**
- ~~Pending confirmation: **D-15**~~ → **RESOLVED** (founder confirmed SeaweedFS 2026-10-16)
- Future (scheduled): LLM key+cap (P3); email credentials (P4); telephony decision+number (P5); cloud account (P7); legal/consent policy (P5); segment decision (pilot); pgvector availability (P3)

## Decisions awaiting approval
See `DECISIONS_PENDING.md` (relevant now: **push approval outstanding**; D-04…D-12 open as scheduled). D-15 confirmed 2026-10-16; commit policy amended 2026-10-16 (routine commits pre-authorized, pushes gated).

## Known risks
1. C: drive nearly full → Docker path blocked (mitigation: native services on E:)
2. Voice channel latency/telephony unknowns (mitigation: early mock, spike before P5 commitment)
3. AI quality/hallucination (mitigation: grounding + eval harness from P3 + autonomy ladder + kill switch)
4. Cross-tenant leakage (mitigation: RLS + repository predicates + negative tests as CI gate)
5. Timeline assumes ~20-person team — re-baseline for actual capacity after approval

## Next recommended task
**Continue P2 Foundation** (scaffold ✅, auth ✅):
1. **Tenancy + RBAC**: `tenant_memberships`, `roles`, `role_permissions`, `teams` migration (DATABASE_DESIGN §2) → login response with active memberships → JWT guard + role checks → **cross-tenant negative tests** (Gate A/B) as they land
2. Then: case/message schema → audit log → outbox/queue → observability — closing with **cross-tenant negative tests passing** (Gates A/B)
- ~~First git commit only with separate authorization (B-2)~~ → **DONE 2026-10-16**: root `6e903df` + doc-sync `6b1ca13`; routine commits now pre-authorized (ADR-012 amendment); push pending approval

## Resume commands
```powershell
$infra = "E:\AIknotsit-Office-Work\AI-Customer-Support-Platform\Infrastructure\local-development\scripts"
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\start-infra.ps1"    # services
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\infra-verify.ps1"   # expect: ALL CHECKS PASSED
# in E:\AIknotsit-Office-Work\AI-Customer-Support-Platform (PowerShell 5.1: no && — use ;)
pnpm install
pnpm typecheck ; pnpm build ; pnpm test          # integration tests need $env:TEST_DATABASE_URL (see .env)
pnpm --filter @aicsp/api db:migrate              # DATABASE_URL from .env (dev DB)
pnpm --filter @aicsp/api start                   # GET http://127.0.0.1:3000/health
```
