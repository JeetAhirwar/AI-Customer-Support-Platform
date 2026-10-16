# PROJECT DISCOVERY REPORT
## AI Customer Support Platform — Phase 0 (Discovery)

| Field | Value |
|---|---|
| Report date | 2026-10-15 |
| Project root | `E:\AIknotsit-Office-Work\AI-Customer-Support-Platform` |
| Documentation dir | `E:\AIknotsit-Office-Work\AI-Customer-Support-Platform\Documentation` |
| Git repository | **Not initialized** (project root is not a git repo) |
| Status | Phase 0 COMPLETE — awaiting product-owner approval of tech stack & architecture before any application code |

---

## 1. Project files and folders inspected

```
E:\AIknotsit-Office-Work\AI-Customer-Support-Platform\
└── Documentation\
    ├── AI_Customer_Support_Platform_Development_Implementation_Plan_v1.docx
    ├── AI_Customer_Support_Platform_PRD_v1.docx
    ├── AI_Customer_Support_Platform_Problem_Solution_Brief.docx
    ├── AI_Customer_Support_Platform_Software_Architecture_v1.docx
    └── AI_Customer_Support_Platform_UI_UX_Blueprint_v1.docx
```

- The project root contains **only** the `Documentation` folder. There is **no existing source code, configuration, or infrastructure**.
- Verified: correct project root, readable/writable, Windows environment (Windows 11 build 26100, PowerShell 5.1).

## 2. Documents found and read (all 5 mandatory DOCX files)

Extraction method: each `.docx` (OOXML/ZIP) was parsed with a dependency-free Python script reading `word/document.xml`, including **all paragraphs and tables in document order**. No embedded media/objects were present in any file, so no content was skipped.

