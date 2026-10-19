# Architecture Decision Records — Index

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-backend-typescript-nestjs.md) | Backend language/framework — TypeScript with NestJS (Fastify) | ✅ Accepted 2026-10-16 |
| ADR-002 | Queue and transactional-outbox pattern | 📋 Planned (Phase 2; Architecture v1 §5.4) |
| [ADR-003](ADR-003-tenant-isolation-strategy.md) | Tenant isolation strategy (repository predicates + PostgreSQL RLS) + database/migrations foundations | ✅ Accepted 2026-10-16; **RLS executed 2026-10-19** (004_rls + `aicsp_app` role, execution note in ADR) |
| ADR-004 | LLM/embedding provider abstraction and selection | 📋 Deferred to Phase 3 (D-04 open; benchmark OpenAI vs Anthropic; mock-only until spending cap approved) |
| ADR-005 | Vector retrieval store (pgvector benchmark) | 📋 Planned (Phase 3) |
| ADR-006 | Telephony/voice architecture and provider | 📋 Deferred to Phase 5 (D-06 open) |
| ADR-007 | Email provider strategy | 📋 Deferred to Phase 4 (D-05 open) |
| ADR-008 | Observability and log/trace retention | 📋 Planned (Phase 2 start, evolve) |
| ADR-009 | AI autonomy rollout policy (ladder + kill switch) | 📋 Planned (Phase 3–6) |
| [ADR-010](ADR-010-modular-monolith-extraction-path.md) | Architecture style — modular monolith with extraction path | ✅ Accepted 2026-10-16 |
| [ADR-011](ADR-011-local-dev-native-windows.md) | Local dev infrastructure — Windows-native services on E: (conditional) | ✅ Accepted 2026-10-16 |
| [ADR-012](ADR-012-version-control-foundation.md) | Version-control foundation and secret hygiene | ✅ Accepted 2026-10-16 |
| [ADR-013](ADR-013-channel-staging-chat-email-voice.md) | MVP channel staging — Chat → Email → Voice | ✅ Accepted 2026-10-16 |
| [ADR-014](ADR-014-claymorphism-visual-direction.md) | Visual design direction — restrained claymorphism | ✅ Accepted 2026-10-16 |

Numbering follows `ADR_DRAFTS_PENDING_APPROVAL.md` §2 (reconciled against the ADR-001…009 list in Software Architecture v1 §15). New decisions append as ADR-015+.
