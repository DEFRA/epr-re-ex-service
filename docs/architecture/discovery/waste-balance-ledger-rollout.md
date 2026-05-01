# Waste Balance Ledger — Rollout and Cutover Strategy

## Status

Proposed — sign-off required before the rollout and cutover work is scoped.

## Context

[ADR 0031](../decisions/0031-waste-balance-transaction-ledger.md) moves waste balance transactions from an embedded `transactions[]` array on each waste-balance document into a separate append-only ledger collection. Each transaction carries its own running totals (`closingAmount`, `closingAvailableAmount`) so the current balance is a single indexed read on the highest-numbered transaction per accreditation.

Two separable decisions remain before the flag can start flipping on:

1. **Environment rollout order** — which environments, in what order, and what signals gate promotion between them.
2. **Per-accreditation data cutover** — how an accreditation moves from "balance derived from v1 document" to "balance derived from v2 ledger" without losing its current balance.

A `FEATURE_FLAG_WASTE_BALANCE_LEDGER` convict entry and cross-environment `false` default are already in flight (epr-backend#1115 and cdp-app-config#3287). Shadow dual-write is excluded by the ADR — single-write with dual-read fallback is the only mechanism on the table.

## Part A — Environment rollout

### Recommended order

`dev → test → ext-test → perf-test → prod`

Standard Defra order for the first four environments. The question is where `perf-test` slots in relative to prod. The recommendation is **before**, because:

- The ledger changes the write path from one atomic document update (v1: `$set` + `$push $each` on the waste-balance doc) to N independent optimistic appends across the ledger collection. A 200-row summary log becomes 200 indexed-read + 200-insert round-trips, each potentially retrying on unique-index conflict.
- The read path drops from "load a potentially large embedded document" to "one indexed read on the latest ledger row". This is strictly cheaper, but it is worth measuring under representative load before it reaches the customer-facing environment.
- Dev, test, and ext-test do not produce the load profile that exposes write amplification or retry churn. Perf-test does. Catching a pathological interaction in perf-test is an order of magnitude cheaper than catching it in prod.
- `infra-dev` and `management` are not customer-facing and are not in the promotion path; they do not need the flag set.

### Promotion gates

Each step requires signals to clear before the next flag-flip PR lands in `cdp-app-config/main/services/epr-backend/<env>/epr-backend.env`.

| Environment | Soak                                                                                                                                                             | Required signals                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev         | 3–5 working days                                                                                                                                                 | No unhandled exceptions in logs referencing ledger writes or reads. `wasteBalance.ledger.write{outcome=exhausted} = 0`. Journey tests green.                                                                                                                                                                                           |
| test        | 3–5 working days                                                                                                                                                 | Same as dev, plus end-to-end journey tests covering summary-log submission and PRN lifecycle green against v2.                                                                                                                                                                                                                         |
| ext-test    | 5 working days                                                                                                                                                   | Same as test, plus at least one external reprocessor has a v2 transaction written through normal operation (observable via `wasteBalance.ledger.write` trending up).                                                                                                                                                                   |
| perf-test   | One full perf run covering both summary-log submission **and** the PRN lifecycle (creation, issuance, acceptance, cancellation) at peak scale, plus 48-hour soak | Write-path p99 latency within the agreed SLO envelope for each `sourceKind`. Read-path p99 unchanged or improved against the v1 baseline captured pre-flip. `wasteBalance.ledger.write{outcome=exhausted} = 0` across the full run. No unexpected query-planner regressions visible in MongoDB Atlas explain plans on the new indexes. |
| prod        | Ongoing monitoring                                                                                                                                               | Flag flip lands in a low-traffic window; first 72 hours are tightly monitored per the alert rules in §Observability.                                                                                                                                                                                                                   |

"Signals clear" means the reviewer of the next flag-flip PR can point at the dashboards and alerting history for the previous environment and show that the gates above are met. This is a human judgement; dashboards and metric names below are the inputs.

### Rollback protocol

Read/write routing for each accreditation is governed by its canonicality marker on the v1 waste-balance document, not by the global feature flag. The flag governs only whether new migrations trigger; the marker governs routing for each accreditation. Two rollback shapes apply.

**Pause the rollout.** Flip `FEATURE_FLAG_WASTE_BALANCE_LEDGER` from `true` back to `false`. New summary-log submissions skip the migration trigger, so no further accreditations move to v2. Already-migrated accreditations continue on v2 because their marker still reads "v2"; they remain readable and writable through the ledger. Accreditations still on "v1" stay there. This is safe at any point.

**Roll a specific accreditation back to v1.** Flip its marker from "v2" back to "v1". Reads return to v1's `amount` / `availableAmount`, writes return to v1's embedded array. The ledger entries for that accreditation become durable but inert. Because the v1 document was never mutated by v2 traffic — v2 writes go to the ledger, not back into v1's `transactions[]` — its `amount` / `availableAmount` reflect state as of the migration moment. A rollback after broad v2 activity recovers via the same operator-re-upload path that any v1-first scenario uses; the dual-read helper sees the marker, routes to v1, and the operator re-establishes current totals there.

**Operational rule: do not delete ledger entries on rollback.** The entries are correct per-row history for that accreditation. If an accreditation is later re-migrated, the rebuild path is responsible for clearing or superseding the prior attempt's entries; "wipe and redo" between rollback and re-migration leaves a window where the ledger and v1 disagree on history.

`cdp-app-config` flag flips trigger a service redeploy, so pausing the rollout has 5–10 minute latency. Per-accreditation marker flips are a database operation and are effectively instant.

## Part B — Per-accreditation cutover

### Recommendation

**Lazy per-accreditation migration, triggered by the next summary-log submission for each accreditation, rebuilding the ledger from authoritative sources (waste records + PRN history).**

Each accreditation carries a canonicality marker on its v1 waste-balance document. While the marker reads "v1", the existing v1 write path runs as today and reads come from v1 `amount` / `availableAmount`. The first summary-log submission for that accreditation under flag-ON triggers a post-commit rebuild: the ledger is populated by replaying the accreditation's waste-records history and PRN operation history, then the marker flips to "v2" via an etag-conditional update on the v1 document. Subsequent reads and writes for that accreditation route to the ledger.

### Why rebuild from authoritative sources, not v1-transaction replay

Full-fidelity replay of the v1 embedded `transactions[]` array would be the textbook answer. It is rejected because v1 transaction entities carry the naked `rowId` plus waste-record version ids (`currentVersionId`, `previousVersionIds[]`), but no direct `wasteRecordId` or `summaryLogId`. An accreditation's historical v1 transactions cannot be deterministically mapped back to waste records without an ambiguous join — the same `rowId` recurs across monthly summary logs for the same supplier row. The PAE-1364 incident is the live demonstration of that ambiguity.

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) sidesteps that ambiguity by deriving balance directly from the waste records collection. That makes waste records the current source of truth for balance, and PRN history the source of truth for PRN-driven contributions. Rebuilding the ledger from those two collections is unambiguous, preserves real `wasteRecordId` / `summaryLogId` / `prnId` linkage on each replayed transaction, and preserves real `createdBy` user attribution rather than a synthetic system actor.

