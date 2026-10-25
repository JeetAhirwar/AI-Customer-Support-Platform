# ADR-008: Observability — pino structured logs, correlation context, Prometheus metrics, staged OpenTelemetry

- **Status:** ACCEPTED (2026-10-19, executed — see execution note)
- **Acceptance basis:** Architecture v1 §3/§10 baseline (OpenTelemetry + logs/metrics/traces);
  `TECH_STACK_EVALUATION.md` observability recommendation (OpenTelemetry SDK + pino +
  Prometheus-compatible metrics; local-first "start with structured logs + an OTel
  collector export"); `SECURITY.md` §7 ("logs/traces structured, correlation-ID linked,
  redacted — retention documented (ADR-008)"). Executed under the Phase-2 Foundation
  mandate (founder 2026-10-16).
- **Deciders:** founder (mandate), technical delegation per established policy
- **Date:** 2026-10-19
- **Supersedes / amends:** —
- **Related:** ADR-001 (interceptors map to correlation IDs), ADR-002 (correlation into
  outbox events), API_CONTRACTS §1/§3 (error envelope + X-Correlation-ID),
  ENVIRONMENT_VARIABLES (`LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`), SERVICE_BOUNDARIES
  §auth/§ai logging notes

## Context

Phase-2 slices landed auth, tenancy, RBAC, audit and outbox — but observability was
still at scaffold level: Nest's default plain-text console logger, no log-level control,
no redaction guarantees, correlation IDs only generated inside the error filter (so
"correlation" never actually correlated — audit rows had `correlation_id` NULL, logs had
no id, outbox producers had no source), and no metrics at all. The docs mandate one
thread from ingress → logs → audit → outbox → worker, redacted logs, and a
Prometheus-compatible baseline — none of which existed in code.

## Decision

### 1. pino JSON logs, one options builder, fail-fast level

`LOG_LEVEL` (default `info`) validated at startup — invalid value fails fast naming
`LOG_LEVEL` only (ENVIRONMENT_VARIABLES fail-fast rule). All three processes (api boot
logs, request logs, worker heartbeat/DLQ logs) share **one options builder in
`@aicsp/shared`** so redaction can never drift between apps. Transport = **stdout**
(file/collector concerns belong to the platform, §5).

**Redaction (SECURITY §7):** pino `redact` covers `password`, `*.password`,
`password_hash`, `authorization`, `cookie`, `set-cookie`, `token`/`refresh_token`/
`access_token`, `secret`/`api_key` (headers + body paths). Logs must never contain
message bodies or PII beyond tenant-safe identifiers (uuids) — the same discipline as
`audit_events.metadata`.

### 2. Correlation context = AsyncLocalStorage, sanitized at ingress

- Ingress: `X-Correlation-ID` accepted only if it matches `^[A-Za-z0-9._:\-]{1,128}$`
  (printable, bounded — blocks log/HTTP header injection); anything else → fresh UUID.
- A middleware runs the whole request inside a context store and **echoes the id back in
  the response header**.
- Every log line is auto-enriched (`correlation_id`, plus `tenant_id`/`user_id` once the
  JWT guard has verified the token) via the pino `mixin` — no manual plumbing at call
  sites.
- The error envelope's `correlation_id` is **the same id** as the header (not a second
  id minted at error time).
- `audit_events.correlation_id` and `outbox_events.correlation_id` default from the
  context (explicit parameter still wins) — auth events and future producers get the
  thread for free.

**Context is telemetry, never authorization** — the store is derived from the request
only for logging; authz decisions stay with JWT verification + RLS (ADR-003).

### 3. Metrics: Prometheus text at `/metrics` (baseline)

`prom-client` registry exposed at `GET /metrics` (`@Public()`, same trust level as
`/health`):

- `http_requests_total{method,route,status}` and
  `http_request_duration_seconds{method,route}` — **route templates only**
  (`/v1/audit-events`, not concrete ids) so label cardinality stays bounded and no ids
  leak; `/metrics` itself excluded from the counter.
- Default process metrics (CPU, heap, event loop) via `collectDefaultMetrics`.
- Recorded by a global Nest interceptor covering success and error paths (error status
  derived the same way as the error filter).

This is the baseline for later alerting/Grafana; `/metrics` stays unauthenticated in P2
(local, loopback-bound). **Gate:** putting it behind auth or internal-only networking is
required before any cloud exposure (follow-up with the cloud decision D-06).

### 4. OpenTelemetry: staged, not wired yet

