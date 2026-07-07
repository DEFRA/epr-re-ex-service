# 40. Reset the SonarCloud new-code baseline per publish via the release tag

Date: 2026-07-07

## Status

Accepted.

## Context

On 2026-07-06 `epr-backend` and `epr-re-ex-admin-frontend` began failing the
SonarCloud gate on `main` (`new_major_violations > 0`), while the PRs that merged
were green.

Cause: a batch of rules was activated in the shared `Defra JavaScript Standard`
profile (notably `javascript:S5976`). Profile changes live in SonarCloud, not
git, and each analysis re-scans the whole codebase against the current ruleset —
so the next `main` scan raised findings on old code. Those findings counted as
"new" because the New Code Period is **Previous version**, but
`sonar.projectVersion` was never set (`package.json` is the CDP default `0.0.0`),
so the baseline was pinned to the first analysis (~2025-07-28) and the window had
grown to ~11 months. PRs stayed green because PR analysis is scoped to the diff
and ignores the New Code Period.

CDP already tags every publish with a monotonic `0.<n>.0` version; we just weren't
feeding it to Sonar.

## Decision

On `main`, set `sonar.projectVersion` to the latest existing git tag
(`git describe --tags --abbrev=0`), read in the `test-and-scan` step. The scan
runs before CDP creates the new tag, so it picks up the previous publish's
version — a value that changes every merge. `previous_version` then resets each
publish, making `main`'s "new code" ≈ the merge just deployed ≈ the PR that
produced it.

Requires `fetch-depth: 0` on the publish checkout (for tags and blame);
`publish.yml` is currently a shallow checkout. The value is harmless on PRs
(ignored by PR analysis), so it stays in the shared step with no branching.

The New Code Period mode must stay `previous_version` per project for this to work.

Alternatives rejected: **Number of days = 30** (simpler project setting, kept as
fallback, but decoupled from releases); bumping `package.json` (nothing bumps it);
`github.run_number` (meaningless); leaving it as-is (the root cause).

## Consequences

- `main` new-code scope matches PR scope, so a passing PR predicts a passing
  `main`, and future ruleset changes only touch the latest merge.
- Sonar version matches the deployed image version.
- Window is tight (one merge): it won't prompt cleanup of historical debt — use
  overall-code metrics if that's wanted.
- `previous_version` must stay selected in each SonarCloud project, or the wiring
  is inert — a repo/SonarCloud coupling to keep in mind.
- The wiring lives in the centralised `test-and-scan` action and applies to the
  scanning app repos (`epr-backend`, `epr-frontend`, `epr-re-ex-admin-frontend`).
