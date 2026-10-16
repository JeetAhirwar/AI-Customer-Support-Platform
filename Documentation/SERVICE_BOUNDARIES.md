# SERVICE / MODULE BOUNDARIES
## Modular-monolith module catalog (ADR-010)

Each module below is a NestJS module with: its own service layer, its own repositories (only DB access for its tables), typed public API (in-process interfaces designed as remote-service contracts), and domain events via the outbox. **Rule: no module touches another module's tables.** Cross-module calls go through the owning module's public API. Architecture tests in CI enforce dependency rules.

Legend — "Data" lists tables the module OWNS exclusively.

## Core platform modules

### 1. identity
- **Responsibility:** users, credentials, sessions, login/MFA/reset, invitations.
- **Data:** `users`, `credentials`, `sessions`, `invitations`.
- **API:** `register/invite/accept`, `login`, `refresh`, `logout`, `reset-password`; internal: `resolveUser(id)`.
- **Authz:** public auth endpoints; server-side verification only.
- **Failure modes:** provider-down N/A (own store); rate-limited login attempts; token revocation checked per request.
- **Deps:** audit, notifications (email verification via mailer worker).
- **Testing:** unit (token lifecycle), integration (Argon2, refresh rotation, revocation), negative auth tests.
- **Scaling:** stateless API; session store in Postgres; extractable first if needed.
- **Logging:** auth events (no passwords/keys), correlation IDs.

### 2. tenant (+ rbac)
- **Responsibility:** tenant lifecycle/settings, memberships, roles, permissions, teams, feature flags, business hours.
- **Data:** `tenants`, `tenant_memberships`, `roles`, `permissions`, `teams`, `feature_flags`, `business_hours`.
- **API:** CRUD tenant config; `checkPermission(user, action, resource)`; internal: `getTenantContext`, `getFeatureFlag`.
- **Authz:** owner/admin only for config changes; every change audited; config changes versioned.
- **Failure modes:** fail-closed on missing config version; cache invalidation on publish.
- **Deps:** audit.
- **Testing:** RBAC matrix tests, tenant-context resolution tests.
- **Scaling:** config cached per tenant (Redis) with version invalidation.
- **Logging:** config changes with actor + before/after summary.

### 3. customers
- **Responsibility:** customer/contact records, channel identity mapping, identity-verification state.
- **Data:** `customers`, `customer_identities` (channel, external id, verification level).
- **API:** `matchOrCreateCustomer(channel, identifier)`, `getCustomerContext(tenant, id, minVerificationLevel)`; verification challenge flows.
- **Authz:** minimum-context principle — AI receives only authorized fields; protected data requires verification level per policy (FR-014).
- **Failure modes:** conservative matching (never merge on subject/email display alone); duplicate-identity review queue.
- **Deps:** audit, conversation (timeline read).
- **Testing:** identity-matching tests, unverified-access negative tests (QA-012).
- **Scaling:** monolith.
- **Logging:** identity resolution outcomes only.

### 4. conversation (cases)
- **Responsibility:** canonical conversation/case model — cases, messages/events, statuses, assignments links, resolution codes. **The heart of the product (FR-009).**
- **Data:** `conversations`, `cases`, `messages`, `case_events`, `handoffs`.
- **API:** `createMessage` (idempotent), `createCase`, `transitionCase`, `assignCase`, `resolveCase`, `reopenCase`, `requestHandoff`, `acceptHandoff`; read APIs with cursor pagination + permission filters.
- **Authz:** queue/role-scoped reads; all writes permission-checked; AI vs human send-lock (no conflicting concurrent sends).
- **Failure modes:** idempotency keys on message create; delivery-state tracking; reopen rules per tenant policy.
- **Deps:** audit, notifications, analytics (events).
- **Testing:** state-machine unit tests, idempotency/duplicate tests, permission-scoped listing tests.
- **Scaling:** first extraction candidate with routing; separate content table if retention demands.
- **Logging:** state transitions + handoff reasons (no message bodies).

### 5. routing (queues & escalation)
- **Responsibility:** queues, routing rules, capacity/availability, SLA timers, escalation destinations, overflow policy.
- **Data:** `queues`, `routing_rules`, `agent_presence`.
- **API:** `routeCase(case)`, `escalate(case, reason)`, availability updates; deterministic rule evaluation.
- **Authz:** admin configures; agents cannot alter rules; **no LLM-generated queue decisions without deterministic validation** (Architecture §4).
- **Failure modes:** unassigned-case visibility + configured alerts; queue-overflow fallback; timeout-based re-routing.
- **Deps:** tenant (hours), conversation, notifications.
- **Testing:** rule-engine unit tests (deterministic), SLA timer tests.
- **Scaling:** monolith; timers via scheduled worker.
- **Logging:** routing decisions + reasons.

### 6. channels
- **Responsibility:** channel adapters — chat widget sessions, email provider adapter, (P5) voice adapter; webhook verification, normalization, dedup, delivery receipts. **Adapters never make AI or case business decisions.**
- **Data:** `channel_connections`, `provider_events` (dedup store), widget session records.
- **API:** `POST /v1/webhooks/{provider}` (verify → normalize → hand event to conversation/ai), widget session endpoints, outbound send interfaces.
- **Authz:** signature verification mandatory; domain allowlist for widget; per-tenant connection secrets via secret refs only.
- **Failure modes:** provider outage → degraded banner + fallback path; duplicate/out-of-order events idempotent; bounded retries + DLQ.
- **Deps:** conversation, tenant, notifications, audit.
- **Testing:** contract tests per provider (mock/sandbox), signature-forgery negative tests, dedup tests (QA-006).
- **Scaling:** stateless handlers; voice isolated as runtime (P5).
- **Logging:** provider event IDs, outcomes; never full bodies.

