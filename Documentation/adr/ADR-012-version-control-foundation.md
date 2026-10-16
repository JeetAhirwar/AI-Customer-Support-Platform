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

## Amendment (2026-10-16, founder)
- **First commit authorized and made:** root commit `6e903df` (55 files) after a clean sensitive-file audit; `origin` remote added per founder instruction (`https://github.com/JeetAhirwar/AI-Customer-Support-Platform.git`).
- **Commit policy (founder: *"jo tumhe sahi lage"* → option b):** routine local commits are now **pre-authorized** with two standing conditions: (1) every commit passes a secrets audit (no `.env`, credentials, data, or binaries staged) and (2) tests/typecheck are green beforehand. **Every push to any remote still requires explicit founder approval**, as does adding further remotes.
- gitleaks secret scanning in CI remains a Phase-2 Gate A item per the original decision above.
