# AI Customer Support Platform

Multi-tenant, AI-first customer support SaaS — website chat, email, and inbound voice — with grounded answers from approved business knowledge and safe human escalation when the AI cannot (or should not) act alone.

**Status: Phase 2 — Foundation (in progress).** Local infrastructure installed & verified; monorepo scaffolded and green (typecheck/build/tests, `/health` 200). No production deployment; AI/voice/email run on explicitly labeled mocks until providers and spending are approved.

## How this repository is organized

| Directory | Purpose |
|---|---|
| `Documentation/` | All project docs (start here). `adr/` = decision records. |
| `apps/api/` | NestJS (Fastify) API — modular monolith root (P2: auth, tenancy, RBAC, cases, audit, outbox per `Documentation/SERVICE_BOUNDARIES.md`) |
| `apps/worker/` | Async worker process (outbox consumer, background jobs) |
| `packages/shared/` | Shared TypeScript types/constants used by api + worker (+ future web apps) |
| `Infrastructure/` | Local dev services + runbook (native Windows on E:, ADR-011) — installed & verified 2026-10-16 |
| `Tests/` | Cross-cutting E2E, contract, performance, security suites *(added as suites land)* |
| *(future, P3+)* | AI orchestration/eval, agent workspace UI, chat widget — added under `apps/` / `packages/` when built |

## Read these first

1. `Documentation/PROJECT_DISCOVERY_REPORT.md` — what exists, what was found, risks
2. `Documentation/DECISIONS_PENDING.md` — approved (D-01/02/03/07/13/14) and open decisions
3. `Documentation/ARCHITECTURE.md` + `Documentation/adr/` — how and why it is built this way
4. `Documentation/LOCAL_DEVELOPMENT_SETUP.md` — environment setup (services **installed & verified**; scaffold commands) 

## Ground rules (non-negotiable)

- **No secrets in the repo.** `.env` is ignored; `.env.example` has placeholders only.
- **No commits, pushes, or remotes without the founder's explicit authorization** (ADR-012).
- **No paid API calls** — AI/email/voice run in mock mode until spending caps and providers are approved (D-04/05/06/10).
- Tenant isolation and cross-tenant negative tests are release gates (SECURITY.md).
- Mocks are labeled `mock-*` and never presented as real integrations.

## Tech baseline (approved 2026-10-16)

TypeScript · NestJS (Fastify) · React + TypeScript · PostgreSQL 17 (+pgvector at P3) · Redis (BullMQ) · SeaweedFS (S3 API local; MinIO unavailable → D-15) · Mailpit (local email) · modular monolith + workers (ADR-010) · restrained claymorphism UI (ADR-014) · chat → email → voice staging (ADR-013).

## Quick start (local, Windows)

```powershell
# 1. infrastructure (Postgres/Redis/SeaweedFS/Mailpit on E:)
powershell -NoProfile -ExecutionPolicy Bypass -File "Infrastructure\local-development\scripts\start-infra.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "Infrastructure\local-development\scripts\infra-verify.ps1"   # expect: ALL CHECKS PASSED

# 2. app (repo root; PowerShell 5.1 has no && — use ;)
pnpm install ; pnpm typecheck ; pnpm build ; pnpm test
pnpm --filter @aicsp/api start        # -> http://127.0.0.1:3000/health
pnpm --filter @aicsp/worker start
```
