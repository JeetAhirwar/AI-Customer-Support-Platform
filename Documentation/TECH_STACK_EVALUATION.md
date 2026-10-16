# TECHNOLOGY STACK EVALUATION
## AI Customer Support Platform — Phase 1 input (pre-approval)

Purpose: compare viable options per layer against the criteria in the Master Project Prompt (reliability, security, scalability, dev speed, TCO, developer availability, ops complexity, integration ecosystem, maintainability, vendor lock-in, **local Windows dev experience**, multi-tenant SaaS suitability). Cross-checked against `Software_Architecture_v1`, `PRD_v1`, and `Development_Implementation_Plan_v1`. **No selection is final — see `TECH_STACK_RECOMMENDATION.md` and `DECISIONS_PENDING.md`.**

Environment constraints that weight the evaluation (verified 2026-10-15):
- Node v22.23.1 + npm present; Python 3.14 present; Git present. **No Docker, no Postgres, no Redis, no pnpm.**
- **C: drive ≈1.2 GB free** → anything large (Docker/WSL) is currently impractical; E: has 257 GB free.

---

## 1. Frontend — Admin console, Agent workspace, Chat widget

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **React + TypeScript** (Vite) | Docs' recommendation; huge ecosystem; typed contracts shared with backend; best hiring pool; strong accessibility tooling | Needs discipline for state/data-layer conventions | **Recommended** |
| Next.js (React framework) | SSR, routing, auth helpers, Vercel hosting | Server model assumes its own runtime; overkill for an internal admin SPA served behind an API; couples deploy to Next conventions | Only if public marketing/portal SSR is wanted in same app |
| Vue 3 + TS | Simpler learning curve, good docs | Smaller ecosystem for this use-case; team/skills unknown | Viable, not preferred |
| Angular | Opinionated, enterprise | Heavier, slower dev iteration for small team | Not preferred |

**Chat widget** should be a separate tiny bundle (React/Preact or vanilla TS, <50 KB gz) buildable independently, CDN-hostable, with zero admin-app dependencies — matches Architecture doc ("Static frontend hosted via CDN").

## 2. Backend language & framework

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **TypeScript — NestJS on Fastify** | One language frontend→backend→widget→contracts; NestJS gives module structure that *enforces* the doc's module boundaries (Architecture §4); OpenAPI-first; guards/interceptors map cleanly to tenant-context + RBAC; Node 22 installed today | Slightly less mature numeric/AI-pipeline ergonomics than Python | **Recommended** |
| TypeScript — Fastify (bare) / Express / Fastify+plugins | Minimal, fast | Fewer guardrails; team must build own modular conventions (risk to "modular monolith" discipline) | Acceptable; NestJS wraps Fastify anyway |
| Python — FastAPI | Best AI/ML library ecosystem; async; fast to write | Second language = duplicated domain logic risk (docs explicitly warn); typing/OpenAPI weaker; frontend contract sharing harder; ops split | Only if team is Python-first |
| Java/Spring or C#/.NET | Enterprise-grade | No toolchain on this machine for .NET; slower iteration for this team; larger runtime footprint | Not preferred |

Polyglot (TS core + Python AI service): Architecture doc allows *only if justified*. Not justified initially — every AI capability needed (RAG, eval, orchestration) has mature TS libraries. A Python service can be extracted later for eval jobs if needed (ADR-004/008).

## 3. Primary database

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **PostgreSQL 16/17 (+pgvector)** | Docs' baseline; relational case/conversation data fits perfectly; JSONB for channel metadata; pgvector avoids a second datastore; RLS for defense-in-depth tenant isolation (Architecture §7); mature backups/PITR; runs as native Windows zip on E: | Single-server scale ceiling (fine for years at pilot scale) | **Recommended** |
| MySQL 8 | Familiar | Weaker JSONB/RLS/vector story for this design | Not preferred |
| MongoDB / document store | Flexible | Poor fit for relational case graph, SLA timers, transactions | Not preferred |
| DynamoDB / Cloud SQL serverless | Managed scale | Lock-in; modeling pain for this domain; cloud-only | Not for core |

**Vector search:** pgvector first (Architecture doc explicitly), behind a retrieval interface so a dedicated vector DB (Qdrant/Milvus/pgv) can replace it later. Benchmark before adopting anything heavier (ADR-005).

## 4. Cache, queue & async processing

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Transactional outbox table in Postgres + worker polling → BullMQ/Redis for hot dispatch** | Satisfies Architecture §5.4 (outbox is the reliability source of truth); Redis optional until needed; survives restarts; simplest local story (Postgres alone can run the queue at first) | Polling latency (ms-level, fine); two mechanisms to reason about | **Recommended path** |
| Redis + BullMQ alone | Simple, feature-rich (retries, DLQ, rates) | Redis data loss risk without persistence tuning; docs warn not to rely on non-durable paths | Use *behind* the outbox, not instead of it |
| RabbitMQ | Mature routing, ACKs, DLX | Extra ops surface; Windows install friction; not needed at pilot scale | Defer |
| Kafka / Redpanda | Streaming, replay | Heavy ops; wrong scale; overkill | No |
| pg-boss (Postgres-only queue) | Zero extra infra; transactional with outbox | Less mature; throughput limits | Good *fallback* if we want absolute minimum infra |
| Cloud-managed (SQS/Cloud Tasks/Service Bus) | Fully managed | Cloud lock-in before cloud decision; useless locally | Adopt at P7 with chosen cloud |

