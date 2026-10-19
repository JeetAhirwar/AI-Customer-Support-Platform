# DATABASE DESIGN
## Logical schema — PostgreSQL 17 + pgvector

| Field | Value |
|---|---|
| Status | Logical design (v1) for Phase 2 migrations; derived from Architecture v1 §8 and PRD §9 |
| Convention doc | Applies to all modules in SERVICE_BOUNDARIES.md |

## 1. Conventions

- **Primary keys:** UUID v4 (`gen_random_uuid()`), never sequential/guessable (Architecture §8).
- **Tenant scoping:** every tenant-owned table: `tenant_id UUID NOT NULL REFERENCES tenants(id)` + composite indexes leading with `tenant_id`. RLS enabled on tenant business tables + `tenant_memberships` (SECURITY.md §1, ADR-003 execution note).
- **Timestamps:** `created_at`, `updated_at` (UTC, `timestamptz`).
- **Lifecycle:** explicit status columns with CHECK constraints where practical.
- **Idempotency:** unique constraints on provider event IDs and idempotency keys **within tenant/provider scope**.
- **Content separation:** large message/file content in object storage with `body_ref`; inline `body` only where small and retention-aligned. Deletion propagation designed in from day one.
- **Secrets:** never in ordinary tables — `secret_ref` columns point to env/secret-manager entries.
- **Migrations:** expand → deploy compatible code → backfill → contract. No destructive changes without approval + backup plan.

## 2. Schema (logical — owner module in brackets)

### Tenancy & identity [identity, tenant]
- `tenants(id, name, plan, status, region, settings jsonb, created_at, updated_at)`
- `users(id, email, status, email_verified_at, mfa_enabled, created_at, updated_at)`
- `credentials(user_id PK, password_hash, algorithm, updated_at)` — Argon2id
- `sessions(id, user_id, refresh_family_id, issued_at, expires_at, revoked_at, ip_user_agent meta)`
- `invitations(id, tenant_id, email, role_id, token_hash, expires_at, accepted_at)`
- `tenant_memberships(id, tenant_id, user_id, role_id, team_id, status)` — unique(tenant_id, user_id)
- `roles(id, tenant_id, name)` · `role_permissions(role_id, permission_key)` · `teams(id, tenant_id, name)`
- `business_hours(id, tenant_id, channel, timezone, schedule jsonb)` · `feature_flags(tenant_id, key, enabled, scope jsonb)`

### Customers [customers]
- `customers(id, tenant_id, display_name, email, phone, locale, identity_level, metadata jsonb)` — unique(tenant_id, normalized external keys)
- `customer_identities(id, tenant_id, customer_id, channel, external_id, verification_state, verified_at)` — unique(tenant_id, channel, external_id)

### Conversation & cases [conversation]
- `conversations(id, tenant_id, channel, external_thread_id, customer_id, status, first_message_at, last_activity_at)` — unique(tenant_id, channel, external_thread_id) where present
- `cases(id, tenant_id, customer_id, conversation_id, status, priority, queue_id, assignee_id, sla_due_at, resolution_code, resolved_at, reopened_at)`
- `messages(id, tenant_id, conversation_id, direction, actor_type, body_ref, body_preview, provider_message_id, idempotency_key, delivery_state, sent_at, created_at)` — unique(tenant_id, idempotency_key)
- `case_events(id, tenant_id, case_id, event_type, actor_type, actor_id, metadata jsonb, occurred_at)` — append-only timeline
- `handoffs(id, tenant_id, case_id, reason, summary_ref, source_refs jsonb, destination_queue_id, state, requested_at, accepted_at, accepted_by)`

### Routing [routing]
- `queues(id, tenant_id, name, channel, team_id, priority, overflow_policy)`
- `routing_rules(id, tenant_id, queue_id, conditions jsonb, priority, enabled)` — versioned, audited
- `agent_presence(agent_id, tenant_id, status, capacity, updated_at)`

### Channels [channels]
- `channel_connections(id, tenant_id, channel, provider, external_account_id, secret_ref, status, verified_at, degraded_since)`
- `provider_events(id, tenant_id, channel, provider, provider_event_id, received_at, payload_ref, dedup_hash)` — unique(tenant_id, channel, provider_event_id)
- `widget_sessions(id, tenant_id, origin, customer_id, session_token_hash, expires_at, revoked_at)`

