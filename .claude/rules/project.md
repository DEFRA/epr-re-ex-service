# Project Rules

## Development sequence

Work flows through these phases. Don't skip ahead.

1. **Plan** — Define what you're building before writing code. For significant work, this means ADR and/or API definition changes in `docs/architecture/`. For smaller work, a clear scope with acceptance criteria is sufficient. Plans should target small, focused PRs.
2. **Review the plan** — Get human approval before implementation begins.
3. **Implement and test** — Write code and tests together.
4. **Verify** — All CI checks must pass before requesting review: formatting, linting, JSDoc type correctness, and 100% test coverage.
5. **Review** — Both automated and human review before merging.
6. **Commit and deliver** — Commit, push, and open a PR.

## Submodules

9 submodules under `lib/`:

| Path | Repo | Aliases |
|------|------|---------|
| `lib/epr-backend` | `DEFRA/epr-backend` | backend, BE |
| `lib/epr-backend-journey-tests` | `DEFRA/epr-backend-journey-tests` | backend tests, BE tests |
| `lib/epr-backend-performance-tests` | `DEFRA/epr-backend-performance-tests` | backend perf tests |
| `lib/epr-frontend` | `DEFRA/epr-frontend` | frontend, FE |
| `lib/epr-frontend-journey-tests` | `DEFRA/epr-frontend-journey-tests` | frontend tests, FE tests |
| `lib/epr-frontend-performance-tests` | `DEFRA/epr-frontend-performance-tests` | frontend perf tests |
| `lib/epr-re-ex-admin-frontend` | `DEFRA/epr-re-ex-admin-frontend` | admin frontend, admin FE |
| `lib/epr-re-ex-admin-frontend-tests` | `DEFRA/epr-re-ex-admin-frontend-tests` | admin tests |
| `lib/epr-re-ex-admin-fe-perf-tests` | `DEFRA/epr-re-ex-admin-fe-perf-tests` | admin perf tests |

Commits happen inside submodules, never in the parent repo (except docs/architecture changes).

## Vitest globals

- **epr-backend** and **epr-re-ex-admin-frontend**: globals enabled — do NOT import `describe`, `it`, `expect`, `vi`
- **epr-frontend**: explicit imports required — `import { describe, it, expect, vi } from 'vitest'`

## Repository contract testing

Repositories use a port/contract pattern. Define the interface in `port.js`, write contract tests in `contract/`, then implement with MongoDB and in-memory adapters that both satisfy the contract.

## Validation pipeline

Data flows through a 4-stage validation pipeline in order:

1. **meta-syntax** — structural validity (correct shape)
2. **data-syntax** — data type validity (correct types)
3. **data-business** — business rule validity (domain constraints)
4. **transform** — map to internal representation