### 7. knowledge
- **Responsibility:** sources, ingestion (parse/chunk/embed), versions, approval workflow, staleness, retrieval interface. **Only published/approved content is production-retrievable (FR-003/004).**
- **Data:** `knowledge_sources`, `knowledge_versions`, `knowledge_chunks` (+ embeddings), `approvals`.
- **API:** register/update source, ingestion status, draft→review→publish (versioned, rollback), `retrieve(tenant, query, locale, filters)` (filters enforced in SQL).
- **Authz:** knowledge-manager/admin roles; publish requires permission + validation gate.
- **Failure modes:** indexing failures actionable + retryable; stale-source flags; empty/conflicting retrieval → no-answer path upstream.
- **Deps:** object storage (files), audit, analytics.
- **Testing:** chunking unit tests, retrieval tenant-isolation tests (cross-tenant embedding negative test), publish-gate tests.
- **Scaling:** async indexing worker; pgvector benchmark before any dedicated vector DB (ADR-005).
- **Logging:** ingestion/publish events, retrieval stats (no content).

### 8. ai-orchestration
- **Responsibility:** the 10-step pipeline (ARCHITECTURE §6); prompt building; model calls via provider adapter; response validation; decision persistence; autonomy modes (suggest/approve/auto per tenant+channel+topic).
- **Data:** `ai_config_versions`, `ai_decisions`, `evaluation_runs` (via analytics module contract).
- **API:** `handleInbound(messageRef) → AiDecision`; config draft/test/publish endpoints (test-gated, rollback); kill-switch controls.
- **Authz:** config publish = admin + passing eval gate; tool calls only via integrations gateway allowlist.
- **Failure modes:** timeouts → clarify/fallback/handoff; provider outage → automation pause per tenant/channel; cost caps.
- **Deps:** knowledge (retrieval), customers (min context), integrations (tools), conversation (decisions/handoffs), audit, analytics.
- **Testing:** deterministic pipeline unit tests with mock model; eval harness suites (groundedness, refusal, injection, escalation) — Gate D.
- **Scaling:** async-heavy; second extraction candidate; per-tenant budgets.
- **Logging:** full `ai_decisions` records (redacted), latency/cost metrics.

### 9. integrations (tool gateway)
- **Responsibility:** allowlisted business actions (create ticket, check order status…); connector auth; schema validation; idempotency; audit. **AI cannot invoke undeclared actions (FR-013, QA-010).**
- **Data:** `integration_connections`, `action_definitions`, `action_executions`.
- **API:** `executeAction(tenant, action, params, idempotencyKey)`; admin action-permission management.
- **Authz:** tenant allowlist + per-action permissions + confirmation requirements for sensitive actions.
- **Failure modes:** timeout → check outcome/idempotency before retry (QA-011); ambiguous result never reported as success; SSRF protections on any URL targets.
- **Deps:** audit, tenant.
- **Testing:** allowlist enforcement, idempotency, failure-communication tests.
- **Scaling:** monolith; per-connector rate limits.
- **Logging:** every execution attempt + outcome (audited).

### 10. audit
- **Responsibility:** immutable audit events for admin changes, access-sensitive events, AI actions, integrations, escalations (FR-018).
- **Data:** `audit_events` (append-only).
- **API:** `record(event)` (internal), filtered query API (admin, tenant-scoped).
- **Authz:** append widely permitted internally; read admin-only; export audited.
- **Failure modes:** audit write failure fails the business transaction (no silent audit gaps for sensitive ops).
- **Deps:** none (leaf module).
- **Testing:** coverage assertions for sensitive operations; immutability tests.
- **Scaling:** append-heavy; partitioning later.
- **Logging:** itself.

### 11. notifications
- **Responsibility:** in-app/email notifications to agents/admins (new escalation, SLA risk, publish results, channel degraded).
- **Data:** `notifications`, `notification_preferences`.
- **API:** `notify(tenant, recipients, template, refs)`; preference management.
- **Authz:** template-driven; no sensitive content in email notifications.
- **Failure modes:** retry via outbox; degrade to in-app only.
- **Deps:** mailer worker (channels), identity.
- **Testing:** delivery tests with Mailpit; preference enforcement.
- **Scaling:** async worker.
- **Logging:** delivery outcomes.

### 12. analytics
- **Responsibility:** outcome events, metric definitions, dashboards data (volume, resolution/escalation, response times, quality flags, cost), evaluation-run storage, feedback/review labels (FR-016/017).
- **Data:** `outcome_events`, `metric_definitions`, `feedback`, `evaluation_*`, aggregation tables.
- **API:** query APIs (tenant-scoped, permission-filtered); CSV export (permissioned).
- **Authz:** role-scoped; **never aggregates across tenants**; no raw message bodies (references only).
- **Failure modes:** aggregation is idempotent/re-runnable; freshness indicators in UI.
- **Deps:** event subscriptions from all modules (via outbox).
- **Testing:** totals-reconcile-to-events tests (FR-016), tenant-isolation on analytics.
- **Scaling:** aggregation worker; materialized views.
- **Logging:** pipeline failures only.

## Module dependency rules

- Allowed direction: channels/ai-orchestration/integrations → conversation/customers/knowledge/tenant; everyone → audit (leaf) — audit depends on nothing.
- **Forbidden:** knowledge ↔ ai-orchestration circular imports (knowledge exposes retrieval interface only); any module importing another module's repositories; analytics writing to domain tables.
- Enforced by dependency-cruiser (or eslint boundary rules) in CI.

## Future modules (not built until needed)

billing/subscriptions (D-12 deferred) · SSO/SAML (enterprise tier) · workforce management (PRD non-goal) · status page (FR-025, P2).
