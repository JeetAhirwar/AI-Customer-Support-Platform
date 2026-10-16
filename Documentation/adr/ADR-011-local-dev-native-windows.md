# ADR-011: Local Development Infrastructure — Windows-Native Services on E: (Conditional)

| Field | Value |
|---|---|
| Status | **ACCEPTED (conditional)** — conditions verified; **IMPLEMENTED 2026-10-16** (see Amendment) |
| Date | 2026-10-16 |
| Deciders | Founder (Jeet), Technical lead |
| Decision ref | D-03 (approved: native, conditional on checks) |

## Context
The development machine (Windows 11) has no Docker, PostgreSQL, or Redis. C: drive has ~1.1 GB free — Docker Desktop (needs ~10–25 GB) is infeasible today. E: (project drive) has **257.2 GB free** (verified 2026-10-16 via two independent methods) and the project root grants the developer Modify permissions.

## Decision
Run initial local infrastructure as **native Windows services installed on E:**:

| Service | Product | Purpose |
|---|---|---|
| PostgreSQL 17 (+pgvector) | EDB Windows x64 installer | Primary database + vector + FTS |
| Redis | Memurai (free Developer edition) or maintained Windows port | Cache, rate limits, BullMQ |
| Object storage | MinIO Windows binary | S3-compatible files/attachments |
| Local SMTP | Mailpit (single binary) | Email capture during development (mock for P2–P3) |

Conditions (the "conditional" in the status):
- Verify free space, write permissions, service compatibility, reliable startup, and documented backup/upgrade procedures **before** declaring the environment ready.
- If any check fails, **stop and present alternatives for approval** (e.g., free/relocate C: data and adopt Docker Desktop + Compose). Never switch strategies silently.
- Installation itself is a separate approval gate; each service installed on E: (not C:), running under the developer account, documented in `LOCAL_DEVELOPMENT_SETUP.md`.

Docker + Compose remains the mid-project target for cloud parity once C: space allows (tracked as an open environment task, not a decision change).

## Consequences
- (+) No C: pressure; zero licensing cost; Phase 2 can start immediately after installation approval.
- (+) MinIO/Mailpit keep S3/SMTP-shaped code honest.
- (−) Native builds may behave subtly differently from Linux containers; version pinning and scripted setup mitigate this; staging at P7 validates real parity.
- Data directories live under `Infrastructure/local-development/data/` (git-ignored) on E: with documented backup steps.

## Amendment (2026-10-16, implementation)

Install approval granted ("install approved"); all four services installed as **per-user background processes on E:** (no Windows services — the user account had no admin rights, which matches this ADR's preference anyway) and verified end-to-end including a stop → cold-start → re-verify cycle:

| Planned | Actual | Note |
|---|---|---|
| PostgreSQL 17 installer | **PostgreSQL 17.6** EDB binaries zip (per-user) | **pgvector not bundled** in the zip → deferred to Phase 3 (ADR-005), documented gap; Phase 2 unaffected |
| Memurai or maintained port | **Redis 8.10.2** Windows port (community `redis-windows/msys2` build, dev-only) | Meets BullMQ's Redis ≥6.2 requirement; AOF enabled |
| MinIO | **SeaweedFS 4.48** (S3 API on port 9000) | **D-15: MinIO official binary CDN returns 410 Gone** — substitution flagged for founder confirmation, not silent |
| Mailpit | **Mailpit v1.31.6** | As planned |

Operational quirks recorded in `LOCAL_DEVELOPMENT_SETUP.md` §7 (`pg_ctl start` hangs → direct launch + `pg_isready` polling; Seaweed `s3.config` is proto-JSON with `"identities"` top-level). One stopped check was never tripped — the MinIO unavailability was surfaced immediately as D-15 per this ADR's "never switch silently" condition. **Founder confirmed D-15 on 2026-10-16** (*"D-15: SeaweedFS confirmed."*); SeaweedFS is the selected local object/file storage.
