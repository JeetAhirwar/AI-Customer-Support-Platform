# ARCHITECTURE
## AI Customer Support Platform — Phase 1 architecture (approved foundation)

| Field | Value |
|---|---|
| Status | Approved baseline — implements decisions D-01 (ADR-010), D-02 (ADR-001), D-03 (ADR-011), D-13 (ADR-013), D-14 (ADR-014) |
| Date | 2026-10-16 |
| Source documents | Software Architecture v1, PRD v1, Development Plan v1 (all DOCX, read in Phase 0) |
| Authoritative for changes | Update this file with every accepted architecture ADR |

## 1. System overview

Multi-tenant SaaS: businesses subscribe and configure their own knowledge, channels, queues, AI behavior, and escalation rules. Three channels — website chat, email, inbound voice — feed **one canonical conversation/case domain**. AI resolves eligible queries grounded in approved tenant knowledge; everything else escalates to human agents with full context.

## 2. Architecture style (ADR-010)

**Modular monolith + separately deployed workers + voice runtime + static widget.** Service-shaped module boundaries with an always-open extraction path. Not a microservice fleet — and not a big ball of mud.

```
[Chat Widget (static bundle, CDN)]        [Admin + Agent SPA (React/TS)]
         | HTTPS/WSS                              | HTTPS/WSS
         +-------------------+--------------------+
                             |
              [ API application — NestJS modular monolith (Fastify) ]
   ┌────────────┬─────────────┬──────────────┬──────────────┬──────────────┐
   │ identity   │ tenant+rbac │ conversation │  knowledge   │ ai-orchestration │
   │ customers  │ routing     │   (cases)    │  (RAG)       │ integrations │
   │ channels   │ audit       │ notifications│  analytics   │ (tool gateway)│
   └────────────┴─────────────┴──────────────┴──────────────┴──────────────┘
        |                    |                       |
 [Worker process]     [Voice runtime (P5)]     [PostgreSQL 17 + pgvector]
  outbox dispatch,      mock → real provider    operational truth + outbox
  indexing, email,      (D-06 open)             tables + RLS (ADR-003)
  retries, DLQ, analytics      |                       |
        |                 [Redis — cache, rate limits, BullMQ dispatch]
        +----------[SeaweedFS — private files/attachments, signed URLs (S3 API; local MinIO substitute, D-15)]
                             |
                [OpenTelemetry → logs / metrics / traces]
```

## 3. Deployable units

| Unit | Process | Contents |
|---|---|---|
| API application | 1 | NestJS modular monolith: HTTP + WebSocket endpoints, domain modules |
| Worker | 1+ | Outbox dispatcher, knowledge indexing, email sending, analytics aggregation, retries/DLQ, scheduled jobs |
| Voice runtime | 1 (P5) | Call state machine, speech pipeline, transfer, provider callbacks — isolated for latency |
| Chat widget | static | ≤50 KB bundle (Preact/vanilla TS), CDN, token-authenticated sessions |

## 4. Approved technology baseline (all ADRs linked)

| Layer | Choice | ADR |
|---|---|---|
| Frontend | React + TypeScript (Vite); claymorphism styling on blueprint tokens | ADR-014 |
| Backend | TypeScript, NestJS on Fastify | ADR-001 |
| Database | PostgreSQL 17 + pgvector; migrations; RLS defense-in-depth | ADR-003 (planned) |
| Queue | Transactional outbox (Postgres) → BullMQ on Redis; DLQ | ADR-002 (planned) |
| Cache/limits | Redis (Windows port locally, 8.10.2; Memurai plan superseded) | ADR-011 |
| Retrieval | Hybrid: Postgres FTS + pgvector behind retrieval interface | ADR-005 (planned) |
| Object storage | SeaweedFS (S3 API) locally → S3/R2 at P7 (MinIO unavailable, D-15) | D-15 |
| AI | Own pipeline + provider adapter; mock providers until spending cap approved | ADR-004 (P3) |
| Email | Adapter + Mailpit locally; provider decision P4 | ADR-007 (P4) |
| Voice | Mock adapter first; provider decision P5 (geography D-06) | ADR-006 (P5) |
| Observability | OpenTelemetry + pino (redacted) + Prometheus metrics | ADR-008 (planned) |
| AuthN | Own identity module: Argon2id, JWT access + rotating refresh, MFA-ready | SECURITY.md |
| Local infra | Native Windows services on E: (conditional) | ADR-011 |
| Version control | Git; no commits without separate authorization | ADR-012 |