| # | Exact filename | Read status | Size (extracted) | Key requirements summarized |
|---|---|---|---|---|
| 1 | `AI_Customer_Support_Platform_Problem_Solution_Brief.docx` | ✅ SUCCESSFULLY READ (complete) | 13,554 chars | Concept: multi-tenant, configurable **AI-first support platform** across **chat, email, inbound voice**. AI attempts eligible requests; escalates on missing evidence, low confidence, sensitive topics, or actions needing approval. **Recommends narrow MVP: one segment + one primary channel first** (contradiction #2 below). Target example: 15 agents (5 chat / 5 email / 5 voice). Safety rules, success metrics (resolution rate, escalation rate, CSAT, cost per resolution), commercial-model hypothesis (subscription + usage pricing), key risks, assumptions to validate. |
| 2 | `AI_Customer_Support_Platform_PRD_v1.docx` | ✅ SUCCESSFULLY READ (complete) | 34,163 chars | Build-oriented spec. Roles (tenant owner, support admin, agent, team lead, knowledge manager, platform operator). User journeys: admin onboarding, customer conversation, human agent handoff. **25 functional requirements FR-001…FR-025** with P0/P1/P2 priority (P0 = required for initial production pilot), each with acceptance criteria. Channel requirements for chat/email/voice. AI behavior policy with **7 mandatory escalation triggers** and AI evaluation requirements (versioned eval sets, prompt-injection tests, human review before prod changes). Data model entities, non-functional requirements (security/privacy/reliability/performance/observability). **16 QA acceptance scenarios QA-001…QA-016**. Release plan Stage 0→3. Delivery plan for a 20-person team. 8 open decisions (segment, countries/languages, providers, AI model, hosting, retention policy, pilot thresholds). |
| 3 | `AI_Customer_Support_Platform_Software_Architecture_v1.docx` | ✅ SUCCESSFULLY READ (complete) | 36,155 chars | **Executive recommendation: modular monolith + async workers — NOT a microservices fleet** (see contradiction #1). Channel adapters → common case domain → AI orchestration (policy → retrieve → generate → validate → answer/clarify/handoff) → durable async queue with **transactional outbox** → PostgreSQL (+pgvector), object storage, Redis (optional). Tech baseline: React+TypeScript frontend; **one** primary backend (NestJS/Fastify TS *or* FastAPI Python); managed PostgreSQL; pgvector first; provider adapter layers for LLM/telephony/email; OpenTelemetry observability. Domain module ownership table, core flows (chat/email/voice/async), AI RAG pipeline (10 steps), AI autonomy modes (suggest-only / approve-before-send / auto-send-in-scope), multi-tenancy & security controls table (RLS as defense-in-depth), initial logical data model (~20 entities), API conventions + example endpoints, event catalog, reliability policies, deployment environments, testing strategy, **ADRs 001–009 to create**, phased plan Phase 0–6. |
| 4 | `AI_Customer_Support_Platform_UI_UX_Blueprint_v1.docx` | ✅ SUCCESSFULLY READ (complete) | 29,411 chars | Screen-by-screen blueprint. Information architecture (8 nav groups), app shell, responsive breakpoints. **14 core screen specs (5.1–5.14)** with layout, states, and interactions: sign-in, setup wizard, overview dashboard, unified inbox, case workspace, AI handoff panel, agent queue, knowledge base, AI behavior settings, chat/email/voice channel setup, analytics, team/audit. 4 end-to-end journeys (chat, email, voice, admin publish). Design system tokens (navy #14233B, primary blue #246BFD, teal #11A6A0, canvas #F4F6FA, spacing/radius/type). **WCAG 2.2 AA accessibility target.** Product-analytics event instrumentation (no sensitive content). P0/P1/P2 screen priorities, 6-sprint design plan, design-QA checklist, 6 decisions to confirm before hi-fi design. |
| 5 | `AI_Customer_Support_Platform_Development_Implementation_Plan_v1.docx` | ✅ SUCCESSFULLY READ (complete) | 23,289 chars | Delivery roadmap: **~16–20 weeks to controlled pilot**, two-week sprints S0–S9, vertical slices **chat first → email → voice**. Architecture assumption restated: modular monolith + separately deployed workers/channel adapters. Team ownership (DRI per workstream), work-breakdown per channel, DoR/DoD, **release gates A–E** (PR/CI, integration, E2E, AI quality, pilot readiness), minimum pre-pilot scenarios checklist (incl. cross-tenant isolation), **AI autonomy rollout ladder: internal offline → shadow mode → agent assist → limited auto-send → expanded automation**, pilot metrics & stop conditions, first-10-days action plan. |

**Milestone 1 status: COMPLETE.** All 5 mandatory DOCX documents located, opened, fully extracted, and read, including all tables. No content was inaccessible.

## 3. Missing, incomplete, or contradictory requirements

### Contradiction 1 — ARCHITECTURE STYLE (must be resolved by you before Phase 1)
- **Master Project Prompt:** "The application **must** use a deliberate microservices architecture."
- **Software Architecture v1 (and Implementation Plan v1):** "Start with a **modular monolith, not a microservices fleet**. Extract services only when scale or ownership justifies it." Non-goal: "Full microservices… before product-market evidence."
- These directly conflict. See §9 Decision D-01 for the two options and my recommendation.

### Contradiction 2 — MVP CHANNEL SCOPE (minor, staging decision)
- **Problem/Solution Brief:** MVP should include *one* primary channel first (chat *or* email), defer voice.
- **PRD / Architecture / Implementation Plan:** All three channels are in the initial release plan, delivered *sequentially* (chat → email → voice) with voice validated early via a technical spike.
- Resolution suggestion: treat the Brief's advice as "one channel fully vertical first," then add email/voice in the same release train — consistent with the Implementation Plan's phasing. Needs your confirmation.

### Incomplete / not yet decided (documented as open in the source docs themselves)
1. **Target customer segment** — not chosen (PRD §16).
2. **Target countries / languages** — not decided; affects telephony, compliance, speech quality (PRD §16).
3. **LLM / embedding provider** — deliberately unchosen; adapter required (PRD §16, ADR-004).
4. **Telephony provider** — unchosen (ADR-006). *Note: team appears India-based; India-specific providers (Exotel/Knowlarity) vs global (Twilio/Vonage/Telnyx) is a real decision.*
5. **Email provider** — unchosen (ADR-007).
6. **Cloud/hosting provider** — unchosen (PRD §16, ADR-003 impact).
7. **Retention / recording / consent policy** — undefined; legal review needed before voice pilot (PRD §16).
8. **Pilot success thresholds** — must be agreed numerically before pilot (PRD §16, Plan §13).
9. **Real team size/capacity** — all plans assume a ~20-person team; the actual delivery team for this repo is not stated. This materially affects the timeline and phasing.
10. **Billing/subscription scope** — deferred; PRD does not require it for MVP; master prompt says "when approved."

## 4. Existing code and technology, if any

**None.** No source code, no `.git`, no configs, no CI. Greenfield project.

Local machine environment (verified read-only, nothing installed/changed):

| Tool | Status | Version |
|---|---|---|
| Windows | 11 (build 26100), PowerShell 5.1 | — |
| Git | ✅ installed | 2.39.0 |
| Node.js | ✅ installed | v22.23.1 (LTS) |
| npm | ✅ installed | 10.9.8 |
| Python | ✅ installed | 3.14.5 |
| Java | ✅ installed | 17.0.12 |
| VS Code | ✅ installed | — |
| Docker / docker-compose | ❌ **NOT installed** | — |
| pnpm | ❌ not installed (installable via corepack, no admin needed) | — |
| PostgreSQL / Redis | ❌ not installed | — |
| Disk | ⚠️ **C: drive has only ~1.2 GB free**; E: (project drive) has ~257 GB free | — |

**Impact:** Docker Desktop installs to C: by default and needs ~10+ GB — currently **not feasible without freeing C: space or relocating data**. Local Postgres/Redis/S3-compatible storage must therefore either (a) be installed as native Windows binaries on E:, or (b) wait for Docker availability. This is factored into the stack recommendation (ADR-002/005 below and `TECH_STACK_RECOMMENDATION.md`).

## 5. Product features and business workflows understood

- **Multi-tenant B2B SaaS**: each customer business = tenant with isolated knowledge, config, users, queues, AI behavior, channels, analytics, retention.
- **Three channels, one canonical case model**: website chat widget, email, inbound voice — all funnel into the same conversation/case domain with channel-specific adapters.
- **AI-first, safety-first**: policy checks → intent classification → retrieval from *approved, tenant-scoped, published* knowledge only → grounded generation → validation → answer / clarify / abstain / escalate. No invented answers; source references stored with every answer.
- **7 mandatory escalation triggers** (customer asks human, unsupported/conflicting knowledge, repeated failure, insufficient identity, sensitive/high-impact, integration failure/ambiguity, quality threshold not met).
- **Human agent workspace**: unified inbox, case timeline (customer/AI/agent messages, internal notes, tool events), AI summary + suggested replies, assignment/transfer/resolve, SLA, escalation reason panel.
- **AI autonomy ladder**: suggest-only → approve-before-send → limited auto-send (per tenant, per channel, per intent, feature-flagged, kill-switchable).
- **Knowledge lifecycle**: draft → ingest/index (async, versioned) → review/approve/publish → stale detection → archive; only published content used for production answers.
- **Admin capabilities**: setup wizard, roles/RBAC, channel setup + test modes, AI behavior config with test-set gate before publish and rollback, audit log, retention controls, analytics with honest metric definitions (AI-handled ≠ AI-resolved).
- **Reliability**: webhook signature verification, idempotency/dedup, retries with backoff + DLQ, transactional outbox, provider-outage fallbacks, no silent message loss, no false success claims.

## 6. Major technical risks and unresolved questions

| # | Risk / question | Why it matters | Mitigation direction |
|---|---|---|---|
| R1 | Architecture style conflict (microservices vs modular monolith) | Determines whole repo layout, CI/CD, ops burden for a small team | Decision D-01 below |
| R2 | Voice channel latency + telephony constraints | Highest technical uncertainty; can reshape architecture | Early spike (mock-first; real provider after approval) |
| R3 | AI quality/hallucination | Core product trust | Approved-source grounding, eval harness from day 1, autonomy ladder, kill switch |
| R4 | Cross-tenant data leakage | Catastrophic for a commercial SaaS | tenant_id on every row, server-side checks, pg RLS defense-in-depth, mandatory negative tests (QA-005) |
| R5 | No Docker + almost-full C: drive | Local dev parity and infra setup | Native Windows binaries on E: (recommended) or free C: space / WSL2 |
| R6 | Timeline assumes ~20-person team | 16–20 week pilot estimate unrealistic for smaller team | Re-baseline after stack approval; phases stay, dates flex |
| R7 | Prompt injection via messages/emails/documents | Security & policy bypass | Untrusted-data handling, tool allowlists, output validation, injection tests (QA-013) |
| R8 | Uncontrolled LLM/telephony cost | Margin erosion | Per-tenant budgets, token caps, cost dashboards, token/cost fields on ai_decisions |
| R9 | Email threading/deliverability + voice consent law | Customer-visible failures, legal exposure | Provider spikes; consent/retention policy before voice pilot |
| R10 | Provider lock-in | Migration cost | Adapter interfaces + contract tests (docs mandate this) |

## 7. Proposed implementation phases (aligned with all 5 docs)

The docs' plans are highly consistent; merged into one roadmap (finalized after stack approval):

| Phase | Scope | Source alignment | Exit criteria |
|---|---|---|---|
| **P0 Discovery** *(done now)* | Read all docs, discovery report, stack proposal | Master prompt, Plan Phase 0 | This report + your approval |
| **P1 Architecture & approval** | ADRs 001–009, service boundaries, security model, API contracts, eval strategy | Arch §15, Plan S0 | Stack + architecture approved |
| **P2 Foundation** | Repo/CI, auth, tenants, RBAC, case/message schema, audit, outbox+queue, observability | Plan S1–S2, Arch Phase 1 | Cross-tenant negative tests pass |
| **P3 Chat vertical slice** | Widget, chat adapter, knowledge ingestion+RAG, grounded AI, handoff, agent inbox/workspace | Plan S3–S5, Arch Phase 2 | Full chat journey resolves or escalates end-to-end |
| **P4 Email** | Inbound/outbound, threading, dedup, delivery states, bounce, attachments | Plan S6, Arch Phase 3 | QA-006/007 + bounce/duplicate tests pass |
| **P5 Inbound voice** | Number, call state, speech pipeline, turn-taking, transfer, consent, fallback | Plan S7, Arch Phase 4 | Test calls meet latency/transfer thresholds |
| **P6 Tenant config & quality** | Setup wizard, AI policy versioning + publish/rollback, eval dashboard, analytics | Plan S8–S9, Arch Phase 5 | Admin can configure/test/publish/pause automation |
| **P7 Hardening & controlled pilot** | Security review, load tests, runbooks, restore drill, pilot with conservative AI | Plan Phase 6, PRD Stage 1–2 | Go/no-go checklist approved |

Note: this sequence follows the docs' proven ordering (foundation → chat slice → email → voice) which also honors the Brief's "prove one channel fully before broadening."

## 8. Dependencies and external services likely required

| Category | Purpose | Needed by | Blocker status |
|---|---|---|---|
| LLM provider (OpenAI / Anthropic / Gemini / Azure OpenAI / self-hosted) | Answer generation, classification, summaries | P3 | **BLOCKER — provider + API key required** (decision + paid account) |
| Embedding provider | Knowledge retrieval (RAG) | P3 | Same decision as LLM |
| Telephony provider (Twilio/Vonage/Telnyx/Exotel/Knowlarity…) | Inbound voice, numbers, transfer | P5 | Decision + paid number required; mocks OK until then |
| Email provider (MS Graph / Google Workspace / SendGrid / Postmark / Mailgun) | Inbound + outbound support email | P4 | Decision + mailbox/OAuth required; local mail catcher (Mailpit) until then |
| Cloud account (AWS/GCP/Azure) | Production/staging hosting, managed PG/S3/secrets | P7 | Approval + credentials required; local-first until then |
| Object storage | Attachments, knowledge files, exports | P3 | Local S3-compatible (MinIO/SeaweedFS) — no approval needed |
| PostgreSQL (+pgvector) | Primary database | P2 | Free — install on E: (no Docker needed) |
| Redis | Cache/rate-limits/queue | P2 | Free — optional initially; can defer to Postgres-backed queue |
| Secrets manager | Credentials | P2 local / P7 cloud | Env files locally (never committed); cloud secret manager later |
| Domain/DNS, sender reputation | Email deliverability, widget hosting | P4–P7 | Purchase requires approval |

## 9. Decisions requiring your approval (with recommendation)

### D-01 — Architecture style (HIGHEST PRIORITY)
- **Option A — Modular monolith + workers** (what your three technical docs prescribe): one main app (modules with strict boundaries), separate worker process, separate voice runtime, static chat widget. Fastest to build/operate/test for a small team; services extractable later at measured bottlenecks.
- **Option B — Deliberate microservices** (what your master prompt mandates): e.g. ~5–7 bounded services — Gateway/BFF, Identity+Tenant+Core-domain service, Conversation/Routing service, AI service (orchestration+knowledge), Channel service (chat+email adapters), Voice service, Workers. Clear data ownership per service, API/event contracts, independent deployability — at real cost: distributed transactions, more CI/CD, more infra, slower initial velocity.
- **My recommendation:** **Option A' ("modular monolith, service-shaped")** — start exactly as the docs say (modular monolith + workers + voice runtime + widget), but *organize the code as if it were microservices* (bounded modules, no shared-DB cross-writes, explicit contracts, tenant-scoped repositories), so any module can be extracted into a real service in ~a day when measurement justifies it. This satisfies the *spirit* of your microservices mandate (clear boundaries, ownership, contracts) without the premature operational cost your own architecture doc warns against. If you insist on literal microservices now, Option B is documented and I will build it — but I want your explicit call.
- **Blocks:** everything in Phase 1/2 (repo layout, docs, all code).

### D-02 — Backend language: TypeScript (NestJS/Fastify) vs Python (FastAPI)
- **Recommendation: TypeScript on NestJS (Fastify adapter)** — Node 22 + npm already installed; one language across frontend/backend/widget/contracts; strong OpenAPI tooling; AI SDKs mature. Python remains available for offline eval jobs later only if justified. (Architecture doc requires choosing *one* primary backend.)
- **Blocks:** all backend code.

### D-03 — Local infrastructure strategy (no Docker, C: nearly full)
- **Option A:** native Windows binaries installed on **E:** — PostgreSQL 16/17 (+pgvector build), Redis (Memurai free tier or tporadowski port), MinIO, Mailpit. Works today, no admin rights needed for most, zero C: usage.
- **Option B:** free up/relocate C: space (needs ~15–25 GB) → install Docker Desktop (WSL2) → full compose parity with future cloud. Best long-term parity but needs your action on disk space + install approval.
- **Recommendation:** **A now, B when disk allows.** Docs require containers eventually; not day one.

### D-04 — LLM/embedding provider (needed for Phase 3, not Phase 2)
- OpenAI vs Anthropic vs Gemini vs Azure OpenAI vs self-hosted. Depends on budget, data-residency (India?), latency. **Recommendation: adapter interface first; shortlist OpenAI + Anthropic; benchmark against a small eval set before locking.** Requires your provider choice + API key + budget approval when we reach P3.

### D-05 — Telephony provider (P5) and Email provider (P4) — decisions deferred, mocks until approved. India-vs-global question in D-04's note applies to telephony.

### D-06 — Target customer segment + launch geography/languages — product decisions only you can make; needed before pilot, not before foundation.

### D-07 — Repo initialization: initialize **git** now and create `.gitignore` (no secrets ever)? **Recommendation: yes.** No commits/pushes without your authorization per your rules.

## 10. Recommended next step (waiting for your approval)

1. **You decide D-01 (architecture), D-02 (backend language), D-03 (local infra), D-07 (git init).** (D-04/05/06 can wait — not needed until P3+.)
2. On approval, I will: initialize git + `.gitignore`; write the remaining Phase-1 documents (`ARCHITECTURE.md`, `SERVICE_BOUNDARIES.md`, `SECURITY.md`, `DATABASE_DESIGN.md`, `API_CONTRACTS.md`, `ENVIRONMENT_VARIABLES.md`, `LOCAL_DEVELOPMENT_SETUP.md`, ADR-001…009); then start **Phase 2 (Foundation)** — auth, tenants, RBAC, case schema, outbox/queue — with tests, per your Definition of Done.
3. Nothing has been installed, no accounts created, no code written, no files outside `Documentation/` touched. All existing DOCX files are untouched.

---

*Companion documents created in this phase: `TECH_STACK_EVALUATION.md`, `TECH_STACK_RECOMMENDATION.md`, `DECISIONS_PENDING.md`, `PROGRESS_TRACKER.md`.*
