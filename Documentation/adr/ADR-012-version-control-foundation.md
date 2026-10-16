# ADR-012: Version-Control Foundation and Secret Hygiene

| Field | Value |
|---|---|
| Status | **ACCEPTED** |
| Date | 2026-10-16 |
| Deciders | Founder (Jeet), Technical lead |
| Decision ref | D-07 (approved: yes) |

## Context
The project had no version control. Controlled change history and repository hygiene are prerequisites for safe implementation, CI, and review.

## Decision
- Initialize a Git repository in the project root with a comprehensive `.gitignore` covering: `.env` and local env files, credentials, `node_modules/`, build outputs, logs, local database/data directories (`Infrastructure/local-development/data/`), OS/editor artifacts, and generated files.
- `.env.example` contains placeholder values only — never real secrets.
- **No commits, no remotes, no pushes without separate explicit authorization from the founder** (init + ignore rules only are authorized by this ADR).
- Secret scanning (gitleaks) enters CI in Phase 2 (Gate A); a pre-first-commit secret scan is mandatory.

## Consequences
- (+) Traceable history; safe collaboration foundation; ignore rules block the most common secret-leak vector.
- (−) None material; the no-commit rule requires discipline and is documented in the root README.
