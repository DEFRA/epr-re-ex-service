# Project Guidance

## Engineering principles

### Testing

- Test behaviour, not implementation — tests should survive refactoring
- Descriptive test names that read as specifications
- Test pyramid: more unit tests than integration, more integration than E2E
- Flaky tests get fixed or deleted immediately — never skipped

### Code quality

- Write for humans to read, not just machines to execute
- Meaningful names that express intent without requiring comments
- Small, focused functions doing one thing well
- Don't log and re-throw — pick one. Structured logging only
- Remove dead code; don't comment it out

### Architecture

- Isolate domain logic from infrastructure concerns (ports and adapters)
- Dependencies point inward — domain core has no outward dependencies
- Design interfaces based on client needs, not implementation capabilities
- Prefer composition over inheritance
- Be pragmatic — not every call needs its own abstraction layer

### API design

- RESTful: nouns for resources, HTTP methods for actions
- Consistent error responses with meaningful status codes
- Validate all input at system boundaries

### Security

- Secrets never in code or version control
- Authenticate and authorise every non-public endpoint — they're different checks
- Validate and sanitise all external input
- Never log sensitive data (passwords, tokens, PII)

### Version control

- Small, focused PRs — one concern per PR
- Never commit directly to main; never force-push to shared branches

### Red flags

Watch for these in AI-generated code — they indicate the AI is off-piste:

- Unrequested functionality or "improvements" nobody asked for
- Test manipulation to make failing tests pass rather than fixing the code
- Complexity without corresponding simplification elsewhere
- Loops or retry patterns where a direct solution would do

### The exhaling problem

AI is excellent at adding features (inhaling) but poor at simplifying (exhaling). After feature work, actively request a simplification pass. Ask: "What can we remove? What's redundant now? Can this be simpler?" Left unchecked, AI-assisted codebases accumulate cruft faster than hand-written ones.

## Project-specific rules

### Submodules

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

### Vitest globals

- **epr-backend** and **epr-re-ex-admin-frontend**: globals enabled — do NOT import `describe`, `it`, `expect`, `vi`
- **epr-frontend**: explicit imports required — `import { describe, it, expect, vi } from 'vitest'`

### Repository contract testing

Repositories use a port/contract pattern. Define the interface in `port.js`, write contract tests in `contract/`, then implement with MongoDB and in-memory adapters that both satisfy the contract.

### Validation pipeline

Data flows through a 4-stage validation pipeline in order:

1. **meta-syntax** — structural validity (correct shape)
2. **data-syntax** — data type validity (correct types)
3. **data-business** — business rule validity (domain constraints)
4. **transform** — map to internal representation
