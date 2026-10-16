# ADR-010: Architecture Style — Modular Monolith with an Extraction Path

| Field | Value |
|---|---|
| Status | **ACCEPTED** |
| Date | 2026-10-16 |
| Deciders | Founder (Jeet), Technical lead |
| Decision ref | D-01 (approved: Option A') |
| Resolves | Master Prompt "microservices required" vs Architecture v1 "modular monolith" contradiction (`PROJECT_DISCOVERY_REPORT.md` §3) |

## Context
The platform must deliver tenant isolation, AI orchestration, conversations, knowledge retrieval, integrations, and background processing as a multi-tenant SaaS. Literal microservices from day one would introduce deployment, distributed-tracing, and operational overhead that the team and the source architecture document explicitly warn against (Architecture v1 §17 "Overengineering too early"). The founder's Master Prompt mandated a "deliberate microservices architecture"; the three technical documents prescribed a modular monolith. Both intents are honored by Option A'.

## Decision
Build the primary API as a **modular monolith** with strict, enforced domain boundaries, plus these separately deployed units:

1. **API application** (NestJS modular monolith)
2. **Worker process** (same codebase, separate deployment: outbox dispatch, indexing, email sending, analytics, retries)
3. **Voice runtime** (introduced Phase 5 as its own process for latency isolation)
4. **Chat widget** (static bundle, CDN-hostable)

"Service-shaped" rules that keep the extraction path open:
- Every module owns its tables; **no cross-module table writes** — cross-module access goes through the owning module's service API (in-process interface designed as if it were a remote API).
- Modules communicate via typed contracts and domain events (outbox), not shared mutable state.
- Per-module repositories are the only layer touching the database.
- Architecture tests in CI enforce module dependency rules (no import cycles, no reaching into other modules' internals).
- Each module is independently testable with its own fixtures.

Extract any module into an independently deployable service **only when measured operational, scaling, or team-ownership needs justify it** — via a documented ADR update.

## Consequences
- (+) One coherent product to build, test, and operate; fastest path to the first vertical slice; shared contracts.
- (+) Later service extraction is a deliberate, low-risk event because boundaries already exist.
- (−) Independent scaling is limited until extraction happens; boundary discipline depends on enforcement (mitigated by architecture tests).
- Voice runtime and workers prove the multi-process pattern early, so extraction mechanics are never novel.

## Compliance
Flag in review: cross-module table access, shared mutable singletons between modules, database tables without a single owning module, events published without outbox.