This dissolves three problems a seed-forward design would have carried: there is no PRN lifecycle continuity gap, no `manual-adjustment` reintroduction needed as an inflation-correction escape hatch, and no post-cutover-of-pre-cutover-row inflation risk because the ledger already carries each row's original contribution. Reinstating the ledger as the authoritative source of truth — not a forward-only ledger seeded from v1 closing totals — is the goal of PAE-1382 itself; rebuilding from authoritative sources delivers it directly.

### Why not bare on-next-write (the ADR's literal wording)

The ADR says "reads fall back to v1 until each accreditation has been transitioned to the ledger". The simplest reading is: first v2 write creates the first ledger entry, reads flip to v2 from that point. This fails:

| Scenario                                                                       | v1 balance                            | First post-flip event                                       | v2 ledger closing   | v2 reads | Correct balance | Result    |
| ------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------- | ------------------- | -------- | --------------- | --------- |
| Accreditation A, full re-upload of every summary log that built the v1 balance | 500 (from five rows × 100, one log)   | Five identical-target rows, reconciliation delta = 100 each | 500                 | 500      | 500             | ✓ by luck |
| Accreditation B, new summary log with new rows                                 | 500 (built up over prior months/logs) | Three new rows × 100, reconciliation delta = 100 each       | 300                 | 300      | 800             | ✗         |
| Accreditation C, PRN operation                                                 | 500                                   | Issuance emits pending-debit of 50                          | opens 0, closes -50 | -50      | 450             | ✗         |

Scenario A only passes because the operator happens to re-upload every row that contributed to v1 — a coincidence, not a property of bare-on-next-write. If the v1 balance was built over several months' uploads and the operator re-uploads only the current month, the ledger closes well short of 500 and the read is wrong, exactly like scenario B. Bare-on-next-write is 0 of 3 as a cutover mechanism.

