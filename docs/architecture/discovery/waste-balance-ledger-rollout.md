# Waste Balance Ledger — Rollout and Cutover Strategy

## Status

Proposed — sign-off required before the rollout and cutover work is scoped.

## Context

[ADR 0031](../decisions/0031-waste-balance-transaction-ledger.md) moves waste balance transactions from an embedded `transactions[]` array on each waste-balance document into a separate append-only ledger collection. Each transaction carries its own running totals (`closingAmount`, `closingAvailableAmount`) so the current balance is a single indexed read on the highest-numbered transaction per accreditation.

The ledger is gated behind `FEATURE_FLAG_WASTE_BALANCE_LEDGER` (default `false` cross-environment). Per ADR 0031, writes go to a single store; reads route on the per-accreditation canonicality marker introduced below.

The ledger changes the write shape from one atomic document update to N optimistic appends. That amplification is only exercised at the load profile perf-test produces, so a perf-test run is part of the rollout.

The rest of this doc covers how each accreditation's data moves from the embedded array to the ledger.

## Per-accreditation cutover

### Recommendation

**Lazy per-accreditation migration, triggered by the next summary-log submission for each accreditation, rebuilding the ledger from authoritative sources (waste records + PRN history).**

Each accreditation carries a canonicality marker on its waste-balance document. While the marker reads "embedded", the existing embedded write path runs as today and reads come from the document's `amount` / `availableAmount`. The first summary-log submission for that accreditation under flag-ON rebuilds the ledger as part of the submission, while the submission is still in submitting state: the ledger is populated by replaying the accreditation's waste-records history and PRN operation history, then the marker flips to "ledger" via a `version`-conditional update on the waste-balance document. The submission transitions out of submitting only once the marker flip has landed or failed. Subsequent reads and writes for that accreditation route to the ledger.

### Why rebuild from authoritative sources, not embedded-transaction replay

Full-fidelity replay of the embedded `transactions[]` array would be the textbook answer. It is rejected because embedded transaction entities carry the naked `rowId` plus waste-record version ids (`currentVersionId`, `previousVersionIds[]`), but no direct `wasteRecordId` or `summaryLogId`. An accreditation's historical embedded transactions cannot be deterministically mapped back to waste records without an ambiguous join — the same `rowId` recurs across monthly summary logs for the same supplier row. The PAE-1364 incident is the live demonstration of that ambiguity.

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) sidesteps that ambiguity by deriving balance directly from the waste records collection. That makes waste records the current source of truth for balance, and PRN history the source of truth for PRN-driven contributions. Rebuilding the ledger from those two collections is unambiguous, preserves real `wasteRecordId` / `summaryLogId` / `prnId` linkage on each replayed transaction, and preserves real `createdBy` user attribution rather than a synthetic system actor.

This dissolves three problems a seed-forward design would have carried: there is no PRN lifecycle continuity gap, no `manual-adjustment` reintroduction needed as an inflation-correction escape hatch, and no post-cutover-of-pre-cutover-row inflation risk because the ledger already carries each row's original contribution. Reinstating the ledger as the authoritative source of truth is the goal of PAE-1382 itself; rebuilding from authoritative sources delivers it directly.

### Migration shape

The rebuild runs as part of the submission flow, while the summary log is in SUBMITTING state. `summaryLogsRepository.transitionToSubmittingExclusive` permits only one summary log per `(organisationId, registrationId)` to be in SUBMITTING at a time; because each accreditation is a child of a single registration, that transitively serialises rebuild attempts per accreditation. PRN write paths are not gated by this primitive — they remain concurrent with the rebuild and are handled by the `version`-conditional flip in step 5 (§PRN concurrency during migration).

1. **Clear stale ledger entries for this accreditation.** Delete any ledger transactions for the accreditation whose marker is still "embedded". A previous rebuild attempt for this accreditation may have written entries before failing (version conflict, process death, transient error); the marker only flips to "ledger" on a successful rebuild, so any embedded-marker accreditation with non-empty ledger entries is by definition the residue of an interrupted attempt. The operation is unconditional and idempotent — if there is nothing to clear, it is a no-op.
2. **Submit via the embedded write path.** The existing summary-log write path runs unchanged.
3. **Capture the document version.** Read the waste-balance document and record its `version` field. The collection already maintains `version` as a monotonically increasing integer that every write path increments; the conditional flip at step 5 uses the captured value to detect concurrent writes.
4. **Replay history into the ledger.** Load the accreditation's PRN history, sort it by event time, and interleave it with the waste records walked in submission order — producing a single time-ordered stream of replay events. Each waste record becomes a `summary-log-row` ledger transaction with real `wasteRecordId` / `summaryLogId` / `createdBy`; each PRN operation becomes a `prn-operation` ledger transaction with real `prnId` / `operationType` / `createdBy`. The rebuild calls `appendToLedger` directly, bypassing `recordWasteBalanceUpdateAudit` so no fresh audit entries are emitted (§Audit emission suppression).
5. **Flip the marker conditionally.** Update the waste-balance document setting the canonicality marker to "ledger", filtered on `{ accreditationId, version: capturedVersion }` so the update only lands if `version` is unchanged from step 3. If the filter matches, the flip lands and reads/writes for that accreditation route to the ledger from this point. If it does not — a concurrent PRN write incremented `version` during the rebuild — the flip no-ops and the rebuild retries on the next summary-log submission. The ledger entries from this attempt remain in place; step 1 of the next submission clears them.

