# ADR-002: Queue and transactional-outbox pattern

- **Status:** ACCEPTED (2026-10-19, executed — see execution note)
- **Acceptance basis:** Pre-qualified in `TECH_STACK_EVALUATION.md` (recommended async
  path) and `ARCHITECTURE.md` (queue row, async flow); executed under the Phase-2
  Foundation mandate (founder 2026-10-16). ADR numbering reserved since Architecture v1 §5.4.
- **Deciders:** founder (mandate), technical delegation per established policy
- **Date:** 2026-10-19
- **Supersedes / amends:** —
- **Related:** ADR-010 (worker process), ADR-003 (two-role DB model), DATABASE_DESIGN §5
  (`outbox_events`), API_CONTRACTS §3 (event envelope), TESTING_STRATEGY Gate B

## Context

Every domain change that must trigger downstream work (email send, AI decision,
analytics, webhooks) needs the classic dual-write problem solved: the business
row and the "something happened" signal must never diverge. Publishing to a
queue *after* committing the business transaction loses events on crashes;
publishing *before* risks phantom events on rollback. The reliability policies
(PROJECT_DISCOVERY_REPORT: "transactional outbox, retries with backoff + DLQ,
no silent message loss") forbid both.

## Decision

**Postgres transactional outbox table (`outbox_events`) is the durability source
of truth; a worker dispatches from it by polling. Redis/BullMQ is a staged
optimization *behind* the outbox, never a replacement for it.**

### 1. Atomic append

`OutboxService.append(client, event)` runs **inside the caller's business
transaction** (the same connection/scope that wrote the domain rows). Commit
publishes the event; rollback erases it — atomically, by construction. No
"write-then-publish" of two unrelated operations (ARCHITECTURE §async).

### 2. Dispatch = claim in a transaction (worker process, owner role)

The dispatcher claims a batch with `SELECT … WHERE state='pending' AND
next_attempt_at <= now() ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED`,
runs the handler for each row, and finalizes (`published` / retry / `dead`)
**in the same transaction**. A crash mid-batch rolls back → rows stay
`pending` → reclaimed next tick; no stuck `processing` states, no reaper job.
`SKIP LOCKED` makes concurrent workers safe without coordination.

The worker connects with the **table-owner role** (`WORKER_DATABASE_URL`,
`aicsp`) for the same reason migrations do (ADR-003): claiming is
deliberately cross-tenant (a worker drains all tenants), and RLS tenant
policies would block it. The bypass is explicit, infrastructure-only, and the
API role stays INSERT-only on the table (below).

### 3. Retries, backoff, DLQ

- `attempts` increments at claim time; handler success → `state='published'`,
  `published_at=now()`.
- Handler failure → row returns to `pending` with
  `next_attempt_at = now() + min(base · 2^(attempts−1), cap) + jitter(0..base)`
  (jitter breaks thundering herds).
- `attempts ≥ max_attempts` → `state='dead'` (DLQ): logged loudly, alert-ready;
  never silently dropped. Recovery from `dead` is an operator action.

### 4. Delivery semantics and idempotency

Delivery is **at-least-once** (a rolled-back batch re-runs handlers; external
side effects can't be rolled back). Handlers MUST be idempotent keyed on
`event_id`. There is no separate idempotency-key column (DATABASE_DESIGN §5) —
the event id *is* the key, and consumers dedupe on it.

### 5. Event contract

Envelope per API_CONTRACTS §3: `{ event_id, tenant_id, type, schema_version,
occurred_at, correlation_id, payload_ref | payload }`; catalog and compatibility
rules live there. `X-Correlation-ID` from ingress flows into `correlation_id`
and onward to logs/traces/downstream calls. `payload_ref` in P2 holds a small
serialized JSON payload string (no message bodies — same discipline as
audit_events); when object storage lands (P3) large payloads move to storage
URIs and the column becomes a true reference. Consumers treat it opaquely.

### 6. Handler partitioning

A dispatcher claims **only event types it has registered handlers for** —
unhandled types stay `pending` for other workers (email worker, indexing
worker, …). Multiple workers partition the stream by type without shared state.

### 7. Redis/BullMQ staging (deferred)

Local-first: Postgres alone runs the queue (polling latency is fine at P2
volume; TECH_STACK_EVALUATION "Redis optional until needed"). BullMQ/Redis
hot-dispatch is added when measured volume needs it — the outbox remains the
truth either way; the dispatcher just publishes claimed events to Redis
instead of (or in addition to) in-process handling.

## Execution note (2026-10-19)

- Migration `006_outbox` (dev + test DB): `outbox_events(id, tenant_id, type,
  schema_version, payload_ref, correlation_id, state, attempts,
  next_attempt_at, created_at, published_at)` per DATABASE_DESIGN §5 —
  `CHECK (state IN ('pending','published','dead'))`, partial claim index
  `(next_attempt_at) WHERE state='pending'` (deliberately global: claiming is
  cross-tenant by design), tenant diagnostics index `(tenant_id, type,
  created_at)`; RLS tenant policy (same fail-closed `NULLIF` shape as 004/005)
  + `REVOKE UPDATE, DELETE … FROM aicsp_app` (API role is append-only).
- API: `OutboxModule` (global leaf) — `append(client, event)` takes the
  caller's transaction client; no public read endpoint (outbox is plumbing).
- Worker: `OutboxDispatcher` claims with `FOR UPDATE SKIP LOCKED` per-batch
  transactions as the owner role (`WORKER_DATABASE_URL`), handler registry by
  type, exponential backoff + jitter + DLQ per §3.
- Gate-B tests: append atomicity (rollback erases), RLS isolation + append-only,
  exactly-once claim under concurrent dispatchers, retry→backoff→DLQ chain,
  unhandled types left pending, cross-tenant drain, correlation propagation.

## Consequences

- **Positive:** no lost or phantom events by construction; restart-safe with
  zero extra infra; retries/DLQ first-class; extraction-friendly (worker is a
  separate deployable per ADR-010); BullMQ can slot in later without changing
  producers.
- **Negative:** polling adds latency (ms–s scale; acceptable) and a poll load
  on Postgres (indexed partial claim; fine at P2 volume); at-least-once
  demands handler idempotency (documented contract for every handler author);
  two DB roles to reason about (already the ADR-003 model).
- **Follow-ups:** producer wiring in the cases slice (`case.created` etc.),
  email worker consuming `email.delivery.failed` (P4), BullMQ hot dispatch
  when volume demands (§7), DLQ alerting with observability slice.

## Alternatives considered

- **Redis/BullMQ alone:** feature-rich but not transactional with Postgres —
  reintroduces the dual-write problem; Redis durability requires tuning.
  Rejected as *primary*; acceptable *behind* the outbox (§7).
- **pg-boss:** zero-infra and transactional, but a third-party queue semantics
  surface with less maturity; kept as documented fallback only
  (TECH_STACK_EVALUATION).
- **LISTEN/NOTIFY push instead of polling:** lower latency, but notifications
  are not durable (lost on disconnect) — still needs the outbox table; adds
  complexity for no durability gain. Rejected for P2.
