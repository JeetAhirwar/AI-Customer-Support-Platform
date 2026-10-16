# ENVIRONMENT VARIABLES
## Configuration contract (placeholders only — **no real values in this file**)

Rules: `.env` (untracked) holds real values locally; `.env.example` at repo root mirrors this table with placeholders. Services validate required variables **at startup** and fail with variable *names* only — never printing values (SECURITY.md §4).

Legend: 🔴 secret · 🟢 required · ⚪ optional/phase-dependent

## Shared / app

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `NODE_ENV` | development/production switch | — | 🟢 | P2 |
| `API_PORT` | API listen port (default 3000) | — | ⚪ | P2 |
| `API_HOST` | API bind host | — | ⚪ | P2 |
| `WORKER_CONCURRENCY` | Max concurrent jobs per worker type | — | ⚪ | P2 |
| `WORKER_HEARTBEAT_MS` | Worker scaffold heartbeat interval (default 30000) | — | ⚪ | P2 |
| `LOG_LEVEL` | pino level (info default) | — | ⚪ | P2 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Traces/metrics collector (empty = disabled locally) | — | ⚪ | P2 |
| `APP_SECRET` (or `JWT_ACCESS_SECRET`) | Signing key for access tokens | 🔴 | 🟢 | P2 |
| `JWT_REFRESH_SECRET` | Signing key for refresh tokens (separate!) | 🔴 | 🟢 | P2 |
| `JWT_ACCESS_TTL` | e.g. `15m` | — | ⚪ | P2 |
| `JWT_REFRESH_TTL` | e.g. `30d` | — | ⚪ | P2 |
| `CORS_ALLOWED_ORIGINS` | Admin SPA + widget origins (comma-separated) | — | 🟢 | P2 |

## Database

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@localhost:5432/ai_csp` | 🔴 | 🟢 | P2 |
| `DATABASE_POOL_MAX` | Pool size | — | ⚪ | P2 |
| `DB_SSL` | `require` in cloud, `false` local | — | ⚪ | P2 |
| `TEST_DATABASE_URL` | Test DB for integration tests (`ai_csp_test`); suite skips if unset | 🔴 | ⚪ (CI sets it) | P2 |

## Redis / queue

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | 🔴 if auth | 🟢 (P2 cache/limits; BullMQ dispatch) | P2 |
| `QUEUE_PREFIX` | e.g. `aicsp` | — | ⚪ | P2 |
| `JOB_MAX_ATTEMPTS` | Retry cap before DLQ (default 5) | — | ⚪ | P2 |

## Object storage (SeaweedFS local, S3 API → S3 at P7)

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `S3_ENDPOINT` | `http://localhost:9000` local | — | 🟢 | P2 |
| `S3_REGION` | e.g. `us-east-1` | — | 🟢 | P2 |
| `S3_BUCKET_FILES` | Attachments/knowledge files bucket | — | 🟢 | P2 |
| `S3_ACCESS_KEY` | Access key | 🔴 | 🟢 | P2 |
| `S3_SECRET_KEY` | Secret key | 🔴 | 🟢 | P2 |
| `S3_FORCE_PATH_STYLE` | `true` for SeaweedFS/MinIO-style local S3 | — | ⚪ | P2 |

## Email (Mailpit locally; real provider decided D-05 at P4)

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `SMTP_HOST` | `localhost` (Mailpit: 1025) | — | 🟢 (dev) | P2 |
| `SMTP_PORT` | `1025` local | — | 🟢 (dev) | P2 |
| `SMTP_FROM` | Platform sender address | — | 🟢 (dev) | P2 |
| `EMAIL_PROVIDER` | `mailpit-mock` initially; `graph|gmail|postmark|...` at P4 | — | 🟢 | P3/P4 |
| `EMAIL_PROVIDER_API_KEY` / OAuth vars | Real provider creds | 🔴 | P4 (after D-05) | P4 |
| `EMAIL_WEBHOOK_SECRET` | Inbound webhook signature verification | 🔴 | P4 | P4 |

## AI providers (mock until approved spending cap — D-04 open)

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `AI_PROVIDER_MODE` | `mock` (default) \| `openai` \| `anthropic` | — | 🟢 | P2 |
| `LLM_API_KEY` | Primary model provider key | 🔴 | P3 real mode only | P3 |
| `LLM_MODEL` | e.g. `gpt-4o-mini` / `claude-...` | — | ⚪ | P3 |
| `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` | Budgets | — | ⚪ | P3 |
| `EMBEDDING_MODEL` | e.g. `text-embedding-3-small` | — | ⚪ | P3 |
| `AI_MONTHLY_BUDGET_CAP_USD` | Hard spend guard | — | 🟢 when real mode | P3 |

## Voice (mock until D-06 decided — P5)

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `VOICE_PROVIDER_MODE` | `mock` (default) \| provider name | — | 🟢 | P5 |
| `VOICE_PROVIDER_SID` / `VOICE_AUTH_TOKEN` | Provider account | 🔴 | P5 real mode | P5 |
| `VOICE_WEBHOOK_SECRET` | Callback signature verification | 🔴 | P5 | P5 |
| `VOICE_RECORDING_ENABLED` | Default `false` until D-10 policy | — | 🟢 | P5 |

## Operator / misc

| Variable | Purpose | Secret | Required | Phase |
|---|---|---|---|---|
| `PLATFORM_OPERATOR_TOKEN` | Break-glass operator access (audited) | 🔴 | P6 | P6 |
| `SENTRY_DSN` (or self-hosted equivalent) | Error reporting | 🔴 | ⚪ P6 | P6 |

**Never** commit real values. Cloud secrets move to the managed secret manager at P7 (same names). Any new variable must be added here and to `.env.example` in the same PR (enforced by a docs check).