## 5. Search & knowledge retrieval

- **Postgres full-text search (tsvector) + pg_trgm for keyword, pgvector for semantic** — hybrid retrieval on one datastore. No extra service, no extra cost, tenant filters trivially enforced in SQL (Architecture §7 requires filters *in the retrieval query*).
- Elasticsearch/OpenSearch/Mev: only if cross-language enterprise search becomes a real requirement. Not now.

## 6. File & object storage

| Option | Local dev | Cloud | Verdict |
|---|---|---|---|
| **MinIO (S3 API) native Windows binary on E:** | Free, single exe, identical API | — | **Recommended local** |
| SeaweedFS | Fine | Fine | Alternative |
| Local disk folders | Simplest | Diverges from prod; unsafe URL/scope handling | Avoid — keeps S3-shaped code honest |
| AWS S3 / GCS / Azure Blob / Cloudflare R2 | — | Managed; R2 cheapest egress | Choose at P7; keep S3-compatible API |

## 7. Real-time communication (chat + agent inbox)

- **Native WebSockets (ws) behind the API with token-authenticated sessions** — simplest, provider-neutral.
- Socket.IO: adds fallbacks/rooms at payload cost; acceptable if we want auto-reconnect semantics for the widget. Decide during P3.
- SSE: fine for one-way pushes (agent presence), not for bidirectional chat.
- 3rd-party realtime (Pusher/Ably): avoid lock-in; not needed.

## 8. Authentication & authorization

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Own Identity module: Argon2id password hashing, short-lived access tokens + rotating refresh, email verify/reset, MFA-ready design, RBAC + resource-scoped checks** | No vendor lock-in; data model in docs already assumes `identity_provider_id` abstraction so a provider can be added later; full control of tenant-membership semantics | We own security burden; must follow OWASP ASVS and test hard | **Recommended for MVP** |
| Auth0 / Clerk / Descope | Fast, MFA/SSO out of box | Per-user cost at scale; multi-tenant membership mapping still ours; lock-in | Strong alternative if you want SSO on day 1 |
| Keycloak (self-hosted) | Free, B2B features | Heavy Java ops on a Windows laptop; overkill pre-pilot | No |

SSO/SAML: keep behind an interface (Architecture: "SSO/MFA integration") for enterprise tier later.

## 9. AI orchestration, LLM & embeddings

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Provider-adapter layer (own thin interface) + one primary LLM** | Docs mandate adapters (ADR-004); enables eval-gated swaps, per-tenant routing, cost caps | We write/maintain the adapter | **Recommended** |
| Vercel AI SDK / LangChain / LlamaIndex (TS) | Useful primitives (streaming, retries, chunking) | Framework churn; LangChain abstraction leaks; can obscure the strict policy→retrieve→generate→validate pipeline | Use selectively (e.g., chunking, streaming helpers) — not as the architecture |
| OpenAI | Best tooling breadth; embeddings mature | Cost; data-residency questions | Shortlist |
| Anthropic Claude | Strong quality/safety; long context | Slightly costlier at volume | Shortlist |
| Gemini | Price/perf attractive | Ecosystem maturity for this design | Backup |
| Azure OpenAI | Enterprise terms, data residency | Azure commitment | If enterprise/residency demands |
| Local models (Ollama/vLLM) | Zero per-token cost; full data privacy | GPU absent on this machine; ops + quality risk; latency for voice | No for MVP |

**Embeddings:** same adapter discipline (OpenAI `text-embedding-3` vs open-weights via API). **Reranking + hybrid retrieval** before any exotic stack. Voice STT/TTS rides the same adapter pattern (P5).

## 10. Voice & telephony (P5)

| Option | Regions | Notes |
|---|---|---|
| Twilio | Global incl. India | Broadest APIs/media streams; priciest; number costs money → approval |
| Vonage | Global | Competitive; media streaming |
| Telnyx | Global, strong voice API | Good voice-first story |
| **Exotel / Knowlarity / Kaleyra** | India-focused | If launch geography = India (TRAI compliance, local numbers, DND rules) — likely relevant here |

Decision depends on **launch geography (D-06)**. Until approved: fully mocked voice adapter (explicitly labeled mock) so call-state machine, transfer logic, and case linkage are testable for free. (Docs: mocks OK if honestly labeled.)

## 11. Email (P4)

