# LOCAL DEVELOPMENT SETUP
## Windows-native environment on E: (ADR-011)

> **Status:** ✅ **INSTALLED & VERIFIED 2026-10-16** — founder approval ("install approved") received under the ADR-011 gate. All four services run as **per-user background processes on E:** (no Windows services, no admin rights). Full verification matrix passed, including a complete stop → cold start → re-verify cycle with data persistence. Runbook scripts live in `Infrastructure\local-development\scripts\`.

**Target machine:** Windows 11 · user `jeet` · project on E: (257 GB free ✅, Modify permission ✅) · C: nearly full (⚠️ nothing installs to C: beyond what Windows requires)

## 1. Prerequisites (already verified)

| Tool | Version | Status |
|---|---|---|
| Git | 2.39.0 | ✅ installed |
| Node.js | v22.23.1 | ✅ installed |
| npm | 10.9.8 | ✅ installed |
| pnpm | via `corepack enable` (no admin) | ⏳ at repo setup |
| Python | 3.14.5 | ✅ (optional tooling only) |
| Docker | — | ❌ not used (ADR-011) |

## 2. Services installed on E: (actual, 2026-10-16)

All binaries under `Infrastructure\local-development\bin\`, data under `Infrastructure\local-development\data\` (git-ignored), logs under `logs\`, `pg_dump` backups under `backups\`. Everything runs as per-user background processes (start/stop scripts below; no Windows services).

| # | Service | Actual product (as installed) | Local port | State |
|---|---|---|---|---|
| 1 | **PostgreSQL 17.6** | EDB Windows x64 **binaries zip** (per-user, no installer) — DB `ai_csp` (+ test `ai_csp_test`); roles: **`aicsp`** = table owner (migrations/admin, `CREATEDB`), **`aicsp_app`** = least-privilege app role (`NOBYPASSRLS`, RLS applies — ADR-003); passwords in `.env` (`MIGRATIONS_DATABASE_URL` / `DATABASE_URL`); `pgcrypto` + `uuid-ossp` enabled | 5432 | ✅ verified (connect, app-role login as `aicsp_app`, `pg_dump` backup, restart persistence) |
| 2 | **Redis 8.10.2** (Windows port, community build `redis-windows/msys2` — dev-only, unofficial) | Cache/rate-limits/BullMQ; **AOF persistence enabled** (`data\redis\appendonly.aof`) | 6379 | ✅ verified (PING, key survives restart) |
| 3 | **SeaweedFS 4.48** — S3-compatible object storage (**replaces MinIO**, see D-15: official MinIO binary CDN returns 410 Gone) | Bucket `aicsp-files` created; dev keys `S3_ACCESS_KEY`/`S3_SECRET_KEY` in `.env`; identity config `scripts\s3.config` (proto-JSON format) | S3 API 9000 · master 9333 · filer 8888 | ✅ verified (signed Put/List/Put/Get round-trip; anonymous 403) |
| 4 | **Mailpit v1.31.6** | SMTP catcher, DB `data\mailpit\mailpit.db` | SMTP 1025 · UI 8025 | ✅ verified (SMTP send + stored messages via API) |

**Known gaps (documented, not silent):**
- **pgvector is NOT included** in the EDB binaries zip (`CREATE EXTENSION vector` fails — expected until Phase 3, when ADR-005 needs it; plan: add extension build or switch distribution then). Phase 2 schema needs no vector columns.
- MinIO substitution is **D-15 in `DECISIONS_PENDING.md`** (founder confirmed 2026-10-16; SeaweedFS is the selected object storage — same S3 API).

### Runbook

```powershell
$infra = "E:\AIknotsit-Office-Work\AI-Customer-Support-Platform\Infrastructure\local-development\scripts"
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\start-infra.ps1"    # start all four (order-safe, waits for readiness)
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\infra-verify.ps1"   # full verification matrix (expected: ALL CHECKS PASSED)
powershell -NoProfile -ExecutionPolicy Bypass -File "$infra\stop-infra.ps1"     # stop all (data retained)
python "$infra\s3-verify.py"                                                    # standalone signed S3 test
```

Verified 2026-10-16: stop → cold start → verify = **ALL CHECKS PASSED**; Postgres data, Redis AOF, Mailpit messages, and the S3 object all persisted across the cycle.

## 3. Project scaffold (created + verified 2026-10-16)

Workspace: **pnpm 12.11.2 (corepack) + Turborepo 2.11** · apps `@aicsp/api` (NestJS 11/Fastify) + `@aicsp/worker`, package `@aicsp/shared` · CI `.github/workflows/ci.yml` (typecheck → build → test).

```powershell
cd E:\AIknotsit-Office-Work\AI-Customer-Support-Platform
corepack enable                      # pnpm (already active on this machine)
pnpm install                         # workspace deps (esbuild build approved via pnpm-workspace.yaml allowBuilds)
pnpm typecheck && pnpm build         # tsc across api/worker/shared
pnpm test                            # vitest across packages (DB integration runs when $env:TEST_DATABASE_URL is set — see .env)
pnpm dev                             # persistent dev tasks (Turborepo) — per-app dev: pnpm --filter @aicsp/api dev
pnpm --filter @aicsp/api db:migrate  # reads $env:MIGRATIONS_DATABASE_URL (OWNER role, from .env) via --database-url-var; test DB: set $env:MIGRATIONS_DATABASE_URL to the owner URL ending /ai_csp_test first
pnpm --filter @aicsp/api start       # run built API (needs services up: start-infra.ps1) -> GET http://127.0.0.1:3000/health
pnpm --filter @aicsp/worker start    # run built worker (heartbeat + graceful shutdown)
```

Verified 2026-10-16 (scaffold): `typecheck 3/3 · build 3/3 · test 4/4 passed`; API boots (`Nest application successfully started`, `/health` → **200** `{"status":"ok","service":"api",...}`); worker heartbeats and stops cleanly.
Verified 2026-10-16 (auth): migrations on `ai_csp` + `ai_csp_test` ✅; workspace `test 27/27 · 6/6 turbo tasks` ✅; live smoke of `/v1/auth/*` all expected codes ✅. Note: PowerShell 5.1 has no `&&` — chain with `;`.

## 4. Environment configuration

1. Copy `.env.example` → `.env` (git-ignored).
2. Fill values per `ENVIRONMENT_VARIABLES.md` (DB/Redis/S3 point at localhost; `AI_PROVIDER_MODE=mock`, `VOICE_PROVIDER_MODE=mock`, `EMAIL_PROVIDER=mailpit-mock`).
3. Startup validation fails fast listing missing **names** only.

## 5. Running and stopping

- Start order: PostgreSQL, Redis, SeaweedFS, Mailpit (`start-infra.ps1` does this) → `pnpm dev`.
- Stop order: app first, then services.
- Troubleshooting: see §7.

## 6. Testing

- `pnpm test` — unit + integration (uses Postgres test DB `ai_csp_test` + real SeaweedFS/Mailpit where needed; Redis-backed queue tests isolated by DB index).
- `pnpm test:e2e` — Playwright against full local stack.
- `pnpm test:eval` — AI eval harness (mock provider mode by default; real model runs require approved key + cap).
- Tenant-isolation suite runs in every CI pipeline (release gate).

## 7. Troubleshooting (known observed issues)

| Symptom | Likely cause | Fix |
|---|---|---|
| Postgres "could not bind IPv4 address" | Port 5432 taken | `netstat -ano | findstr 5432`; change port or stop conflicting app |
| `pgvector` extension missing | **Expected** — EDB binaries zip does not bundle pgvector | Defer to Phase 3 (ADR-005): build extension or switch distribution; Phase 2 needs no vector columns |
| **`pg_ctl start` hangs** (observed 2026-10-16) | pg_ctl wait mechanism blocks in this host environment | `start-infra.ps1` launches `postgres.exe` directly + polls `pg_isready` — do not use `pg_ctl start` manually |
| SeaweedFS S3 gateway down (port 9000 not listening) | `s3.config` wrong format — must be **proto-JSON** with top-level `"identities"` (not YAML `accounts:`), SeaweedFS 4.48 | Restore `scripts\s3.config` (JSON); check `logs\seaweed.err` for `fail to load config file` |
| SeaweedFS S3 slow to appear after start | IAM + filer init takes ~20–25 s | Wait — `start-infra.ps1` polls up to 45 s |
| S3 upload 403 with valid keys | Bucket missing or identity actions wrong | Bucket auto-verifiable via `python scripts\s3-verify.py`; recreate with signed PutBucket |
| BullMQ jobs stuck | Redis down or wrong DB index | Check Redis up; verify `REDIS_URL`; inspect queue UI later |
| Migration fails on fresh DB | Extension/role missing | Role/extensions already provisioned (§2); re-run verify script |
| Migration DDL error `invalid input syntax for type uuid: "gen_random_uuid()"` | node-pg-migrate v9 dollar-quotes **string** column defaults — SQL expressions must be `PgLiteral.create('…')` | Wrap expression defaults (`gen_random_uuid()`, `now()`, `'{}'::jsonb`) in `PgLiteral` (see `apps/api/migrations/001_identity.js`) |
| `psql -U postgres` hangs waiting for password | superuser uses scram and its password is not stored locally | Use role `aicsp` (owner, has `CREATEDB` + owns both DBs); for rare superuser needs use a **temporary** loopback `trust` line in `pg_hba.conf` and restore+reload immediately (done twice: 2026-10-16 `CREATEDB`, 2026-10-19 `aicsp_app` creation — both verified restored) |
| `The MIGRATIONS_DATABASE_URL environment variable is not set` on `db:migrate` | node-pg-migrate does not load `.env` itself | `$env:MIGRATIONS_DATABASE_URL = (Get-Content .env \| ? { $_ -match '^MIGRATIONS_DATABASE_URL=' }) -replace '^MIGRATIONS_DATABASE_URL=',''` then re-run |
| SeaweedFS dies with `Iceberg REST Catalog listener … bind: Only one usage …` (observed 2026-10-19) | weed 4.48 auto-starts an Iceberg catalog on 8181; a system agent (`identity.exe`) already holds that port | `start-infra.ps1` passes `-s3.port.iceberg=0` (disabled — unused here); check `logs\seaweed.err` |
| Custom `.ps1` fails with parse errors at odd characters | Windows PowerShell 5.1 reads no-BOM files as ANSI — UTF-8 `—`/`→` bytes become quote-like chars | Keep `.ps1` files ASCII-only or save as UTF-8 **with BOM** |
| E: full mid-install | Space accounting | Re-verify with `Get-PSDrive`; report to founder before proceeding |

## 8. Rules

- Synthetic data only — no real customer data (SECURITY.md §11).
- Nothing installs to C: without explicit approval; services configured to E: data paths.
- Version-pin everything; document any version change here.
- If native services prove unreliable → **stop, report, and request approval** for alternatives (free C: space → Docker Desktop, per ADR-011).