### Knowledge [knowledge]
- `knowledge_sources(id, tenant_id, type, uri_ref, owner_id, status, last_sync_at, issue_count, stale_after)`
- `knowledge_versions(id, tenant_id, source_id, version, approval_state, locale, effective_from, effective_to, content_ref, published_at, published_by)`
- `knowledge_chunks(id, tenant_id, source_id, version_id, seq, content_ref, content_hash, token_count, metadata jsonb, embedding vector(1536))` — HNSW/IVF index per tenant-filtered benchmark (ADR-005); `tenant_id` filter mandatory in retrieval SQL
- `approvals(id, tenant_id, version_id, actor_id, decision, decided_at, notes)`

### AI [ai-orchestration]
- `ai_config_versions(id, tenant_id, version, policy jsonb, allowed_topics jsonb, allowed_actions jsonb, model_settings jsonb, eval_gate_result jsonb, state, published_by, published_at)` — immutable versions; rollback = repoint
- `ai_decisions(id, tenant_id, case_id, message_id, config_version_id, model_id, decision, handoff_reason, source_refs jsonb, action_attempts jsonb, latency_ms jsonb, token_usage jsonb, cost_estimate, created_at)` — redacted of content

### Integrations [integrations]
- `integration_connections(id, tenant_id, provider, secret_ref, scopes jsonb, status)`
- `action_definitions(id, tenant_id, action_key, schema jsonb, sensitivity, requires_confirmation, enabled)`
- `action_executions(id, tenant_id, case_id, action_key, idempotency_key, request_ref, outcome, provider_ref, latency_ms, created_at)` — unique(tenant_id, idempotency_key)

### Analytics, feedback, audit, notifications [analytics, audit, notifications]
- `outcome_events(id, tenant_id, case_id, event_type, properties jsonb, occurred_at)` — append-only
- `metric_definitions(key, version, sql_ref, description)` — documented definitions (FR-016)
- `feedback(id, tenant_id, case_id, message_id, source, label, comment, created_at)`
- `evaluation_runs(id, tenant_id, suite, suite_version, ai_config_version, results jsonb, started_at, finished_at)`
- `audit_events(id, tenant_id, actor_type, actor_id, action, target_type, target_id, outcome, correlation_id, metadata jsonb, occurred_at)` — append-only; no message bodies
- `notifications(id, tenant_id, user_id, template, ref jsonb, read_at, created_at)`

### Async [platform]
- `outbox_events(id, tenant_id, type, schema_version, payload_ref, correlation_id, state, attempts, next_attempt_at, created_at, published_at)` — transactional outbox (ADR-002)
- `job_runs(id, event_id, worker, state, attempt, error_ref, started_at, finished_at)` — DLQ visibility

## 3. Indexing & performance notes

- All list queries: keyset (cursor) pagination on `(tenant_id, sort_key, id)`.
- Hot-path indexes: messages(conversation_id, created_at), cases(queue_id, status, sla_due_at), outcome_events(tenant_id, occurred_at).
- pgvector index chosen after Phase-3 benchmark (HNSW vs IVFFlat) with realistic tenant-filtered queries — ADR-005.
- Partitioning considered only for `messages`, `audit_events`, `outcome_events` at measured volume.

## 4. Personal-data inventory (deletion/retention planning)

| Data | Tables/storage | Deletion propagation |
|---|---|---|
| Customer contact + identities | customers, customer_identities | DB + derived embeddings + caches + exports |
| Message bodies | messages.body_ref, object storage | Object delete + index purge + retention timer |
| Email attachments | object storage | Same + downstream provider purge |
| Voice recordings/transcripts (P5) | object storage (separate permissions) | Per-jurisdiction policy (D-10) |
| AI decisions | ai_decisions (redacted) | Retention-limited; no content stored |
| Audit events | audit_events | Retained per compliance need; documented exception process |

Retention defaults are tenant-configurable; deletion jobs are audited and testable (QA-016).