| Option | Inbound | Outbound | Notes |
|---|---|---|---|
| **MS Graph (Outlook/M365 mailbox)** | Change notifications + MIME | Send API | Strong if customers are on M365; OAuth app registration needed |
| Google Workspace Gmail API | Push pub/sub | Send | Same pattern for Google shops |
| Postmark / SendGrid / Mailgun routes | Inbound parse webhooks | Send APIs | Provider-agnostic inbound; best deliverability tooling; per-use cost |

Architecture: **one EmailProviderAdapter interface**; pick primary at P4 after your decision. Local dev: **Mailpit** (single Windows binary, SMTP + web UI, zero cost) until real credentials exist.

## 12. Observability

- **OpenTelemetry SDK (traces) + pino (structured JSON logs) + Prometheus-compatible metrics** — docs' baseline.
- Local: **Grafana + Loki + Tempo + Prometheus** in compose later; on Windows-first, start with structured logs + an OTel collector export; Grafana Cloud free tier is an option (needs your approval for a cloud account).
- **Sentry** (or GlitchTip self-hosted) for error aggregation — decision later; no secrets in payloads.

## 13. Testing

- **Vitest** (unit/integration, fast, TS-native) + **Supertest**-style HTTP assertions.
- **Playwright** (E2E: widget, inbox, admin flows; accessibility checks via axe).
- **Contract tests:** OpenAPI-generated types + schema validation for webhooks (Schemathesis or custom).
- **AI evaluation harness:** versioned JSONL test sets (correctness, groundedness, refusal, injection, escalation precision) run in CI as a gated job with a real model API key (or recorded fixtures) — required by PRD §7.3 and Gate D.
- **k6** (load) at P7; **npm audit + better-npm-audit / Snyk-free tier** + secret scanning (gitleaks) in CI from day 1 (Gate A).

## 14. Local development & containers

| Option | Feasibility here | Verdict |
|---|---|---|
| **Native Windows services on E:** — Postgres (zip), Redis/Memurai, MinIO, Mailpit as background services; VS Code + npm workspace | Works today, zero admin risk, no C: usage | **Recommended now** |
| Docker Desktop + compose | Blocked: C: ≈1.2 GB free; install needs disk + approval | Adopt when C: freed (recommended mid-P3) |
| WSL2 + docker engine | Same disk constraint; better perf than Docker Desktop | Alternative to Desktop |
| OrbStack/colima | macOS only | N/A |

Dev env manager: **mise/asdf or plain documented installers**; pnpm via corepack (no admin). Monorepo tooling: **pnpm workspaces + Turborepo** (build/test caching; needed once ≥3 apps exist).

## 15. Cloud deployment & CI/CD (P7 — evaluation only)

| Option | Fit |
|---|---|
| **AWS** (ECS Fargate/RDS/S3/SES/Secrets Manager/SQS) | Docs-aligned "managed services, containers, no K8s until justified"; widest managed surface; cost moderate |
| GCP (Cloud Run/Cloud SQL/GCS) | Excellent dev experience; fewer India edge nodes |
| Azure (Container Apps/Cosmos-free/Key Vault; OpenAI service) | Best if enterprise customers demand it; ties to M365 email story |
| Railway/Render/Fly.io | Fastest pilot deploy; watch cost + vendor depth at scale |
| Kubernetes (any) | Explicitly deferred by docs until ops needs justify |

CI/CD: **GitHub Actions** (private repos — free tier or your plan), IaC with **Terraform** (cloud-agnostic, reviewable). Blue/green or canary behind feature flags per Architecture §11.

## 16. Scoring summary (1 = poor, 5 = excellent for *this* project *right now*)

| Layer | Winner | Alternatives |
|---|---|---|
| Frontend | React+TS (5) | Vue (4) |
| Widget | Preact/vanilla TS bundle (5) | — |
| Backend | NestJS/Fastify TS (5) | FastAPI (4, but split-stack penalty) |
| DB + vector | PostgreSQL + pgvector (5) | — |
| Queue | Outbox + BullMQ/Redis, pg-boss fallback (4) | RabbitMQ (3) |
| Search | Postgres FTS + pgvector (5) | OpenSearch (3) |
| Storage | MinIO local → S3/R2 (5) | — |
| Auth | Own identity module (4) | Auth0/Clerk (4, faster but $/lock-in) |
| LLM | Adapter + OpenAI/Anthropic shortlist (4) | Local models (2, no GPU) |
| Voice | Mock now → Twilio/Telnyx or Exotel (TBD) | — |
| Email | Adapter + Mailpit now → Graph/Gmail/Postmark (4) | — |
| Observability | OTel + pino (+Grafana stack) (4) | Vendor suites ($$) |
| Local infra | Native on E: (4) | Docker (5 later, blocked now) |
| Cloud | AWS ECS+RDS (4) | GCP/Azure (4) |

Rationale for every final pick and the exact proposed stack: see `TECH_STACK_RECOMMENDATION.md`.