The write path computes `delta` per row against the ledger's own history (per ADR §Per-row delta reconciliation) or, for PRN operations, uses the delta directly. In both cases the ledger's opening totals default to zero for a newly-transitioned accreditation, so the closing totals reflect only what happened post-transition. An active rebuild is required to seat the ledger with real history before reads route to it; the lazy migration below performs that rebuild before the marker flips.

The reconciliation invariant's "re-upload is the recovery path" framing in the ADR is about **partial-submission recovery mid-write**, not about cutover. Cutover is a different problem and needs a different mechanism.

### Migration shape

When the flag is ON and an accreditation's marker reads "v1", the next summary-log submission for that accreditation triggers a post-commit rebuild:

1. **Submit to v1.** The existing summary-log write path runs unchanged. The user's submission succeeds or fails on its own merits, independent of migration outcome. If migration subsequently fails, v1 stays canonical and the rebuild retries on the next submission.
2. **Capture the v1 etag.** Read the v1 waste-balance document and record its etag (or `_v` field equivalent — whichever the repository layer exposes for optimistic concurrency).
3. **Replay history into the ledger.** Walk the waste records collection in order and append a `summary-log-row` ledger transaction per row with real `wasteRecordId` / `summaryLogId` / `createdBy`. Walk the PRN history in order and append a `prn-operation` ledger transaction per operation with real `prnId` / `operationType` / `createdBy`. Each append uses the existing `appendToLedger` primitive with audit emission suppressed (§Audit emission suppression).
4. **Flip the marker conditionally.** Update the v1 document setting the canonicality marker to "v2", with the etag captured at step 2 as the conditional predicate. If the predicate matches, the flip lands and reads/writes for that accreditation route to v2 from this point. If it does not match — a concurrent PRN write or summary-log write incremented the etag during the rebuild — the flip no-ops, the ledger entries from this attempt are cleared, and the rebuild retries on the next summary-log submission.

Migration runs after the user's submission has committed. It is a best-effort post-commit step. A failure (transient infrastructure error, etag conflict, anything else) leaves v1 canonical and the rebuild retries next time. The user never sees a migration failure surfaced as a submission failure.

### Triggering and serialisation

The summary-log submission flow already serialises submissions per accreditation via the diff-preview check that gates write-on-confirm. No additional per-accreditation mutex is required; two concurrent summary-log submissions for the same accreditation cannot both reach the migration step.

PRN write paths read the per-accreditation marker and route accordingly: marker "v1" → write to v1 embedded array; marker "v2" → append to ledger. PRN writes do not themselves trigger migration. An accreditation that only sees PRN traffic during the rollout window stays on v1 until either (a) a summary-log submission arrives to trigger migration, or (b) the long-tail sweep migrates it as part of v1 retirement preparation (§Long-tail sweep).

### PRN concurrency during migration

The rebuild reads PRN history at step 3 and flips the marker at step 4. A PRN write that lands between those two steps is a real concurrency hazard: it would mutate the v1 document (appending to `transactions[]`, decrementing `availableAmount`) without the rebuild seeing it, and the marker flip would commit a ledger that's already stale.

The etag-conditional flip handles this without needing a lock or a snapshot-and-tail. The PRN write path mutates the v1 document; that mutation increments the etag. At step 4, the rebuild's conditional update tests the etag captured at step 2 against the document's current etag. A concurrent PRN write makes them diverge, the conditional update no-ops, and migration retries on the next summary-log submission. The PRN write itself is unaffected — it lands on v1 as designed because the marker is still "v1" at that moment.

Ledger entries written during a failed-flip rebuild attempt are cleared as part of the retry path. The implementing work decides whether the cleanup is a transactional rollback (rebuild and flip in one MongoDB session) or a delete-by-prefix on next-attempt detection; both shapes preserve correctness.

### Audit emission suppression

`appendToLedger` currently emits two side effects per call: a `safeAudit` entry and a `systemLogsRepository.insert`. Each replayed transaction during migration represents an event that was already audited at the time of its original submission — emitting fresh audit entries during the rebuild would produce duplicate audit history with timestamps that don't match the originals.

The migration path passes a flag to `appendToLedger` that suppresses both side effects. The flag is gated to the rebuild caller only; ordinary write paths cannot pass it. The signal that migration occurred is carried by the dedicated migration-outcome metric (§Observability), not by audit entries.

### Long-tail sweep

Some accreditations never submit a summary log post-flag-flip — for example, accreditations that have wound down or expect to issue PRNs against already-recorded waste without further submissions. The lazy mechanism never reaches them.