## 5. Core flows (summary; details per channel in API_CONTRACTS.md)

**Chat (Phase 3, first vertical slice):** widget session (signed, origin-allowlisted, rate-limited) → normalize + persist message *idempotently before AI work* → orchestration pipeline (§6) → answer/clarify/abstain/handoff → send via channel adapter → outcome events. Human takeover locks AI sending to prevent conflicting responses.

**Async (all channels):** API transaction persists domain change + **outbox event atomically** → outbox dispatcher publishes durable job → worker claims with idempotency key → retries with backoff/jitter, capped attempts → dead-letter terminal failures with alert. Never "write-then-publish" as two unrelated operations.

**Email (P4)** and **Voice (P5)** follow Architecture v1 §5.2/§5.3: webhook signature verification, provider-event deduplication, conservative thread matching / call state machine, transfer with fallback.

## 6. AI orchestration pipeline (PRD §7.1, Architecture v1 §6)

Deterministic, ordered, fully logged to `ai_decisions` (config/model version, source IDs, latency, cost, decision, escalation reason):

1. Resolve tenant, channel, case, identity, config version
2. Deterministic policy + eligibility checks
3. Intent classification / human-request detection
4. Retrieve approved knowledge — **tenant + publication + locale filters enforced in SQL**, not in the prompt
5. Bounded prompt: policy + retrieved passages + minimal conversation context
6. Model call with timeout, token/cost budget, provider fallback (mock provider in P2–P3 dev)
7. Validate: grounding, policy, privacy, action authorization, format
8. Decide: **answer | clarify | safe fallback | handoff**
9. Persist decision + source refs + versions
10. Send via channel adapter + emit evaluation events

Safety rails: only published/approved knowledge retrievable in production; no-answer path always exists; user messages, retrieved docs, emails = untrusted data (prompt injection cannot override policy/tools/tenant boundaries); tool calls allowlisted + schema-validated + audited; AI autonomy follows the ladder (offline → shadow → agent-assist → limited auto-send) with per-tenant/channel kill switch (ADR-009).

## 7. Multi-tenancy (see SECURITY.md for full model)

Every tenant-owned row carries `tenant_id`; repository layer enforces tenant predicates on every query; **PostgreSQL RLS as defense-in-depth** (ADR-003); negative cross-tenant tests are a CI release gate (QA-005). Tenant context is resolved server-side from authenticated membership or validated channel mapping — never trusted from client input.

## 8. Environments

Local (synthetic data only; native services on E:) → CI (lint/type/unit/secret+dependency scans) → Development → Staging (provider sandboxes, test tenants/numbers) → Production (feature flags, canary, rollback, kill switch). Backward-compatible migrations only (expand → deploy → backfill → contract).

## 9. Scaling and extraction path

Vertical scale of the single API + workers covers pilot and early growth. Extraction triggers (measured, not speculative): sustained load imbalance between modules, independent release cadence needs, team ownership boundaries. First likely extractions: **voice runtime** (already separate) and **AI orchestration** (heavy async). Everything else stays monolith until evidence says otherwise.

## 10. Documentation map

`SERVICE_BOUNDARIES.md` (module contracts) · `DATABASE_DESIGN.md` · `API_CONTRACTS.md` · `SECURITY.md` · `TESTING_STRATEGY.md` · `LOCAL_DEVELOPMENT_SETUP.md` · `ENVIRONMENT_VARIABLES.md` · `adr/` (decision history) · `DECISIONS_PENDING.md` (open: D-04…D-12, D-09).