`OTEL_EXPORTER_OTLP_ENDPOINT` remains the reserved switch: **no OTel SDK is installed
in P2.** Rationale: there is no collector to export to (no Docker on this Windows box —
INFRA-01 constraint), the SDK + auto-instrumentation adds a heavy dependency tree for
zero consumers, and Grafana Cloud free tier would be a cloud account (founder approval
gate). Same staging pattern as BullMQ (ADR-002 §7): the seam (structured logs with
correlation + Prometheus metrics) is what a collector consumes later — wiring becomes a
config change, not a redesign.

### 5. Log transport and retention (SECURITY §7 follow-through)

Applications write JSON to **stdout only** — no file handles, no rotation logic in-app.
Local: shell redirection (e.g. `api-run.log`) is whatever the developer captures.
Production: retention/rotation is the deployment platform's responsibility and is
**explicitly deferred to the cloud decision (D-06)** — recorded here as the required
follow-up so SECURITY §7's "retention documented" points at a real owner.

## Execution note (2026-10-19)

- `packages/shared/src/logger.ts`: `LOG_LEVELS` + `resolveLogLevel()` (fail-fast,
  names the variable) + `REDACT_PATHS` + `buildPinoOptions({ level, service, mixin })`.
- API `src/observability/`:
  - `correlation.ts` — ALS store `{ correlationId, tenantId?, userId? }`,
    `sanitizeCorrelationId()`, `runInCorrelation()`, `getCorrelationId()`,
    `setCorrelationContext()` (guarded mutation for the JWT guard).
  - `correlation.middleware.ts` — sanitize/generate → echo response header → run
    handler inside the store; registered `forRoutes('*')` in `AppModule`.
  - `metrics.ts` — `MetricsService` (registry, counters, duration histogram,
    default process metrics) + `MetricsInterceptor` (APP_INTERCEPTOR) +
    `MetricsController` (`GET /metrics`, `@Public()`).
  - `pino-logger.service.ts` — `LoggerService` backed by pino so Nest boot/module logs
    are structured JSON too.
- `main.ts`: pino instance → `FastifyAdapter({ loggerInstance })` + Nest logger;
  error-envelope filter moved to `APP_FILTER` in `AppModule` (single wiring path for
  test + prod boots); filter reads the correlation id from the context.
- `config/env.ts`: `logLevel` added to `AppConfig` (validated, default `info`).
- `JwtAuthGuard`: after token verification stores `tenant_id`/`user_id` into the
  correlation context (telemetry only).
- `AuditService.record` / `OutboxService.append`: `correlationId ?? getCorrelationId()`.
- Worker: same shared options (`base.service='worker'`); dispatcher DLQ/retry logs use
  pino (loud JSON line with event id/type/tenant/attempts).
- Deps: `pino` (shared, api, worker), `prom-client` (api).
- **Completed + verified 2026-10-25:** typecheck/build green, **vitest 116/116 across
  22 files (6/6 turbo tasks)** with the DB integration suites actually running, live
  smoke (all logs valid JSON, no secret leakage, envelope id === header id,
  `/metrics` bounded to route templates and not counting itself), worker boot on the
  same options builder.
- **Test-infra finding (documented in TESTING_STRATEGY §6):** the Gate-B suite was the
  first to boot the real `AppModule`, and it failed until vitest was switched from
  esbuild to **SWC** (`apps/api/vitest.config.ts`) — esbuild cannot emit
  `emitDecoratorMetadata`, so Nest's constructor DI resolved every dependency to
  `undefined` in tests. This affected *any* full-app boot test, not ADR-008's code.

## Consequences

- **Positive:** one machine-parseable log stream with a single id threading
  ingress → logs → error envelope → audit → outbox → worker (the exact correlation
  contract in API_CONTRACTS §1/§3); redaction centralized so new apps inherit it;
  metrics baseline for alerts; level control without deploys; OTel adoption later is
  config-shaped.
- **Negative:** ALS context must never be trusted for security decisions (documented);
  `/metrics` is unauthenticated in P2 (gate recorded before cloud); pino `mixin` runs
  per log call (negligible); no traces yet (staged, §4).
- **Follow-ups:** OTel SDK + collector when one exists (D-06 cloud/Grafana decision),
  `/metrics` exposure policy for cloud, worker DLQ alerting (with observability
  consumers), log retention implementation with the deployment platform.

## Alternatives considered

- **Winston:** equally capable but slower, heavier config surface, no Fastify
  first-class fit (Fastify ships pino natively). Rejected.
- **DIY `JSON.stringify(console.log)`:** no redaction/level/mixin machinery — exactly
  the drift this ADR exists to prevent. Rejected.
- **Full OTel auto-instrumentation now:** heavy dependency tree with nowhere to export
  (no collector) and a cloud-approval gate on hosted options. Rejected for P2 — staged
  per §4.
- **Metrics behind auth:** no scraper credential story exists yet; `/health` precedent
  + loopback binding covers P2; cloud gate recorded instead. Rejected for now.
