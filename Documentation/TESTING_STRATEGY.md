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
| **A — PR/CI** | Unit tests, lint, type checks, secret + dependency scans, migration validation, **RLS enforcement suite run as the app role** (`rls.integration.spec.ts` ×31 incl. the 8-table matrix) **+ the QA-005 HTTP suite** (`security/cross-tenant.integration.spec.ts`) | Broken build, exposed secret, unreviewed schema change, tenant-policy bypass |
| **B — Integration** | DB/queue/outbox, provider adapters, signatures, idempotency, permission tests (`tenancy`, `audit`, `outbox`, `observability`, `dispatcher` integration suites) | Cross-tenant access, duplicate customer send, lost job |
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

## 6. Test runtime note — Nest DI needs decorator metadata (ADR-008)

Vitest transforms TypeScript with **esbuild**, which cannot emit `emitDecoratorMetadata`.
Without `design:paramtypes`, Nest instantiates every `@Injectable()`/controller with **no
constructor arguments** — `this.reflector`, `this.service`, … are all `undefined` and any
full-app test fails with confusing 500s (`Cannot read properties of undefined (reading
'getAllAndOverride')`). This was invisible until ADR-008's Gate-B tests were the first to
boot the real `AppModule`; earlier suites constructed services/guards directly.

- Fix: `apps/api/vitest.config.ts` runs **SWC** (`unplugin-swc` + `@swc/core`,
  `jsc.transform.decoratorMetadata: true`) so tests exercise the real DI graph.
- Consequence: any test that boots Nest (integration/E2E through `NestFactory.create`)
  **must** run under this config — a spec that bypasses it will look like an app bug.
- `@swc/core` is on the `allowBuilds` allowlist in `pnpm-workspace.yaml` (pnpm blocks
  postinstalls by default; the script is swc's standard optional-binary check).

## 7. Spec files are typechecked (Gate A "type checks")

Every package `tsconfig.json` excluded `src/**/*.spec.ts`, so `tsc --noEmit` never looked at
tests — and vitest runs them through SWC, which **strips** types rather than checking them. A
spec could be entirely untyped and still report green. Each package now has a
`tsconfig.spec.json` chained into its `typecheck` script:

```
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.spec.json --noEmit
```

Adopting it surfaced **9 real type errors across 5 specs** (CHANGELOG 2026-10-25) — none of them
runtime failures, i.e. exactly the class of defect Gate A's "type checks" exists to catch:
a test double shaped like `Partial<FastifyRequest>`, fastify's full `InjectOptions` against a
minimal helper, `Parameters<typeof SomeClass>` on a construct-only type, a handler map narrowed
to `never`, and a `capture()` return field typed as an array but returned as a function.

## 8. Gate enforcement status (honest accounting)

What Gate A/B actually enforce today — every row below is enforced per PR in CI (the dependency
scan blocks on production `critical` only, so it carries ⚠️):

| Gate A/B requirement | Enforced per PR in CI? | Local |
|---|---|---|
| Unit tests | ✅ job `build-test` → `pnpm test` | ✅ |
| Type checks (src **+ specs**) | ✅ job `build-test` → `pnpm typecheck` | ✅ |
| Build | ✅ job `build-test` → `pnpm build` | ✅ |
| RLS suite + QA-005 negatives (Gates A/B) | ✅ `postgres:17` service → provision → migrate → 9 posture assertions → `pnpm test` | ✅ 177/177 |
| Migration validation | ✅ own step: `db:migrate` runs as the **owner** role; a failing migration fails the job | ✅ `db:migrate` per slice |
| Secret scan (gitleaks — ADR-012) | ✅ job `secret-scan`: v8.30.1 pinned, **full history** (`fetch-depth: 0`), `--redact` | ✅ 0 findings / 14 commits |
| Dependency scan (`pnpm audit`) | ⚠️ job `dependency-scan`: **blocks on production critical**, all advisories printed non-blocking | ✅ baseline recorded below |
| Lint | ✅ job `build-test` → `pnpm lint` (ESLint 10 flat config, `typescript-eslint` recommended tier) | ✅ 0 problems |

### How the CI database gate works

`build-test` boots an ephemeral `postgres:17` service with **trust auth on the job-local
loopback port** — deliberately, so no credential is written into the workflow file for the secret
scanner (which scans that very file) to find. Then it replays the local cluster's three steps:

1. `Infrastructure/ci/provision-test-db.mjs` creates `aicsp` (owner — runs migrations, owns tables)
   and `aicsp_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`), the `ai_csp_test` database
   and the ADR-003 `ALTER DEFAULT PRIVILEGES` grant — idempotent, and it never re-grants on existing
   tables, so migrations 005/006's `REVOKE UPDATE, DELETE` on the append-only tables stays intact
