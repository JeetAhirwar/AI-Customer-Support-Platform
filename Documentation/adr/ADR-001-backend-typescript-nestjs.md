# ADR-001: Backend Language and Framework — TypeScript with NestJS (Fastify adapter)

| Field | Value |
|---|---|
| Status | **ACCEPTED** |
| Date | 2026-10-16 |
| Deciders | Founder (Jeet), Technical lead |
| Decision ref | D-02 (approved) |
| Supersedes | Draft in `Documentation/ADR_DRAFTS_PENDING_APPROVAL.md` |

## Context
The platform requires one primary backend stack (Software Architecture v1 §3). The frontend, admin dashboard, and chat widget are TypeScript. Node.js v22.23.1 + npm are already installed on the development machine. Choosing Python would create a dual-language stack that the architecture documents warn against ("Avoid duplicating domain logic across stacks").

## Decision
Use **TypeScript with NestJS on the Fastify adapter** for the primary backend application.

- NestJS modules map 1:1 to the documented domain boundaries (see `SERVICE_BOUNDARIES.md`).
- Runtime validation at every boundary (class-validator/zod); TypeScript types alone are never treated as request validation.
- OpenAPI contracts generated from code (see `API_CONTRACTS.md`); automated API tests in CI.
- CPU-heavy or long-running work (document parsing, embedding, indexing, email sending) runs in the worker process, never in the API event loop.

## Consequences
- (+) One language across frontend/backend/widget/contracts; shared types; strong ecosystem; runs natively on the existing machine.
- (+) Guards, interceptors, and pipes map cleanly to tenant-context, RBAC, rate limiting, and correlation IDs.
- (−) Framework conventions must be enforced (lint rules, architecture tests) to prevent boundary erosion.
- (−) Async CPU-heavy work must be offloaded to workers from day one.
- Python 3.14 remains available on the machine for future offline evaluation jobs, only if justified by evidence (would require a new ADR).

## Compliance
Violations to flag in review: business logic inside controllers without service layer; unvalidated DTOs; direct table access bypassing repositories; blocking synchronous I/O in request handlers.
