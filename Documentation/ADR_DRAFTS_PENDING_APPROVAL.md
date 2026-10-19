# ADR DRAFTS — SUPERSEDED (promoted to final ADRs on 2026-10-16)

> **SUPERSEDED.** The founder approved all five decisions on 2026-10-16. These drafts were promoted to final records in `Documentation/adr/`: D-01→ADR-010, D-02→ADR-001, D-03→ADR-011, D-07→ADR-012, D-13→ADR-013 (plus ADR-014 for the approved claymorphism visual direction). This file is retained for history only; the ADR directory is now authoritative.

---


Prepared: 2026-10-16 · Source of selections: founder's review of `TECH_STACK_RECOMMENDATION.md` and `DECISIONS_PENDING.md`

---

## 1. Draft decision records

### Draft D-01 — Architecture style
**Suggested title:** *Modular Monolith with an Extraction Path*

**Context**
The platform must deliver tenant isolation, AI orchestration, conversations, knowledge retrieval, integrations, and background processing as a multi-tenant SaaS. Literal microservices from day one would introduce deployment, distributed-transaction, and operational overhead that the team and the source architecture document explicitly warn against ("Overengineering too early" — Architecture v1 §17). The Master Project Prompt's microservices mandate and the architecture documents' modular-monolith prescription conflict (see `PROJECT_DISCOVERY_REPORT.md` §3, Contradiction 1).

**Proposed decision**
Use a modular monolith for the primary API with explicit, enforced domain boundaries (modules own their data access; no cross-module table writes; contracts between modules defined like service APIs). Run background workers as a separately deployed process from the same codebase. Keep the voice runtime independently deployable when introduced in Phase 5. Extract any module into a real service only when justified by measured operational, scaling, or team-ownership needs — the extraction path stays open at all times.

**Consequences**
- (+) One coherent product to build, test, and operate; fastest path to the first vertical slice; shared types/contracts.
- (+) Clear module boundaries make later service extraction a deliberate, low-risk event.
- (−) Boundary discipline depends on conventions, lint rules, and architecture tests — without enforcement the monolith can degrade into a "big ball of mud."
- (−) Independent scaling of individual capabilities is limited until extraction actually happens.
- Mitigations: module-boundary tests in CI, per-module repositories/services, contract-first internal APIs.