2. `pnpm --filter @aicsp/api db:migrate` applies 001→007 **as the owner**
3. the same script re-runs with `--check-grants`: **9 assertions** (app role can SELECT/INSERT
   business tables, has schema USAGE, cannot UPDATE/DELETE `audit_events` or `outbox_events`, RLS
   enabled on `cases` and `audit_events`) — one named failure instead of seven suites dying with
   `permission denied`
4. `pnpm test`, where the DB suites now genuinely run per PR instead of skipping — and a final
   step **fails the job if any suite skipped** (see the guard below)

### The hollow-gate guard (why "no skips" is a hard failure)

Every DB suite is written as `describe.skipIf(!testDbUrl)` — a *missing* database is a **skip**,
not a failure. Reproduced by removing the variable from the environment: the run exits **0** while
73 api tests and 6 worker tests report as skipped. A green run on its own therefore proves
nothing about the DB suites, and this exact silent skip has already happened once (turbo's strict
env mode dropped the variable).

So CI does not trust a green vitest exit code:

- the **Tests** step writes output to a file rather than piping it, so the step's exit code is
  vitest's and not the shell's (the default `run` shell is `bash -e` *without* `pipefail`)
- a separate **Gate: no suite may silently skip** step then fails the job if `TEST_DATABASE_URL`
  is unset, or if `N skipped` appears anywhere in the summaries, printing the offending lines

Validated against real captured output (the script extracted verbatim from `ci.yml` and run under
bash): a full run passes; a run with the variable removed fails and lists the eight skipped suites;
an absent variable fails first with its own message. The guard also makes the run self-verifying
without log access: **a job log that can't be read still leaves a conclusion anyone can inspect.**

Consequence, deliberate: **a test skipped in CI fails CI.** If a skip is ever genuinely
intentional it must be an explicit decision, made by changing this gate alongside it.

CI has **no repo-root `.env`**, so the two JWT secrets are generated per run
(`openssl rand -hex 32`) and `turbo.json` → `test.env` declares them; turbo's strict env mode only
forwards declared names.

**Local proof (2026-10-25):** the entire sequence was replayed against a throwaway cluster
(`initdb` → provision → migrate → `--check-grants` → `pnpm test`) using CI's exact env shape:
**6/6 tasks, 149/149 tests green**. That run is what caught a real bug — `pg` lets a
`connectionString`'s path override a `database` option, so the grants were silently landing in the
*admin* database and every DB suite failed, exactly as CI would have failed on day one.

### Dependency-scan threshold (policy lives here, not in the YAML)

| Invocation | Behaviour |
|---|---|
| `audit-gate.mjs --fail-on critical` | **blocking** — 0 production criticals today |
| `audit-gate.mjs --fail-on none --include-dev` | report-only — prints all 20 advisories (15 prod + 5 dev-only, incl. the 2 `vitest`/`tinypool` criticals) |

pnpm's `--audit-level` only filters what is *printed*; it does not change the exit code, so it
cannot express a gate. The threshold therefore lives in `Infrastructure/ci/audit-gate.mjs` where it
is explicit and reviewable. Current production baseline: **15 advisories — 4 low / 7 moderate /
4 high / 0 critical**, the highs being `fastify` plus transitive `fast-uri`. Raising the gate to
`high` is a deliberate follow-up (upgrade fastify) and is **expected to fail until that lands** —
the gate is set to the truth we have, not to a claim.

### Lint (adopted 2026-10-25 — the last Gate A row)

`eslint.config.mjs` (flat config) + `pnpm lint`, run in the `build-test` job ahead of typecheck:

- **Tier:** `typescript-eslint` **recommended** — syntactic/type-shape rules that need no type
  information, so the whole workspace lints in seconds inside CI. The type-aware tier
  (`recommendedTypeChecked`: floating promises, unsafe `any` flows) is a deliberate follow-up; it
  needs `projectService` and its own baseline pass rather than a rushed config
- **Two deliberate scope decisions**, written into the config instead of left implicit:
  `require()` is allowed in `apps/api/migrations/**` because node-pg-migrate loads migrations as
  CommonJS (converting them would change migrate-time loading, not style), and `no-console` is an
  **error** across `apps/**/src` + `packages/**/src` because ADR-008 routes all logging through
  pino (correlation + redaction) — the single exception is `main.ts`'s pre-logger startup failure
  path, disabled inline where pino does not exist yet
- First run: **12 problems → 0**. Findings were fixed rather than silenced: two dead test helpers
  (`codeOf`, an unread `SAFE`), an unused matrix fixture (`chain2` — now asserted, so the RLS
  matrix proves visibility **both ways**), and three `no-useless-escape` hits in the correlation-id
  regex whose own doc comment already showed the unescaped form