The summary log transitions out of SUBMITTING only after step 5 lands or fails. If migration fails at any step (transient infrastructure error, version conflict, anything else), the submission still completes — the user's embedded write was valid on its own terms — but the marker stays on "embedded" and the next summary-log submission retries the rebuild from step 1.

### PRN write routing

PRN write paths read the per-accreditation marker and route accordingly: marker "embedded" → write to the embedded array; marker "ledger" → append to ledger. PRN writes do not themselves trigger migration. An accreditation that only sees PRN traffic during the rollout window stays on "embedded" until either a summary-log submission arrives to trigger migration, or the long-tail sweep migrates it as part of embedded-path retirement preparation (§Long-tail sweep).

### PRN concurrency during migration

PRN write paths run concurrently with the rebuild. A PRN write that lands between step 3 (capture `version`) and step 5 (flip) would mutate the waste-balance document — appending to `transactions[]`, decrementing `availableAmount` — without the rebuild seeing it, leaving the just-written ledger stale. Step 5's filter on the captured `version` is what catches this: the concurrent PRN write incremented `version`, so the flip no-ops and the rebuild retries on the next submission. The PRN write itself lands on the embedded path as designed because the marker is still "embedded" at that moment.

Two waste-balance repository operations are new in this design: a delete-by-`accreditationId` for step 1, and a `version`-conditional update for step 5. Existing waste-balance writes maintain `version` as a monotonically increasing field but do not currently use it as a filter predicate; the `version`-conditional flip introduces that pattern on this collection.

Ledger entries written during a failed-flip rebuild attempt are not cleared at flip-failure time. They are cleared at the start of the next rebuild attempt (step 1 of §Migration shape), which is unconditional and idempotent. This avoids relying on a failure handler running to completion — process death between step 4 and step 5 still leaves the ledger in a recoverable state for the next submission to clean up.

### Audit emission suppression

The live summary-log write path emits one audit entry per submission via `recordWasteBalanceUpdateAudit` — a `safeAudit` event plus a `systemLogsRepository.insert`. The rebuild does not emit any audit entries: it calls `appendToLedger` directly, bypassing `recordWasteBalanceUpdateAudit`. Each summary log that contributed to the replayed history was already audited at its original submission time; the rebuild does not need to add new audit entries on top of those.

`appendToLedger` itself has no audit side effects — suppression is achieved by code structure, not by a flag on the primitive.

### Long-tail sweep

Some accreditations never submit a summary log post-flag-flip — for example, accreditations that have wound down or expect to issue PRNs against already-recorded waste without further submissions. The lazy mechanism never reaches them.

A long-tail sweep migrates those as a prerequisite for embedded-path retirement (tracked separately). The sweep iterates accreditations whose marker is still "embedded" once the broad-population rollout has saturated — saturation gauged by the embedded/ledger accreditation counts logged at service start-up.

The likely shape is queueing one migration command per affected accreditation, where each command runs the rebuild-and-flip steps without an actual summary-log submission. The exact mechanism is deferred to the implementing work.

Live traffic during the sweep is handled by the same version-conditional flip — if the lazy path or a PRN write lands first, the sweep's flip no-ops for that accreditation and the residue clears at step 1 of the next attempt. The sweep is required before the flag and the embedded path can be retired.

### Sequencing with the PAE-1364 workaround

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) made waste records the current source of truth for balance. The seven accreditations affected by PAE-1364 are already operationally recovered — operator re-uploads plus the workaround give correct user-visible balances. The rebuild's job for them is to bring the stored ledger back into agreement with that balance; for every other accreditation it rebuilds the ledger from the same source the workaround uses. PAE-1364 recovery therefore needs no separate step before cutover, and reinstating the ledger as authoritative supersedes the workaround at the same time.

The cutover order is:

1. Flag-gated read and write paths deploy everywhere with the flag OFF — including the canonicality marker on the waste-balance document, the marker-aware read path, the PRN write path that routes on the marker, and the lazy-rebuild trigger on summary-log submission.
2. Flag flips on per-environment along the promotion path. Each environment's first summary-log submission per accreditation post-flip triggers that accreditation's migration.
3. Long-tail sweep runs after the broad-population window has saturated in each environment, migrating accreditations that never submitted again.
4. Embedded-path retirement (tracked separately) follows once monitoring confirms every accreditation's marker has flipped to "ledger".

## Rollback

Flipping `FEATURE_FLAG_WASTE_BALANCE_LEDGER` back to `false` stops new migrations being triggered; already-migrated accreditations remain on the ledger. Per-accreditation ledger → embedded retreat is possible but tricky and is not built by this design — if a ledger issue surfaces we fix forward and re-migrate.

## Observability

The rebuild path logs each migration attempt — accreditation ID, outcome, and stats about the work done. Failures additionally log the error.

On service start-up, a query counts accreditations grouped by canonicality marker and logs the result. The embedded count trending to zero across deploys is the rollout-progress signal.

## Related

- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md)
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the ledger cutover enables retiring
