# TESTING STRATEGY
## Test architecture and release gates

| Field | Value |
|---|---|
| Status | Baseline for Phase 2; tools: Vitest, Supertest-style API tests, Playwright, dependency-cruiser, gitleaks, k6 (P7), custom AI eval harness |
| Principle | "Code is not done when it compiles" — results are recorded as Passed / Failed / Blocked / Not run; failures are never hidden (Master Prompt §16) |

## 1. Test layers

| Layer | Tooling | What it covers | When |
|---|---|---|---|
| Unit | Vitest | Routing rules, state machines, validators, retry policy, permission helpers, config versioning, chunking, prompt building (mock model) | Every PR |
| Integration | Vitest + real local services (Postgres/Redis/SeaweedFS/Mailpit) | Transactions, outbox→queue→worker, idempotency, object-storage permissions, signature validation, migrations | Every PR (CI services) |
| Contract | OpenAPI schema checks + recorded provider payloads | API compatibility, webhook payload versions, model-adapter schemas | Every PR |
| End-to-end | Playwright | Chat journey, agent workspace, admin flows, setup wizard; later email/voice flows | Nightly + pre-release |
| **Tenant isolation** | Vitest/Playwright negative suites | QA-005-class: cross-tenant access via API, UI, analytics, retrieval/embeddings, files, exports — **mandatory release gate** | Every PR |
| Authorization | Vitest matrix tests | Role × action × resource, default-deny, privilege escalation attempts | Every PR |
| AI evaluation | Custom harness (versioned JSONL suites) | Groundedness, correctness, refusal/abstain, prompt injection, mandatory-escalation precision/recall, adversarial + stale-source cases (PRD §7.3) | Nightly + pre-promotion (Gate D) |
| Channel adapter | Provider sandbox or labeled mocks | Chat delivery, email threading/dup/bounce, voice call lifecycle/transfer/fallback | Per channel phase |
| Resilience | Vitest + chaos scripts | Provider timeout/outage, model outage, duplicate webhooks, worker restart, DLQ recovery, DB failover behavior | Pre-release |
| Security | gitleaks, npm audit, targeted pentest scripts | Secrets, dependency CVEs, SSRF, webhook replay, IDOR, export/deletion paths | Every PR + pre-pilot |
| Load | k6 (P7) | Concurrent conversations, queue backlog, indexing bursts, tenant fairness, voice concurrency | Pre-pilot |
| Accessibility | axe + manual | Keyboard nav, contrast, focus, screen-reader announcements (WCAG 2.2 AA) | Design/QA checkpoints |

## 2. Acceptance-scenario mapping (PRD §13.2)

QA-001 grounded FAQ → AI eval suite · QA-002 unknown question → eval (refusal) · QA-003 conflicting sources → eval + policy test · QA-004 human request → E2E handoff · QA-005 tenant isolation → isolation suite (**gate**) · QA-006 email dup → adapter integration · QA-007 threading → adapter integration · QA-008 voice silence → voice adapter (P5) · QA-009 transfer failure → voice adapter (P5) · QA-010 unauthorized action → integrations unit + audit test · QA-011 action timeout/idempotency → integrations integration · QA-012 sensitive request/identity → eval + authz test · QA-013 prompt injection → eval suite (**gate**) · QA-014 integration unavailable → resilience · QA-015 audit trail → audit integration test · QA-016 retention deletion → deletion propagation test (P6).

## 3. Release gates (Development Plan §8)

| Gate | Required evidence | Blockers include |
|---|---|---|
| **A — PR/CI** | Unit tests, lint, type checks, secret + dependency scans, migration validation | Broken build, exposed secret, unreviewed schema change |
| **B — Integration** | DB/queue/outbox, provider adapters, signatures, idempotency, permission tests | Cross-tenant access, duplicate customer send, lost job |
| **C — E2E** | Chat (then email, then voice) happy + failure paths; handoff + resolution | Lost context, unsafe answer, failed fallback |
| **D — AI quality** | Eval regression set, groundedness, injection + sensitive-request tests | Mandatory handoff ignored, unsupported claim, regression beyond threshold |
| **E — Pilot readiness** | Load/latency results, backup restore drill, alerts, runbooks, privacy review | No kill switch, untested restore, unknown incident owner |

## 4. AI evaluation harness (details)

- Versioned test suites as JSONL: input, expected behavior (answer-with-sources | clarify | abstain | escalate-to-queue), rubric graders (LLM-graded with mockable grader + deterministic checks where possible).
- Suites include: tenant-isolation probes (Tenant A question about Tenant B data must abstain), injection attempts, stale/conflicting knowledge, multilingual (when enabled), mandatory-escalation set.
- Results stored (`evaluation_runs`); every prompt/model/retrieval/config change runs regression before publish (PRD §7.3); rollbacks restore prior behavior.
- Default CI mode: **mock provider** (deterministic fixtures, zero cost). Real-model runs: approved key + budget cap only (D-04 open).

## 5. Working rules

1. Feature = acceptance criteria + tests + run + recorded result. Never claim a pass that did not run.
2. Blocked tests (missing credential/provider/approval) are labeled **BLOCKED** with the exact missing item requested from the founder.
3. Flaky tests are fixed or quarantined with an owner — never silently ignored.
4. Fixing a regression includes a regression test.
5. Mocks (email/voice/AI) are explicitly labeled `mock-*` and are never represented as production integrations (Definition of Done, Master Prompt §22).
