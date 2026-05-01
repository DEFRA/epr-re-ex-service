# Waste Balance Ledger — Rollout and Cutover Strategy

## Status

Proposed — sign-off required before the rollout and cutover work is scoped.

## Context

[ADR 0031](../decisions/0031-waste-balance-transaction-ledger.md) moves waste balance transactions from an embedded `transactions[]` array on each waste-balance document into a separate append-only ledger collection. Each transaction carries its own running totals (`closingAmount`, `closingAvailableAmount`) so the current balance is a single indexed read on the highest-numbered transaction per accreditation.

A `FEATURE_FLAG_WASTE_BALANCE_LEDGER` convict entry and cross-environment `false` default are already in flight (epr-backend#1115 and cdp-app-config#3287). Shadow dual-write is excluded by the ADR — single-write with dual-read fallback is the only mechanism on the table.

Promotion follows the standard `dev → test → ext-test → perf-test → prod` path. Perf-test is included because the ledger changes the write shape from one atomic document update to N optimistic appends, and that amplification is only exercised at the load profile perf-test produces.

The rest of this doc covers how each accreditation's data moves from v1 to v2.

## Per-accreditation cutover

### Recommendation

**Lazy per-accreditation migration, triggered by the next summary-log submission for each accreditation, rebuilding the ledger from authoritative sources (waste records + PRN history).**

Each accreditation carries a canonicality marker on its v1 waste-balance document. While the marker reads "v1", the existing v1 write path runs as today and reads come from v1 `amount` / `availableAmount`. The first summary-log submission for that accreditation under flag-ON rebuilds the ledger as part of the submission, while the submission is still in submitting state: the ledger is populated by replaying the accreditation's waste-records history and PRN operation history, then the marker flips to "v2" via an etag-conditional update on the v1 document. The submission transitions out of submitting only once the marker flip has landed or failed. Subsequent reads and writes for that accreditation route to the ledger.

### Why rebuild from authoritative sources, not v1-transaction replay

Full-fidelity replay of the v1 embedded `transactions[]` array would be the textbook answer. It is rejected because v1 transaction entities carry the naked `rowId` plus waste-record version ids (`currentVersionId`, `previousVersionIds[]`), but no direct `wasteRecordId` or `summaryLogId`. An accreditation's historical v1 transactions cannot be deterministically mapped back to waste records without an ambiguous join — the same `rowId` recurs across monthly summary logs for the same supplier row. The PAE-1364 incident is the live demonstration of that ambiguity.

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) sidesteps that ambiguity by deriving balance directly from the waste records collection. That makes waste records the current source of truth for balance, and PRN history the source of truth for PRN-driven contributions. Rebuilding the ledger from those two collections is unambiguous, preserves real `wasteRecordId` / `summaryLogId` / `prnId` linkage on each replayed transaction, and preserves real `createdBy` user attribution rather than a synthetic system actor.

This dissolves three problems a seed-forward design would have carried: there is no PRN lifecycle continuity gap, no `manual-adjustment` reintroduction needed as an inflation-correction escape hatch, and no post-cutover-of-pre-cutover-row inflation risk because the ledger already carries each row's original contribution. Reinstating the ledger as the authoritative source of truth — not a forward-only ledger seeded from v1 closing totals — is the goal of PAE-1382 itself; rebuilding from authoritative sources delivers it directly.

### Migration shape

The rebuild runs as part of the submission flow, while the submission is still in submitting state. The existing diff-preview gate that serialises submissions per accreditation therefore also serialises the rebuild — no second submission can start until this one's marker flip has landed (or failed).

1. **Submit to v1.** The existing summary-log write path runs unchanged.
2. **Capture the v1 etag.** Read the v1 waste-balance document and record its etag (or `_v` field equivalent — whichever the repository layer exposes for optimistic concurrency).
3. **Replay history into the ledger.** Walk the waste records collection in order and append a `summary-log-row` ledger transaction per row with real `wasteRecordId` / `summaryLogId` / `createdBy`. Walk the PRN history in order and append a `prn-operation` ledger transaction per operation with real `prnId` / `operationType` / `createdBy`. Each append uses the existing `appendToLedger` primitive with audit emission suppressed (§Audit emission suppression).
4. **Flip the marker conditionally.** Update the v1 document setting the canonicality marker to "v2", with the etag captured at step 2 as the conditional predicate. If the predicate matches, the flip lands and reads/writes for that accreditation route to v2 from this point. If it does not match — a concurrent PRN write incremented the etag during the rebuild — the flip no-ops, the ledger entries from this attempt are cleared, and the rebuild retries on the next summary-log submission.

The submission transitions out of submitting only after step 4 lands or fails. If migration fails at any step (transient infrastructure error, etag conflict, anything else), the submission still completes — the user's v1 write was valid on its own terms — but the marker stays on v1 and the next summary-log submission retries the rebuild.

### PRN write routing

PRN write paths read the per-accreditation marker and route accordingly: marker "v1" → write to v1 embedded array; marker "v2" → append to ledger. PRN writes do not themselves trigger migration. An accreditation that only sees PRN traffic during the rollout window stays on v1 until either a summary-log submission arrives to trigger migration, or the long-tail sweep migrates it as part of v1 retirement preparation (§Long-tail sweep).

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
2. Flag flips on per-environment along the promotion path. Each environment's first summary-log submission per accreditation post-flip triggers that accreditation's migration.
3. Long-tail sweep runs after the broad-population window has saturated in each environment, migrating accreditations that never submitted again.
4. v1 retirement (tracked separately) follows once monitoring confirms zero v1-fallback reads and zero v1 writes.

## Rollback

The expected rollback shape is flipping `FEATURE_FLAG_WASTE_BALANCE_LEDGER` back to `false`. New summary-log submissions stop triggering migrations, so no further accreditations move to v2. Already-migrated accreditations stay on v2 — their canonicality marker still reads "v2" and ledger reads/writes remain correct.

Per-accreditation rollback (v2 → v1) is achievable but not free. After migration, both summary-log and PRN activity land on the ledger; the v1 document for that accreditation hasn't seen those writes. Restoring v1 as canonical means backporting those ledger entries into v1's embedded `transactions[]` and recomputing `amount` / `availableAmount`. That backport mechanism isn't built by this design. The recommendation is to defer building it: if a v2 issue surfaces, fix the rebuild or read/write path forward and re-migrate, rather than retreating to v1.

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
- The summary-log submission flow gains a rebuild step that runs while the submission is in submitting state, gated on flag-ON and marker "v1". The user's submission completes regardless of rebuild outcome; failures retry on the next submission.
- `appendToLedger` gains an audit-suppression flag, gated to the rebuild caller only. Ordinary write paths cannot opt in.
- The long-tail sweep is a prerequisite of v1 retirement — it is sequenced into the rollout/cutover execution chain.
- Observability instrumentation is additive to the existing waste-balance routes and repository layer; adding it should not require API changes.

## Related

- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md)
- [ADR 0027 — Modular monolith structure](../decisions/0027-modular-monolith-structure.md)
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [CDP custom metrics guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/custom-metrics.md)
- [CDP monitoring guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/monitoring.md)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the ledger cutover enables retiring
