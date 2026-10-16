# TECHNOLOGY STACK RECOMMENDATION
## AI Customer Support Platform — PROPOSED, AWAITING APPROVAL

> **Status: NEEDS APPROVAL.** Nothing below has been implemented. No dependencies installed, no accounts created, no cloud resources provisioned. Supporting analysis: `TECH_STACK_EVALUATION.md`. Requirements cross-checked against all 5 DOCX documents (see `PROJECT_DISCOVERY_REPORT.md` §2).

## Approval and implementation guardrails

- All architecture and stack selections remain **provisional until explicitly approved** by the founder. (2026-10-16: D-01, D-02, D-03, D-07, D-13 have *tentative founder selections* recorded in `DECISIONS_PENDING.md` — awaiting one explicit confirmation before being treated as approved.)
- Initial AI development must use **mock providers and deterministic test fixtures**. No paid API calls without a separately approved spending limit.
- Local infrastructure installation requires approval and verification of disk capacity, permissions, and compatibility. (E: space and permissions verified 2026-10-16; installation itself not yet authorized.)
- Git initialization requires explicit approval. No commits, remote configuration, or pushes without separate authorization.
- Do not install dependencies, modify source code, provision cloud resources, or create external service accounts before the relevant approval.
- Decisions D-04 through D-12 remain **open** unless separately resolved and recorded.

---

## 1. The recommended stack (one page)

