# ADR-013: MVP Channel Staging — Chat → Email → Voice

| Field | Value |
|---|---|
| Status | **ACCEPTED** |
| Date | 2026-10-16 |
| Deciders | Founder (Jeet), Technical lead |
| Decision ref | D-13 (approved) |
| Resolves | `PROJECT_DISCOVERY_REPORT.md` §3 Contradiction 2 (Brief: one channel first vs PRD: all three in release) |

## Context
The Problem/Solution Brief recommends proving one channel fully before broadening; the PRD, Architecture, and Implementation Plan include all three channels in the initial release, delivered sequentially (chat → email → voice). Both are satisfied by staged delivery on one canonical case model.

## Decision
1. **Phase 3 — Chat first:** complete end-to-end vertical slice: widget → verified session → normalized message → policy/intent → retrieval from approved knowledge → grounded answer with source citations (or clarify/abstain/handoff) → agent workspace resolution → audit + outcome events. Exit gate: Plan S3–S5 acceptance (a real chat test resolves or escalates and an agent completes it).
2. **Phase 4 — Email** on the same case model (threading, dedup, delivery states, bounce).
3. **Phase 5 — Voice** on the same case model (mock runtime first; real telephony only after D-06/D-10 decisions).

The next channel is prioritized only after the previous channel passes its exit gate. Channel-specific differences live in adapters and metadata — never in duplicated case business logic. A voice feasibility spike remains scheduled early (risk R2) so telephony constraints surface before Phase 5 commitment.

## Consequences
- (+) Earliest validation of the core support workflow at the lowest risk; email/voice reuse proven case, queue, and AI pipeline.
- (−) The PRD's "all three channels in the initial release" is delivered later in the same release train; pilot timing depends on voice proving itself.
