# DECISIONS PENDING
## AI Customer Support Platform — live decision log

Status values: **DECIDED** (confirmed + recorded in an ADR) · **OPEN** (not yet resolved) · **NEEDS APPROVAL** (a specific action awaits founder sign-off)

> **2026-10-16 — CONFIRMED:** Founder message: *"I approve all five decisions as proposed and — Use Claymorphism."* D-01, D-02, D-03, D-07, D-13 are now **DECIDED**; the claymorphism directive is recorded as **D-14 (DECIDED)**.

| ID | Decision | Resolution | Status | ADR |
|---|---|---|---|---|
| **D-01** | Architecture style | **A' — modular monolith with a service-shaped extraction path** (+ workers, future voice runtime) | ✅ **DECIDED** 2026-10-16 | [ADR-010](adr/ADR-010-modular-monolith-extraction-path.md) |
| **D-02** | Backend language/framework | **TypeScript + NestJS (Fastify adapter)** | ✅ **DECIDED** 2026-10-16 | [ADR-001](adr/ADR-001-backend-typescript-nestjs.md) |
| **D-03** | Local infrastructure strategy | **Native per-user processes on E:, conditional on checks** (space ✅ 257.2 GB & permissions ✅ verified; **install approval received 2026-10-16** — all 4 services installed + verified same day, see `LOCAL_DEVELOPMENT_SETUP.md` §2) | ✅ **DECIDED** 2026-10-16 · **IMPLEMENTED** 2026-10-16 | [ADR-011](adr/ADR-011-local-dev-native-windows.md) |
| **D-04** | LLM + embedding provider | Adapter first; benchmark OpenAI vs Anthropic on eval set; **mock providers only until spending cap approved** | ⏳ OPEN (P3) | planned ADR-004 |
| **D-05** | Email provider | Mailpit mock + adapter until provider decision | ⏳ OPEN (P4) | planned ADR-007 |
| **D-06** | Telephony provider + launch geography | Mock voice adapter first; evaluate Twilio/Vonage/Telnyx + India options (Exotel/Knowlarity) after geography decision | ⏳ OPEN (P5) | planned ADR-006 |
| **D-07** | Initialize Git + `.gitignore` | **Yes — repo initialized 2026-10-16**; ignore rules verified (`.env` ignored, `.env.example` tracked); **no commits/pushes/remotes without separate authorization** | ✅ **DECIDED** 2026-10-16 | [ADR-012](adr/ADR-012-version-control-foundation.md) |
| **D-08** | Cloud provider | AWS preferred candidate; evaluate vs cost at P7; no provisioning now | ⏳ OPEN (P7) | — |
| **D-09** | Target customer segment + launch market | **Undecided** — buyer interviews first (founder) | ⏳ OPEN | — |
| **D-10** | Retention / voice recording / consent policy | Explicit policy required before enabling recording | ⏳ OPEN (before voice launch) | — |
| **D-11** | Pilot success thresholds | Numeric targets with pilot customer | ⏳ OPEN (P7) | — |
| **D-12** | Billing/subscriptions in MVP | Default: defer | ⏳ OPEN (default defer) | — |
| **D-13** | MVP channel scope | **Chat → Email → Voice**, staged on one case model; next channel only after previous passes exit gate | ✅ **DECIDED** 2026-10-16 | [ADR-013](adr/ADR-013-channel-staging-chat-email-voice.md) |
| **D-14** | Visual design direction | **Restrained claymorphism** on the UI/UX blueprint's design tokens (intensity tiers for operational screens; WCAG 2.2 AA unchanged) | ✅ **DECIDED** 2026-10-16 (founder directive) | [ADR-014](adr/ADR-014-claymorphism-visual-direction.md) |
| **D-15** | Local object-storage server | **MinIO is unavailable from official sources** (binary CDN returns HTTP 410 Gone after their 2025 licensing change). **Selected: SeaweedFS 4.48** as the S3-compatible local object/file storage (free, actively maintained, same S3 API — code is unaffected). Installed and verified 2026-10-16 under the "install approved" gate. | ✅ **DECIDED** 2026-10-16 (founder: *"D-15: SeaweedFS confirmed."*) | ADR-011 amendment |

## Standing constraints (approved)

- **AI spending: mock providers only** — no paid LLM/embedding/email/telephony API calls without a separately approved spending cap (this is a development constraint, not a resolution of D-04).
- **No commits/pushes/remotes** without separate authorization (ADR-012).
- **No service installation** outside the approved ADR-011 scope — **install approval granted 2026-10-16** for the four local services (PostgreSQL/Redis/object-storage/Mailpit on E:); anything beyond that (Windows services, Docker, cloud) needs new approval.
- **Local object storage = SeaweedFS (D-15, confirmed 2026-10-16)**; MinIO officially unavailable.
- **No cloud provisioning, domains, or external accounts** without approval.

## Next approval gate

1. **First git commit authorization** (ADR-012 requires separate sign-off) — repo has zero commits; `origin` remote added 2026-10-16 per founder instruction; Phase-2 scaffold + docs are ready to commit in one reviewed batch once authorized.
2. Phase 2 Foundation work proceeds under the already-granted "install approved → Phase 2" mandate (scaffold done → auth → tenancy → RBAC → case schema → audit → outbox/queue → cross-tenant negative tests as release gates).
