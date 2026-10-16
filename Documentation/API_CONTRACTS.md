# API CONTRACTS
## Conventions and core contracts (v1)

| Field | Value |
|---|---|
| Status | Baseline conventions for Phase 2; OpenAPI spec generated from code (NestJS + swagger) will be authoritative per-endpoint |
| Applies to | API application, worker, widget, SPA, webhooks |

## 1. Conventions (Architecture v1 §9)

- **Versioning:** all public APIs under `/v1`. Breaking changes require a new version; additive changes preferred.
- **Auth:** admin/agent endpoints use short-lived JWT access tokens (Authorization: Bearer); chat widget uses short-lived signed session tokens scoped to one conversation session; webhooks use provider signature verification instead of user auth.
- **Tenant scope:** derived server-side from the authenticated membership/session — never accepted from request bodies or headers as authority.
- **Validation:** every request schema-validated at the boundary (class-validator/zod). Unknown fields on high-risk endpoints rejected.
- **Errors:** uniform envelope — `{ error: { code, message, correlation_id, details? } }`. Codes are stable strings (e.g., `permission_denied`, `tenant_mismatch`, `validation_failed`, `rate_limited`, `provider_unavailable`). No stack traces or secrets in responses.
- **Pagination:** cursor-based (`?cursor=&limit=`) on all growing tables; never offset pagination on messages/events.
- **Idempotency:** create/send/resolve operations accept `Idempotency-Key` header; duplicates return the original result. Provider events dedup via unique provider-event IDs.
- **Rate limiting:** per tenant, user, IP/session, and provider; `Retry-After` on 429.
- **Correlation:** `X-Correlation-ID` generated at ingress, propagated through outbox events, logs, traces, and downstream calls.
- **OpenAPI:** spec generated in CI; contract tests validate handlers against it and validate inbound webhooks against recorded provider payload schemas.

## 2. Core endpoints (initial inventory)

### Widget (customer-facing, CORS + origin-allowlisted)
| Endpoint | Purpose | Key checks |
|---|---|---|
| `POST /v1/widget/sessions` | Create/resume chat session | Allowed origin, rate limit, tenant/channel mapping, session expiry |
| `POST /v1/widget/messages` | Customer message | Session scope, payload limits, idempotency, abuse checks |
| `GET /v1/widget/messages` | Poll/reconnect history | Session scope, cursor |
| `WS /v1/widget/stream` | Live updates (typing, replies, handoff state) | Session token auth, tenant scoping |

### Agent/admin (JWT auth)
| Endpoint | Purpose | Key checks |
|---|---|---|
| `GET /v1/cases` | List cases | Tenant + role/queue scope, cursor pagination, filters (channel/status/assignee/SLA/AI-handled) |
| `GET /v1/cases/{id}` | Case detail (timeline, AI summary, handoff reason, sources) | Case access permission |
| `POST /v1/cases/{id}/reply` | Agent reply | Case access, channel state, idempotency, **AI send-lock** |
| `POST /v1/cases/{id}/notes` | Internal note | Case access; never customer-visible |
| `POST /v1/cases/{id}/handoff` | Escalate/route | Reason, destination eligibility, summary preservation, audit |
| `POST /v1/cases/{id}/resolve` / `reopen` | Lifecycle | Permission, confirmation semantics, reopen policy |
| `POST /v1/knowledge/sources` | Register source | Permissions, URL/upload safety (SSRF), quotas |
| `POST /v1/knowledge/versions/{id}/publish` | Publish approved version | Permission + validation gate, version lock, audit |
| `POST /v1/ai-config` (draft) / `test` / `publish` | Config lifecycle | Permission, budget, eval-gate result, version immutability, audit; publish = rollback-able |
| `POST /v1/ai-config/{id}/kill-switch` | Pause automation per tenant/channel | Admin only; immediate effect; audited |
| `GET /v1/analytics/...` | Metric queries | Role scope, documented metric definitions, freshness flag |
| `GET /v1/audit-events` | Audit trail | Admin only, tenant-scoped, filtered, export audited |
| `POST /v1/auth/*` | login, refresh, logout, invite, reset | Rate limits, generic errors, revocation semantics |

### Webhooks (inbound provider events)
| Endpoint | Purpose | Key checks |
|---|---|---|
| `POST /v1/webhooks/{provider}` | Provider callbacks (email/voice) | **Signature verification**, timestamp/replay window, payload size limit, dedup via provider_event_id, idempotent handling (QA-006) |

## 3. Event contracts (outbox / internal bus)

Envelope (all events): `{ event_id, tenant_id, type, schema_version, occurred_at, correlation_id, payload_ref | payload }`. Prefer references over copying sensitive content.

Initial catalog (Architecture v1 §9): `message.received`, `conversation.created`, `case.created`, `case.assigned`, `ai.decision.completed`, `ai.response.sent`, `handoff.requested`, `handoff.accepted`, `case.resolved`, `case.reopened`, `email.delivery.failed`, `voice.call.started|ended`, `knowledge.indexing.completed`, `knowledge.version.published`, `tenant.config.published`, `provider.connection.degraded`, `action.executed`.

Compatibility: consumers must tolerate additive fields; producers bump `schema_version` on breaking changes; contract tests cover producer + consumer sides.

## 4. Internal module contracts

Cross-module calls use typed NestJS service interfaces (per SERVICE_BOUNDARIES.md), designed as if remote: explicit DTOs, no shared ORM entities, no cross-module table access. This keeps extraction (ADR-010) mechanical rather than architectural.

## 5. Compatibility & evolution rules

- Public API deprecation: announce via response headers + docs; minimum one release overlap.
- Webhook payload schemas versioned per provider; unknown providers blocked at config time.
- All write endpoints audited; all AI-invoked endpoints additionally record actor=ai with decision reference.