| Layer | Recommendation | Maps to document requirement |
|---|---|---|
| **Monorepo** | pnpm workspaces + Turborepo (git, initialized with your approval) | Docs' single-codebase modular monolith + shared contracts |
| **Frontend (admin + agent workspace)** | React 18+ / TypeScript / Vite, component library with tokens from UI/UX Blueprint (navy #14233B, blue #246BFD, teal #11A6A0), WCAG 2.2 AA | Arch §3 "React + TypeScript"; UI/UX §8–9 |
| **Chat widget** | Separate ≤50 KB bundle (Preact or vanilla TS + Vite), CDN-hosted, token-authenticated sessions | Arch §2 "Static frontend hosted via CDN" |
| **Backend (one primary stack)** | **TypeScript on NestJS (Fastify adapter)** — modular monolith with strict module boundaries; separately deployed worker process; separate voice runtime process at P5 | Arch §3 "choose one primary backend stack"; §2 deployable units |
| **Primary database** | **PostgreSQL 17 + pgvector**, migrations via node-pg-migrate or Prisma Migrate; RLS as defense-in-depth for tenant isolation | Arch §3, ADR-003/005 |
| **Async processing** | **Transactional outbox (Postgres) → BullMQ on Redis** dispatch; retries+backoff+jitter, DLQ; pg-boss as zero-infra fallback if Redis deferred | Arch §5.4, ADR-002 |
| **Cache / rate limits** | Redis (native Windows/Memurai on E:) | Arch §3 |
| **Search / retrieval** | Hybrid: Postgres FTS (tsvector+trgm) + pgvector semantic, behind a retrieval interface | Arch §6, ADR-005 |
| **Object storage** | MinIO (S3 API) locally on E: → S3/R2 at P7, private buckets + signed URLs | Arch §3 |
| **AuthN/AuthZ** | Own identity module: Argon2id, JWT access + rotating refresh, email verification/reset, MFA-ready, RBAC + resource-scoped server-side checks, `identity_provider_id` abstraction for future SSO | PRD FR-002, Arch §4/§7 |
| **Real-time** | Native WebSockets (ws) with short-lived session tokens; SSE for presence | PRD FR-006 |
| **AI orchestration** | Own pipeline module implementing Arch §6 exactly: policy → intent → retrieve (tenant+published filters in SQL) → bounded prompt → generate (budget/timeout/fallback) → validate (grounding, privacy, allowlist) → answer/clarify/abstain/handoff → persist `ai_decisions` with source IDs, model/config version, latency, cost | PRD §7, Arch §6 |
| **LLM/embeddings** | Thin **provider adapter interface**; primary provider chosen by eval benchmark — shortlist **OpenAI + Anthropic** (decision D-04 at P3; requires your key + budget approval) | ADR-004 |
| **Email (P4)** | `EmailProviderAdapter`; local dev via **Mailpit** (mock, free); production primary chosen at P4: MS Graph / Gmail API / Postmark inbound | ADR-007 |
| **Voice (P5)** | `VoiceProviderAdapter`; **mock call engine first** (explicitly labeled); real provider chosen at P5 after geography decision: Twilio/Telnyx/Vonage or Exotel/Knowlarity (India) | ADR-006, D-06 |
| **Observability** | OpenTelemetry traces + pino structured logs (correlation IDs everywhere, redaction) + Prometheus metrics; Grafana stack when Docker available | Arch §3/§10, ADR-008 |
| **Testing** | Vitest (unit/integration), Supertest-style API tests, Playwright E2E (+axe accessibility), contract tests from OpenAPI, **AI eval harness (versioned JSONL sets, CI-gated)**, gitleaks + npm audit in CI, k6 at P7 | PRD §13, Arch §12, Gates A–E |
| **Local dev (Windows-first)** | Native services installed on **E:** — PostgreSQL 17 zip, Memurai/Redis, MinIO, Mailpit; pnpm via corepack; VS Code workspace. Docker Desktop adopted when C: drive space is freed (~15–25 GB) | Discovery §4 (C: ≈1.2 GB free) |
| **Cloud & CI/CD (P7)** | GitHub Actions CI from day 1; cloud **AWS (ECS Fargate + RDS + S3 + Secrets Manager)** preferred, GCP/Azure viable — final pick later with your approval; **Terraform** IaC; no Kubernetes until justified | Arch §3/§11, docs' managed-services rule |

## 2. Why this stack — top reasons

1. **It is your own architecture document's baseline.** Arch v1 §3 recommends exactly: React+TS, one backend (TS NestJS/Fastify *or* Python FastAPI), managed Postgres, pgvector first, durable queue with DLQ, Redis, S3-compatible storage, provider adapters, OpenTelemetry. This stack implements that baseline without deviation, so approval = no hidden surprises.
2. **One language (TypeScript) everywhere** — frontend, backend, widget, contracts, eval tooling. Node 22 is already installed; zero new toolchains needed for day 1. Python stays available for future offline jobs only if justified (avoids the dual-stack domain-logic duplication your docs warn against).
3. **Windows-first local reality.** No Docker + nearly-full C: drive means compose-based setups are blocked today. Native Postgres/Redis/MinIO/Mailpit binaries on E: get Phase 2 running this week with no admin rights and no C: usage. Docker is adopted mid-project when disk allows (with your approval), keeping cloud parity intact.
4. **Multi-tenant security built into the bones:** Postgres RLS as defense-in-depth + mandatory tenant predicates in repositories + server-side authz + negative cross-tenant tests (QA-005) as a CI gate from Phase 2 — satisfying PRD FR-001/FR-002 and Architecture §7.
5. **AI safety designed in, not bolted on:** the pipeline implements the doc's 10-step orchestration, outbox-based audit of every AI decision, versioned eval harness gating every prompt/model/retrieval change (PRD §7.3, Gate D), and the autonomy ladder (offline → shadow → assist → limited auto-send) with per-tenant kill switch.
6. **Right-sized operations:** modular monolith + workers + voice runtime = 3–4 deployables, not 15. Managed everything at P7. This is the single biggest delivery-risk reducer for a small team (Arch §17 "Overengineering too early").

## 3. Architecture shape (pending D-01)

```
[Chat Widget (CDN)]   [Admin/Agent SPA (React)]
        |                      |
   HTTPS/WSS              HTTPS/WSS
        \                      /
         [ API application — NestJS modular monolith ]
          modules: identity • tenant • rbac • conversation/case
                   routing/queues • knowledge • ai-orchestration
                   channels(chat/email adapters) • audit • analytics
                   notification • integrations(tool gateway)
        |                    |                    |
 [Worker process]     [Voice runtime (P5)]   [PostgreSQL+pgvector]
  outbox dispatch,          |                 (outbox tables included)
  indexing, email           |                      |
  sending, analytics   [VoiceProviderAdapter]  [Redis: cache/limits/
  retries/DLQ          (mock → real provider)   BullMQ dispatch]
        \____________________|______________________|
                     [MinIO / S3 — files, attachments, exports]
                     [OpenTelemetry → logs/metrics/traces]
```

Whether this is a **modular monolith (recommended, Option A')** or a **literal microservice fleet (Option B)** is Decision **D-01** — both are fully specified in `PROJECT_DISCOVERY_REPORT.md` §9. This stack supports either; the difference is deployable count and repo wiring, not technology.

## 4. What I explicitly do NOT recommend (and why)

| Rejected | Reason |
|---|---|
| Python FastAPI backend | Second stack for a small team; contract drift with React frontend; docs require *one* primary backend |
| Kubernetes now | Docs list it as a non-goal until scale proves need |
| Dedicated vector DB (Pinecone/Qdrant) now | pgvector covers pilot scale; adds ops + cost; benchmark first (ADR-005) |
| Kafka | Wrong scale/ops weight |
| SaaS auth vendor now | Lock-in + per-seat cost before revenue; abstraction leaves door open |
| Local LLM (Ollama) | No GPU here; quality/latency risk for voice turns |
| Supabase/Firebase backend | Multi-tenant B2B domain needs custom authorization semantics; poor fit |

## 5. Expected costs (estimates, nothing purchased)

| Item | Local/dev phase (P2–P6) | Pilot phase (P7) |
|---|---|---|
| Postgres/Redis/MinIO/Mailpit/VS Code/Git/pnpm | **Free** | — |
| LLM API (dev + eval harness) | ~$20–100/month depending on eval volume (your key, spend cap advised) | per-usage; budget alert required |
| Embeddings | ~$1–5/month at dev volume | scales with KB size |
| Email (Mailpit) | Free | Provider: ~$0–35/month + usage |
| Telephony | Free (mock) | Number ~$1–5/month + per-minute (provider/geography dependent) |
| Cloud staging/prod | Free tier / nothing | ~$100–400/month conservative managed setup |
| Domains | — | ~$10–15/year |
| Monitoring | Free tiers / self-hosted | Free tier likely sufficient at pilot |

All paid items require your explicit approval before provisioning (per Master Prompt §7/§8).

## 6. Open decisions still remaining

See `DECISIONS_PENDING.md` for the live list. Stack-critical ones: **D-01 architecture style**, **D-02 backend language**, **D-03 local infra strategy**, **D-07 git init**. Deferred (not blocking P2): LLM provider (P3), email provider (P4), telephony provider + geography (P5), cloud provider (P7), segment/pricing (pilot).

## 7. Upon approval — exactly what happens next

1. `git init` + `.gitignore` + root `README.md` + `.env.example` (placeholders only) — **no commits/pushes** without your authorization.
2. Write Phase-1 docs: `ARCHITECTURE.md`, `SERVICE_BOUNDARIES.md`, `SECURITY.md`, `DATABASE_DESIGN.md`, `API_CONTRACTS.md`, `ENVIRONMENT_VARIABLES.md`, `LOCAL_DEVELOPMENT_SETUP.md`, `TESTING_STRATEGY.md`, ADR-001…009 (decisions resolved into records).
3. Install local infra on **E:** (Postgres 17 + Redis + MinIO + Mailpit) exactly per `LOCAL_DEVELOPMENT_SETUP.md` — with your go-ahead per D-03.
4. Start **Phase 2 Foundation**: repo/CI, auth+tenancy+RBAC, case/message schema, audit, outbox/queue, health checks — closing with cross-tenant negative tests passing (Plan S1–S2 exit gate).
