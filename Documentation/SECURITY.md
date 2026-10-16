# SECURITY
## Security & privacy model — AI Customer Support Platform

| Field | Value |
|---|---|
| Status | Baseline for Phase 2 implementation; must be revisited before pilot (threat model + review per PRD §11) |
| Date | 2026-10-16 |
| Governs | All modules (SERVICE_BOUNDARIES.md) · cross-cutting NestJS guards/interceptors |

Security is a per-sprint workstream, not a final phase. Every item below maps to a PRD/Architecture requirement; items marked **GATE** block release.

## 1. Tenant isolation (PRD FR-001, QA-005 — **GATE**)

1. Every tenant-owned table has `tenant_id NOT NULL` with FK to tenants.
2. Tenant context resolved server-side from authenticated membership or validated channel mapping — **never** from client-supplied `tenant_id`.
3. Repository layer injects tenant predicates on every query; no raw cross-tenant access path exists outside platform-operator tooling (which is audited and time-bound).
4. **PostgreSQL Row-Level Security as defense-in-depth** (ADR-003): RLS policies on all tenant tables; the application connects with per-request `SET LOCAL app.tenant_id`.
5. Caches and queues key by tenant; object-storage prefixes per tenant; retrieval filters applied **in SQL**, never only in prompts.
6. **Negative cross-tenant tests are mandatory CI gates** — API, UI, analytics, retrieval/embeddings, files, exports, recordings (QA-005 + threat scenarios Architecture §7).

## 2. Authentication (identity module)

- **Argon2id** password hashing (memory-hard parameters per current OWASP guidance).
- Short-lived JWT access tokens + **rotating refresh tokens** (reuse detection revokes the family).
- Session listing/revocation per user; admin revocation of memberships takes effect immediately.
- Login/reset/invite endpoints: rate-limited per IP + account; generic errors that never reveal account existence.
- MFA-ready design (TOTP) — implemented before pilot for admin/owner roles; password reset flows audited.
- Email verification required before support-agent privileges.
- Future SSO/SAML behind the identity abstraction (no vendor lock-in baked into domain code).

## 3. Authorization

- RBAC (roles → permission keys, per tenant) + resource-level checks in **every** service method — server-side, regardless of UI visibility (FR-002).
- Permission checks default-deny; new endpoints require an explicit authz decision in code review.
- High-impact actions (role changes, source deletion, config publish, data export, retention changes) require elevated permission + confirmation and are audited.
- AI/automation identities are first-class: the AI acts with its own scoped identity, never as an arbitrary user; tool permissions per tenant allowlist (FR-013).

## 4. Secrets & configuration

- No secrets in code, docs, logs, or frontend bundles. `.env` git-ignored; `.env.example` placeholders only (ADR-012).
- Startup validation of required env vars: fail fast with **variable names only** — never values.
- Provider credentials stored as secret references (local: env; cloud P7: managed secret manager, e.g., AWS Secrets Manager).
- Rotation procedure documented per provider; widget uses short-lived signed session tokens, not static keys in browsers.

## 5. Transport, storage & uploads

- TLS everywhere (local: HTTPS via dev proxy or local CA; cloud: managed certificates).
- Encryption at rest for DB, object storage, backups (cloud-managed keys at P7).
- Uploads (knowledge docs, email attachments): private per-tenant storage, MIME/type + size validation, malware scanning where practical, **short-lived signed URLs only**, sandboxed parsing (untrusted documents — Architecture §7).
- SSRF protection on any URL ingestion: approved schemes/domains only, private/link-local address ranges blocked, redirects validated.

## 6. AI-specific security (PRD §11)

- **Prompt injection:** user messages, retrieved documents, emails, and web content are untrusted data. System policy, tenant boundaries, and tool permissions are enforced by deterministic code — no prompt content can change authorization, retrieval filters, or the action allowlist. Injection attempts included in the eval suite (QA-013).
- Model context never contains secrets, internal prompts, other tenants' data, or internal notes.
- Output validation before send: grounding check, prohibited-disclosure check, action-authorization check; unvalidated content is never streamed to customers.
- Tool calls: allowlisted, schema-validated, authenticated, rate-limited, budget-capped, audited (QA-010/011).
- Every AI decision persisted (`ai_decisions`) with config/model version + sources for accountability, redacted of sensitive content.

## 7. Channel security

- Webhooks: signature verification + timestamp/replay checks where supported + payload size limits + dedup (**GATE** tests: forged webhook, replay).
- Chat widget: origin/domain allowlist, per-tenant rate limits, session expiry, abuse protection; never exposes prompts, credentials, other customers' data, or internal notes (PRD §6.1).
- Email: attachment isolation, duplicate-event idempotency, internal notes never customer-visible.
- Voice (P5): consent/recording/transcription policy applied before capture; recording access separately permissioned from transcripts; retention per jurisdiction (D-10 open).

## 8. Audit & data lifecycle (FR-018/020)

- Audit events: tenant, actor/system, timestamp, action, target, outcome, correlation ID. Append-only; audit-write failure fails sensitive transactions.
- Retention: tenant-configurable defaults; deletion/export process documented and testable (QA-016); deletion propagates to DB, object storage, vector indexes, caches, exports — and documented downstream providers.
- Logs/traces: structured, correlation-ID linked, **redacted** (no secrets, no message bodies, no PII beyond tenant-safe identifiers); retention documented (ADR-008).
- Personal-data inventory: which fields are personal data, where replicated, how deletion applies (`DATABASE_DESIGN.md`).

## 9. Abuse protection & resilience

- Rate limiting per tenant/user/IP/session/provider with retry-after semantics; per-tenant AI budgets and token caps prevent cost-abuse (Architecture §17).
- Request size limits; safe error handling (no stack traces to customers); bounded retries everywhere; DLQ visibility.
- Backpressure: bounded queue depth and concurrent model calls.

## 10. Supply chain & operations

- Dependency scanning (npm audit + allow/deny policy) and secret scanning (gitleaks) in CI — **GATE A**.
- Pinned lockfile; minimal dependency surface for auth/crypto.
- Least-privilege credentials for every service and provider account.
- Incident readiness: per-tenant AI kill switch tested before pilot (pause auto-send without platform-wide outage — Architecture §11).
- Pre-pilot: formal threat-model review + security test pass (Gate E); legal review of privacy/recording/consent (D-10).

## 11. Secure-development rules (enforced in review)

1. Never hardcode secrets; never log sensitive payloads; never trust client-side-only checks.
2. All external input schema-validated at boundary; unknown high-risk fields rejected.
3. New endpoints ship with authz tests (positive + negative) and tenant-isolation tests.
4. No real customer data in dev/test without explicit authorization — synthetic fixtures only.
5. Any change to auth, tenant boundaries, AI permissions, or retention requires doc update + review sign-off.
