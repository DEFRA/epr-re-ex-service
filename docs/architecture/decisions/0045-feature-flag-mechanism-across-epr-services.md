# 45. Feature-flag mechanism across EPR services

Date: 2026-08-17

## Status

Proposed — not yet approved; left open for team review before a decision is
recorded. Jira PAE-1824, Kaizen epic PAE-1435.

## Context

`epr-backend` and `epr-frontend` both gate changes behind boolean feature flags
backed by convict env vars named `FEATURE_FLAG_*`. Those env var names are an
external contract — set by `cdp-app-config`, journey tests and CI — and must not
change.

The two services implement the _same idea_ in **markedly asymmetric** ways:

**epr-frontend — direct.** A flag is a convict entry in `config.js`, read inline
where needed:

```js
if (config.get('featureFlags.regulatorAccess')) { … }
```

No accessor layer, no typedef, no adapter. One flag exists today
(`regulatorAccess`). Adding one is ~6 lines of convict plus its call sites;
removing one deletes the same. Tests toggle it with
`config.set('featureFlags.regulatorAccess', true)`. Four production read sites.

**epr-backend — ports-and-adapters.** A whole `src/feature-flags/` module wraps the
same convict values: a port typedef (`FeatureFlags` + `FeatureFlagOverrides`), a
production adapter and an in-memory adapter each exposing one `isXEnabled()` method
per flag, two adapter test files, and a Hapi plugin decorating
`server.featureFlags` / `request.featureFlags()`. Adding one flag touches **six
files (~42 lines)** and restates the flag's name in **seven** forms that must stay
in lockstep (env var, camelCase key, a method in each of two adapters, a property
in each of two typedefs, entries in two test arrays). `feature-flags.config.js`
alone has churned across ~50 commits in an add → ship-dark → tidy lifecycle. A
dedicated `/remove-flag` skill exists because removal is a multi-file chore.

Two facts sharpen the picture:

- The `request.featureFlags()` decoration has **no** production callers — dead weight.
- `server/server.js` **already** reads a flag directly with
  `config.get('featureFlags.devEndpoints')`, side by side with the adapter used
  elsewhere. The backend is already internally inconsistent, and the direct pattern
  already works there.

So the backend's boilerplate is **self-inflicted by the wrapper**; the frontend has
no such problem because it has no wrapper. This ADR chooses how the two services
should declare and read feature flags going forward.

### Decision drivers

- Adding a flag should be ~one edit, not six files.
- The `FEATURE_FLAG_*` env vars must not change; the redesign must be invisible to
  external consumers (tests, CI, `cdp-app-config`).
- Removing a flag must stay ~one edit.
- Must clear the 100% coverage gate and the `jsconfig.typecheck` gate.
- Prefer converging the two services on **one** pattern over deepening the split.

## Decision

Two proposals are on the table. They are alternatives, not both.

### Proposal A (preferred) — converge the backend on the frontend's direct pattern

Delete the backend's `src/feature-flags/` module and the `feature-flags` Hapi
plugin. Read flags directly with `config.get('featureFlags.<name>')` at the four
call sites, exactly as the frontend and `server.js` already do. Nothing new is
invented; the simpler of the two existing patterns wins.

After this, in **both** services a flag is: one convict entry + its call sites.
Adding or removing one is a one-file change to `config.js` plus the usage. No port,
no adapter, no typedef, no generated accessor, no registry.

- **Env vars:** untouched — the convict schema and every `FEATURE_FLAG_*` name stay
  exactly as they are. Fully invisible externally.
- **Backend churn (one-off):** delete ~6 files; migrate 4 read sites from
  `server.featureFlags.isXEnabled()` to `config.get('featureFlags.x')`; drop the
  plugin registration and the `featureFlags` option from `server.js` /
  `createTestServer`; move the ~4 tests that inject `createInMemoryFeatureFlags`
  overrides to `config.set('featureFlags.x', …)` (frontend style). Net negative LOC.
- **Frontend:** unchanged — it is already the target pattern.

### Proposal B (alternative) — a single-source registry in both services

Introduce a registry file per service where each flag is declared once, and derive
the convict schema, a generic `isEnabled(flag)` accessor, and the types from it.
Keyed by the env var so a flag has a single identity; call sites read
`featureFlags.isEnabled(FLAG.X)`. (A per-flag-`isXEnabled()` variant with a
template-literal mapped type was considered and set aside: it keeps a second
identity form and leans on a type feature that risks the `jsconfig.typecheck` gate.)

This keeps a typed accessor layer and adapter-injected test overrides, at the cost
of **adding machinery neither service has today** — the frontend would take on a
registry and accessor for its single flag purely for symmetry. It is a new third
thing, which is what Proposal A avoids.

### Why A is preferred

- It removes the problem at its source rather than managing it with abstraction.
- It ends the backend's internal inconsistency and aligns the two services on one
  pattern that is already proven in production in both.
- Least steady-state surface: no registry or adapter to maintain forever. Proposal
  B has a smaller one-off diff but a permanent registry+factory to carry.

### Downsides of A, to weigh with eyes open

These are the honest costs of Proposal A. None is a blocker in our judgement, but
they are the trade and should be reviewed as such — this ADR is deliberately left
Proposed rather than Accepted so the team can weigh them.

1. **Flag names become stringly-typed.** `config.get('featureFlags.devEndpoints')`
   has no autocomplete and no compile-time existence check, where
   `isDevEndpointsEnabled()` did. Mitigation: convict throws on an unknown key, so a
   typo fails loudly at runtime and in tests rather than silently reading `false`.
   This is the single strongest argument for keeping an abstraction; if the team
   values the compile-time guarantee enough, Proposal B is the fallback.
2. **Loss of the ports-and-adapters seam.** The `FeatureFlags` port was a clean
   injection point. In practice it is barely used (four call sites, a dead
   `request` decoration) and `server.js` already bypasses it — so little is lost,
   but it is a deliberate step away from the pattern used elsewhere in the backend.
3. **Bigger one-off diff than B.** A deletes a subsystem and migrates its call
   sites and tests; B is a smaller initial change. A wins on _steady-state_ surface
   (nothing left to maintain), B on _migration_ size. We weight steady-state higher.

## Consequences

- **Both services declare and read flags identically** — one convict entry, read
  via `config.get`. `/remove-flag` collapses to "delete the convict entry and its
  call sites" in either repo.
- The `FEATURE_FLAG_*` env vars are byte-for-byte unchanged; external consumers are
  unaffected. No contract test is needed — there is no derived name to drift.
- Backend tests toggle flags with `config.set('featureFlags.x', …)` instead of
  adapter injection, restoring the default in a paired `afterEach`/`afterAll` — the
  pattern the frontend already uses. This was spot-checked and is safe here, not a
  new risk: both repos run `fileParallelism: true` with Vitest's default per-file
  isolation, so the convict `config` singleton is per test file and a `config.set`
  cannot leak across files; and the backend **already** uses `config.set(…)` in
  tests in ~48 places under this same config. The only discipline is restoring the
  flag within the file that sets it — as the frontend does today.
- Flag names are stringly-typed at `config.get` sites (no autocomplete, no
  compile-time existence check); mitigated by convict throwing on unknown keys.
- The dead `request.featureFlags()` decoration and the redundant adapter layer are
  removed — less code to reason about.
- Applies to `epr-backend` (the change) and `epr-frontend` (already conformant).
  Other services are unaffected.