A long-tail sweep migrates those as a prerequisite for v1 retirement (tracked separately). The sweep iterates accreditations whose canonicality marker is still "v1" after the broad-population rollout has saturated, and runs the same rebuild-and-flip process administratively. It is required before the flag and v1 collection can be retired; the implementing work scopes it as its own piece under the rollout/cutover execution chain.

### Sequencing with the PAE-1364 workaround

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) made waste records the current source of truth for balance. This design's rebuild reads from that same source, so PAE-1364 recovery does not need to complete before cutover — the rebuild is itself the recovery path, applied uniformly across all accreditations rather than only the seven flagged by PAE-1364. Reinstating the ledger as authoritative supersedes the workaround at the same time.

The cutover order is:

1. Flag-gated read and write paths deploy everywhere with the flag OFF — including the canonicality marker on the v1 schema, the dual-read helper that consults the marker, the PRN write path that routes on the marker, and the lazy-rebuild trigger on summary-log submission.
2. Flag flips on per-environment (`dev → test → ext-test → perf-test → prod`) following the promotion gates in §Part A. Each environment's first summary-log submission per accreditation post-flip triggers that accreditation's migration.
3. Long-tail sweep runs after the broad-population window has saturated in each environment, migrating accreditations that never submitted again.
4. v1 retirement (tracked separately) follows once monitoring confirms zero v1-fallback reads and zero v1 writes.

## Observability

`epr-backend` emits custom metrics via AWS Embedded Metric Format (`aws-embedded-metrics`) using the helpers in `src/common/helpers/metrics.js`. Metrics land in CloudWatch under the service's namespace and are visualised in the CDP Grafana dashboards (CDP [custom metrics](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/custom-metrics.md) and [monitoring](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/monitoring.md) guides). Metric names use dotted CamelCase and dimension values are lowercased; the existing `summaryLog.statusTransition`, `summaryLog.validation.duration`, and `summaryLog.rows.outcome` set the convention. There is no existing `wasteBalance.*` metric namespace yet — this proposal introduces one.

The spike settles **what signals are needed and at what threshold**. Exact metric names, dimension keys, and stat-aggregation choices (sum vs average vs p99) are confirmed in the implementing work against the `summaryLog.*` precedents; the shape below is indicative.

### Signals

| Signal                                  | Proposed metric                      | Dimensions                                                                                        | Purpose                                                                                                                           |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Ledger write throughput and retry shape | `wasteBalance.ledger.write`          | `sourceKind` (`summary-log-row` / `prn-operation`), `outcome` (`success` / `retry` / `exhausted`) | Per-source-kind counts; retry and exhausted outcomes expose contention behaviour under load.                                      |
| Ledger write latency                    | `wasteBalance.ledger.write.duration` | `sourceKind`                                                                                      | Duration in ms. Grafana surfaces avg/p95/p99 via CloudWatch stats.                                                                |
| Ledger read distribution                | `wasteBalance.ledger.read`           | `primitive`, `outcome` (`ledgerHit` / `v1Fallback` / `error`)                                     | `v1Fallback` count trends to zero as marker flips saturate per environment.                                                       |
| Ledger read latency                     | `wasteBalance.ledger.read.duration`  | `primitive` (`getCurrentBalance`, `getCreditedAmountByWasteRecordId`, …)                          | Duration in ms per primitive. Baseline captured pre-flip; post-flip should be equal or better.                                    |
| Migration outcome                       | `wasteBalance.cutover.migration`     | `outcome` (`success` / `etagRetry` / `failed`)                                                    | One count per rebuild attempt. Cumulative `success` paired with known total accreditation count gives % progress per environment. |

### Dashboards

The service already has a platform-provisioned dashboard per CDP convention. For the rollout, add a custom dashboard in `Playground/epr-backend-monitoring` per the CDP monitoring guide, then request promotion after dev bakes in:

1. **Rollout progress.** `wasteBalance.ledger.read` split by `outcome`, per environment. `v1Fallback` fraction trending to zero is the cutover-complete signal.
2. **Write health.** `wasteBalance.ledger.write.duration` p99 per `sourceKind`; `wasteBalance.ledger.write` with `outcome=retry` rate and `outcome=exhausted` rate. Exhausted panel has a "should always be zero" annotation.
3. **Migration progress and health.** `wasteBalance.cutover.migration` split by `outcome`, per environment. `success` cumulative against the known total accreditation count gives % progress; sustained `etagRetry` flags PRN traffic outpacing the rebuild; `failed` should trend to zero.

Dashboards are created in the `Playground/` folder first (dev only — non-Terraform-managed), and promoted to `CDP_Tenants/epr-backend/` via #cdp-support. The promotion needs to happen before the flag flips in test or higher — otherwise we're watching a lagging view.