**Status**
Proposed — awaiting founder confirmation (selection: A').

---

### Draft D-02 — Backend language and framework
**Suggested title:** *TypeScript with NestJS (Fastify adapter)*

**Context**
The architecture requires choosing **one** primary backend stack (Architecture v1 §3). Frontend, admin dashboard, and chat widget are TypeScript. Node.js v22.23.1 and npm are already installed on the development machine; Python 3.14 is also present but selecting it would create a dual-language stack, which the architecture documents warn against ("Avoid duplicating domain logic across stacks").

**Proposed decision**
Use TypeScript with NestJS on the Fastify adapter for the primary backend. NestJS modules map directly to the documented domain boundaries (identity, tenant, RBAC, conversation/case, knowledge, AI orchestration, channels, audit, analytics). Enforce runtime validation (class-validator/zod at boundaries), generated OpenAPI contracts, and automated API tests. TypeScript types alone are never treated as request validation.

**Consequences**
- (+) One language across frontend/backend/widget/contracts; strong typing, DI, guards/interceptors align with tenant-context and RBAC cross-cutting concerns; Node 22 available today.
- (+) Mature OpenAPI generation satisfies the docs' API-contract requirements.
- (−) Framework conventions must be learned and consistently applied; async CPU-heavy work (embedding, parsing large documents) belongs in workers, not the API process.
- Mitigations: coding standards, architecture tests, worker offloading from day one.

**Status**
Proposed — awaiting founder confirmation (selection: TypeScript + NestJS/Fastify).

---

### Draft D-03 — Local development infrastructure
**Suggested title:** *Windows-Native Services on E: (Conditional)*

**Context**
The development machine has no Docker, no PostgreSQL, no Redis. C: drive has only ~1.1 GB free, making Docker Desktop (≈10–25 GB) infeasible today. E: (project drive) has **257.2 GB free** (verified 2026-10-16 via two independent methods) and the project directory grants the developer user Modify permissions. The architecture docs require a reliable local environment before cloud deployment.

**Proposed decision**
Prefer native Windows services installed on **E:** for the initial local setup — PostgreSQL 17 (+pgvector), Redis (Memurai free tier or maintained Windows port), MinIO (S3-compatible), Mailpit (local SMTP capture). This preference is **conditional** on verification of: sufficient free space, write permissions, service compatibility with Windows, documented installation/configuration/backup/upgrade procedures, and reliable startup. If any check fails, **stop and present alternatives for approval** (e.g., relocate/free C: space and adopt Docker Desktop + Compose) rather than silently switching strategy.

**Consequences**
- (+) No C: drive pressure; zero licensing cost; no admin-rights requirement for most components; Phase 2 can start immediately.
- (+) Keeps S3-compatible and SMTP-shaped code honest (MinIO/Mailpit behave like production services).
- (−) Native services need documented install/upgrade/backup procedures; compose-style one-command parity arrives only after Docker is adopted.
- (−) Small risk a native Windows build behaves subtly differently from Linux containers used in cloud.
- Mitigations: pin versions, scripted service setup in `Infrastructure/local-development/`, adopt Docker mid-project when disk allows, cloud staging validates real parity at P7.

**Status**
Proposed — awaiting founder confirmation **and** environment verification (space ✅ and permissions ✅ verified 2026-10-16; service compatibility to be proven during actual installation, which itself requires approval).

---

### Draft D-07 — Version control foundation
**Suggested title:** *Version-Controlled Project Foundation*

**Context**
The project currently has no Git repository. Controlled change history and repository hygiene are prerequisites for safe implementation, CI, and review.

**Proposed decision**
Upon explicit confirmation: initialize a Git repository in the project root and add a suitable `.gitignore` covering secrets, local environment files (`.env`), credentials, dependency folders (`node_modules/`), build artifacts, logs, local database data directories, and generated files. Validate ignore rules and run a secret scan before any first commit. **No commits, no remote configuration, and no pushes without separate, explicit authorization.**

**Consequences**
- (+) Traceable change history; safer collaboration; enables CI gates later.
- (+) Ignore rules prevent the most common secret-leak vector (accidental `.env` commits).
- (−) None material; discipline required around the no-commit-without-permission rule.
- Mitigations: gitleaks in CI at Phase 2; `.env.example` with placeholders only.

**Status**
Proposed — awaiting founder confirmation (selection: Yes).

---

### Draft D-13 — MVP channel scope
**Suggested title:** *Staged Channel Delivery — Chat → Email → Voice*

**Context**
The Problem/Solution Brief recommends proving one channel first, while the PRD, Architecture, and Implementation Plan include all three channels in the initial release delivered sequentially. This tension is recorded in `PROJECT_DISCOVERY_REPORT.md` §3 (Contradiction 2 / D-13).

**Proposed decision**
Deliver chat first (complete end-to-end customer-to-agent workflow: widget → grounded AI answer with source citations → conversation persistence → safe fallback/abstain → human handoff with summary → agent resolution → audit + outcome events), then email in Phase 4, then voice in Phase 5 — all on the same canonical case model. Chat must pass its exit criteria (Plan S3–S5 gates) before the next channel is prioritized. Channel abstractions must still allow later additions without premature complexity.

**Consequences**
- (+) Earliest validation of the core support workflow with the lowest-risk channel; reduced scope risk; matches every delivery document's ordering.
- (+) Email and voice reuse the proven case model, queueing, and AI pipeline.
- (−) All-three-channels-in-initial-release commitment (PRD) is met later in the same release train; pilot timing depends on voice proving itself.
- Mitigations: voice feasibility spike kept early (documented risk R2); mock adapters keep development unblocked.

**Status**
Proposed — awaiting founder confirmation (selection: Chat → Email → Voice).

---

## 2. ADR numbering reconciliation (proposed)

The Software Architecture document pre-numbered ADR-001…009 as a "to create" list. To avoid duplicate or conflicting numbering, proposed mapping:

| Final ADR | Topic | Source decision | Status |
|---|---|---|---|
| ADR-001 | Backend language/framework | **D-02** (this draft) | Draft |
| ADR-002 | Queue & outbox pattern | ✅ Written + accepted 2026-10-19 (`ADR-002-queue-transactional-outbox.md`, executed) | Done |
| ADR-003 | Tenant isolation strategy (RLS + repository predicates) | (planned, Architecture v1 §7) | Not started |
| ADR-004 | LLM/embedding provider abstraction | **D-04 — remains OPEN** | Deferred to P3 |
| ADR-005 | Vector retrieval store | (planned; pgvector benchmark) | Not started |
| ADR-006 | Telephony/voice architecture | **D-06 — remains OPEN** | Deferred to P5 |
| ADR-007 | Email provider strategy | **D-05 — remains OPEN** | Deferred to P4 |
| ADR-008 | Observability & retention | (planned, Architecture v1 §10) | Not started |
| ADR-009 | AI autonomy rollout policy | (planned, Plan §9) | Not started |
| **ADR-010** | Architecture style — modular monolith with extraction path | **D-01** (this draft) | Draft |
| **ADR-011** | Local development infrastructure (Windows-native on E:, conditional) | **D-03** (this draft) | Draft |
| **ADR-012** | Version-control foundation & secret hygiene | **D-07** (this draft) | Draft |
| **ADR-013** | MVP channel staging (Chat → Email → Voice) | **D-13** (this draft) | Draft |

Final numbering will be applied only when the drafts are confirmed and promoted into `Documentation/adr/`.

## 3. What this file does NOT authorize

- No Git initialization, commits, remotes, or pushes
- No dependency installation (`npm install`, pnpm, etc.)
- No service installation (PostgreSQL, Redis, MinIO, Mailpit)
- No source code creation
- No paid API calls (LLM, email, telephony) — **mock providers only** until a spending cap is separately approved
- No cloud provisioning, domain purchases, or external account creation

Confirmation request: see `DECISIONS_PENDING.md` §Confirmation required.