### Alerts

Alerts are created as Grafana advanced alerts in the `epr-backend-advanced-alerts` evaluation group (dev playground first, promoted per the CDP monitoring guide).

- `wasteBalance.ledger.write` with `outcome=exhausted` rate > 0 sustained 5 min → page. Steady-state should be zero; any surfaced `LedgerContentionError` indicates a bug or pathological load.
- `wasteBalance.ledger.write.duration` p99 > 2× the pre-flip baseline, sustained 10 min → warn.
- `wasteBalance.ledger.read.duration` p99 > 2× the pre-flip baseline, sustained 10 min → warn.
- `wasteBalance.ledger.read` with `outcome=error` rate > 0.1/s sustained 5 min → page.
- `wasteBalance.cutover.migration` with `outcome=failed` rate > threshold sustained 10 min → warn. `etagRetry` is expected during PRN-heavy windows; sustained `failed` means the rebuild path itself is breaking.

The platform-default alerts (CPU, memory, HTTP-status, response time) continue to apply. This rollout adds the ledger-specific set on top of that default floor.

Pre-flip baselines: capture read-path p99 per primitive from the `epr-backend` default dashboard for the 7 days before each environment's flag-flip PR lands. Two-weeks-pre is too far; same-week-pre catches any contemporaneous regressions.

## Consequences

- The v1 waste-balance document gains a canonicality marker field. Existing v1 reads must consult it before returning balance; existing v1 writes must check it before falling through to the embedded array; the dual-read helper routes on it.
- The summary-log submission flow gains a post-commit rebuild step, gated on flag-ON and marker "v1". The user's submission is not gated on the rebuild's outcome; failures retry on the next submission.
- `appendToLedger` gains an audit-suppression flag, gated to the rebuild caller only. Ordinary write paths cannot opt in.
- The long-tail sweep is a prerequisite of v1 retirement — it is sequenced into the rollout/cutover execution chain.
- Observability instrumentation is additive to the existing waste-balance routes and repository layer; adding it should not require API changes.

## Open questions for follow-up scoping

These do not block sign-off of this recommendation; they are the first questions the implementing work needs to answer.

- Exact metric names and dimension keys against the `summaryLog.*` precedents in `src/common/helpers/metrics/`.
- Canonicality marker field shape — boolean, enum string, presence-of-marker, or version number — matched against existing repo conventions.
- Whether rebuild and marker flip run inside one MongoDB session (transactional rollback on flip failure) or use detect-and-clean on retry. Both shapes preserve correctness; the choice depends on transaction-boundary cost.
- Audit-suppression API surface — explicit parameter on `appendToLedger`, separate primitive, or middleware bypass. Implementing work picks against the existing repository-layer conventions.
- Long-tail sweep mechanism — scheduled job, admin endpoint, or one-shot script. Constraint: it must run under the same network and credentials path as the service in each environment.
- Whether the rollout is broken up as one piece of work per environment, or as a single piece of work with per-environment checkpoints.
- Whether `perf-test` is handled on its own or folded into the prod pre-flip step.

## ADR 0031 consistency follow-up

Two amendments to ADR 0031 fall out of this recommendation, and they should land together as a single update-in-place (or a single superseding ADR, whichever the team prefers):

1. **Transition mechanism.** ADR 0031's Decision section says "reads fall back to it [the v1 collection] until each accreditation has been transitioned to the ledger". As §Part B shows, bare-on-next-write does not deliver "transitioned" correctly. The amendment describes the transition mechanism as lazy per-accreditation rebuild from authoritative sources (waste records + PRN history), triggered by the next summary-log submission, with an etag-conditional canonicality flip on the v1 document.
2. **Source-kind enum.** ADR 0031 lists `manual-adjustment` as a third source kind alongside `summary-log-row` and `prn-operation`. The implementation drops it on YAGNI grounds (no admin caller exists) and this design does not reintroduce it — the rebuild draws on real per-row history and has no inflation to correct, so the escape hatch is unused. The amendment formally drops `manual-adjustment` from the source-kind enum, leaving a clean two-variant set. If admin adjustments materialise later, they are reintroduced by a successor ADR with their real caller.

Without these amendments the ADR stays inconsistent with its own operationalisation and with the implementation already in flight.

## Related

- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md)
- [ADR 0027 — Modular monolith structure](../decisions/0027-modular-monolith-structure.md)
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [CDP custom metrics guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/custom-metrics.md)
- [CDP monitoring guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/monitoring.md)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the ledger cutover enables retiring
