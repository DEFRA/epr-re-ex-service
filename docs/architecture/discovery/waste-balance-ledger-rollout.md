# Waste Balance Ledger — Rollout and Cutover Strategy

## Status

Proposed — sign-off required before the rollout and cutover work is scoped.

## Context

[ADR 0036](../decisions/0036-event-sourced-waste-balance-stream.md) replaces the embedded `transactions[]` array on each waste-balance document with a per-registration-phase append-only event stream. Each event carries its own running totals (`openingBalance` and `closingBalance`, each `{ amount, availableAmount }`) so the current balance is a single indexed read on the highest-numbered event per stream. The stream supersedes the per-row transaction ledger of [ADR 0031](../decisions/0031-waste-balance-transaction-ledger.md); the storage shape, the slot-conflict concurrency primitive, and the `canonicalSource` cutover marker carry forward.

The stream is gated behind `FEATURE_FLAG_WASTE_BALANCE_LEDGER` (default `false` cross-environment). Per ADR 0036, writes go to a single store; reads route on the per-accreditation `canonicalSource` marker introduced below.

The stream changes the write shape: a summary-log submission becomes a single `summary-log-submitted` event append carrying a frozen `creditTotal` snapshot, and each balance-affecting PRN transition becomes one PRN event append, rather than the embedded array's atomic document update. Event granularity is one event per submission and one per PRN transition — two to three orders of magnitude fewer events than the per-row ledger — so reads stay a constant single-document lookup. A perf-test run remains part of the rollout to confirm the append path holds at load.

The rest of this doc covers how each accreditation's data moves from the embedded array onto the stream.

## Per-accreditation cutover

### Recommendation

**Sweep-driven per-accreditation migration at flag-flip time, rebuilding the stream from authoritative sources (waste records + PRN history), using a tri-state `canonicalSource` marker (`embedded | migrating | stream`) per accreditation to exclude in-flight summary-log submissions during rebuild.**

Each accreditation carries the `canonicalSource` marker on its waste-balance document. While the marker reads `embedded`, the existing embedded write path runs as today and reads come from the document's `amount` / `availableAmount`. At flag-flip per environment a sweep iterates accreditations and rebuilds the stream for each: a conditional flip moves the marker into `migrating`, the stream is populated by replaying the accreditation's waste-records history and PRN operation history into events, then a second conditional flip moves the marker to `stream`. Subsequent reads and writes for that accreditation route to the stream.

Summary-log submissions for a registration whose accreditation is currently in `migrating` are rejected with the existing 409 conflict response from `summaryLogsRepository.transitionToSubmittingExclusive`, which clients already retry. PRN writes remain concurrent with the rebuild and are handled by the version-conditional flip (§PRN concurrency during migration).

### Why rebuild from authoritative sources, not embedded-transaction replay

Full-fidelity replay of the embedded `transactions[]` array would be the textbook answer. It is rejected because embedded transaction entities carry the naked `rowId` plus waste-record version ids (`currentVersionId`, `previousVersionIds[]`), but no direct `wasteRecordId` or `summaryLogId`. An accreditation's historical embedded transactions cannot be deterministically mapped back to waste records without an ambiguous join — the same `rowId` recurs across monthly summary logs for the same supplier row. The PAE-1364 incident is the live demonstration of that ambiguity.

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) sidesteps that ambiguity by deriving balance directly from the waste records collection. That makes waste records the current source of truth for balance, and PRN history the source of truth for PRN-driven contributions. Rebuilding the stream from those two collections is unambiguous: each historical summary log becomes one `summary-log-submitted` event carrying its real `summaryLogId` and a `creditTotal` reconstructed from the merged row state at that submission, and each PRN operation becomes the PRN event for its transition (`prn-created`, `prn-issued`, and so on) carrying its real `prnId`. Both preserve the original submitter as `createdBy` rather than a synthetic system actor. Per-row provenance does not move onto the event — it stays in the waste-records version chain, where the event-sourced design already keeps it.

This dissolves three problems a seed-forward design would have carried: there is no PRN lifecycle continuity gap, no `manual-adjustment` reintroduction needed as an inflation-correction escape hatch, and no post-cutover-of-pre-cutover-row inflation risk because each replayed `summary-log-submitted` event already carries that submission's own `creditTotal` snapshot. Reinstating the waste balance as an authoritative event stream is the goal of PAE-1382 itself; rebuilding from authoritative sources delivers it directly.

The replay's internal mechanics — how each historical submission's `creditTotal` is reconstructed from the waste-records version chain, and how the original submitter is sourced for `createdBy` — are out of scope here. This doc fixes the rollout and cutover orchestration around that replay, not the replay's reconstruction logic.

### Why upfront sweep, not lazy-on-submission

A lazy alternative — rebuild triggered by the next summary-log submission per accreditation, running while the submission is in SUBMITTING state — would amortise the rebuild cost onto user-visible submission latency and would inherit submission-vs-rebuild serialisation directly from `transitionToSubmittingExclusive`. It is rejected because it spreads migration out over operators' upload cadence and never reaches accreditations that have wound down. A second sweep mechanism would be needed before the embedded path could be retired, and that second sweep would face exactly the cross-collection race the tri-state marker solves below; designing and shipping it as a follow-up is more work than just sweeping upfront.

Upfront sweep makes the rollout deterministic: flag flip starts migration, the embedded count on the per-marker startup metric decays predictably, one mechanism handles fresh and dormant accreditations, and embedded-path retirement is gated only on `embedded` reaching zero. The cost is 409 retries for users whose summary-log submission arrives during their registration's sweep window. The window per accreditation should be short, and operators don't upload very frequently anyway, so few submissions are likely to coincide with an active sweep.

### Migration shape

A sweep job iterates accreditations whose marker is still `embedded`, running these steps per accreditation. The exact orchestration mechanism (queue-driven, single-runner, sharded by registration) is deferred to the implementing work.

1. **Conditional flip `embedded → migrating`.** Atomic update on the waste-balance document, filtered on `{ accreditationId, canonicalSource: 'embedded', version: V }` where V is the version read in the same operation. The update sets `canonicalSource: 'migrating'` and stamps `migratingSince: now()`. If the filter fails — a concurrent embedded write incremented `version` between the read and the update — skip this accreditation and retry on the next sweep pass.
2. **Clear any stale stream events.** Delete stream events for this accreditation. A previous failed sweep attempt may have written events before crashing or hitting a flip conflict; any events that exist while the marker is `migrating` are by definition the residue of an interrupted attempt and invisible to readers (which route by marker). The operation is unconditional and idempotent.
3. **Replay history into the stream.** Capture the document version V' at the start of this step. Load the accreditation's PRN history and waste records, sort the combined event stream by event time, and append each as a stream event: each historical summary log becomes a `summary-log-submitted` event with its real `summaryLogId`, reconstructed `creditTotal`, and original-submitter `createdBy`; each PRN operation becomes the PRN event for its transition with its real `prnId` and the operating user's `createdBy`. The rebuild appends events directly, bypassing the per-submission audit emission the live write path performs, so no fresh audit entries are emitted (§Audit emission suppression).
4. **Conditional flip `migrating → stream`.** Atomic update filtered on `{ accreditationId, canonicalSource: 'migrating', version: V' }`. If the filter matches, the flip lands and reads/writes for that accreditation route to the stream. If it does not — a concurrent PRN write incremented `version` during step 3 — return to step 2 and re-replay; the marker stays at `migrating` across the retry so submission exclusion holds throughout.

### Submission exclusion

`summaryLogsRepository.transitionToSubmittingExclusive` is extended to reject when any waste-balance document for an accreditation under the same `(organisationId, registrationId)` has `canonicalSource: 'migrating'`. The submit handler at `src/routes/v1/organisations/registrations/summary-logs/submit/post.js` already maps a non-success result to a 409 Conflict with a retry-friendly message — no caller-side changes.

The exclusion is needed because the live submission write path is two separate writes against two collections: `wasteRecordRepository.appendVersions` followed by the `summary-log-submitted` event append. A version-conditional flip alone cannot serialise the rebuild against this path: a sweep that captures the waste-balance version between those two writes, walks the (already-written) waste records, and flips before the event append would observe a stale version V at flip time and succeed, leaving the submission's eventual event append to land under the wrong marker. Holding `canonicalSource: 'migrating'` across the rebuild closes that window by routing the submission to a 409 retry before its first collection write.

The exclusion holds only for the per-accreditation `migrating` window, which should be short. A registration with multiple accreditations may see sporadic 409s across the sweep of all its accreditations; the sweep should order accreditations under a single registration consecutively so the user-visible exclusion window is contiguous rather than scattered.

### PRN concurrency during migration

PRN writes are not gated by the submission exclusion. A PRN write that lands while the marker is `migrating` treats it as `embedded` — appends to `transactions[]`, increments `version`. Step 4's filter on the version captured at step 3 catches this: the concurrent PRN write incremented `version`, so the flip no-ops and the rebuild restarts at step 2. The replayed PRN history at the next step 3 picks up the new PRN operation.

PRN's embedded waste-balance update is a single-document atomic write — there is no waste-records / waste-balance two-step write to slip through, so the version filter is sufficient. The cross-collection race the submission exclusion exists to handle is specific to the summary-log path.

Two waste-balance repository operations are new in this design beyond what the sweep itself requires: the conditional `embedded → migrating` flip at step 1 and the conditional `migrating → stream` flip at step 4. Existing waste-balance writes maintain `version` as a monotonically increasing field but do not currently use it as a filter predicate; the conditional flips introduce that pattern on this collection.

### Audit emission suppression

The live summary-log write path emits one audit entry per submission — a `safeAudit` event plus a `systemLogsRepository.insert`. The rebuild does not emit any audit entries: it appends events directly, bypassing that per-submission audit emission. Each summary log that contributed to the replayed history was already audited at its original submission time; the rebuild does not need to add new audit entries on top of those.

The event-append primitive itself has no audit side effects — suppression is achieved by code structure, not by a flag on the primitive.

### Stuck-migrating recovery

If the sweep process dies between step 1 (flip to `migrating`) and step 4 (flip to `stream`), the document remains in `migrating` and blocks submissions for that registration indefinitely. Recovery: the sweep runner's startup pass finds documents whose `migratingSince` is older than a threshold (10 minutes — comfortably above expected per-accreditation sweep duration), resets `canonicalSource` to `embedded`, clears `migratingSince`, and re-enqueues the accreditation. Step 2 of the subsequent sweep clears any residual stream events so the re-attempt starts clean.

The same mechanism recovers state if the flag is flipped back to OFF mid-sweep — accreditations stuck in `migrating` are returned to `embedded` on the next runner start regardless of flag state.

### Dry run

Before flipping the flag in an environment, the sweep runner is run in dry-run mode: the same rebuild code path as the live sweep, with the persist and flip steps elided. The output is:

- A per-accreditation discrepancy report comparing rebuilt balance against the current embedded balance. For PAE-1364-affected accreditations divergence is expected and tracked separately; for all others, persistent divergence across multiple dry-run passes indicates rebuild-logic bugs or data oddities to investigate before flipping the flag.
- Per-accreditation rebuild duration, which calibrates the stuck-marker threshold and lets us estimate total sweep wall-clock per environment.
- Surfacing of accreditations whose rebuild errors out, before the flag flip rather than at it.

Nothing is persisted, so dry runs are harmless to run with live traffic ongoing. Transient discrepancies caused by writes landing during the dry run wash out on a subsequent pass; persistent discrepancies are the real signal. Dry runs are re-run as often as needed and are a precondition for flipping the flag in each environment.

### Sequencing with the PAE-1364 workaround

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) made waste records the current source of truth for balance. The seven accreditations affected by PAE-1364 are already operationally recovered — operator re-uploads plus the workaround give correct user-visible balances. The rebuild's job for them is to bring the stored stream back into agreement with that balance; for every other accreditation it rebuilds the stream from the same source the workaround uses. PAE-1364 recovery therefore needs no separate step before cutover, and reinstating the stream as authoritative supersedes the workaround at the same time.

The cutover order is:

1. Flag-gated read and write paths deploy everywhere with the flag OFF — including the tri-state `canonicalSource` marker on the waste-balance document, the marker-aware read path, the PRN write path that treats `migrating` as `embedded`, the extended `transitionToSubmittingExclusive`, and the sweep runner with stuck-migrating recovery and dry-run mode. Without the flag set, no accreditation enters `migrating`, so the extension is a no-op in practice and behaviour is identical to today.
2. Dry runs are executed in each environment along the promotion path until the discrepancy report is clean for that environment.
3. Flag flips per environment. The sweep runs and migrates each accreditation through `embedded → migrating → stream`.
4. Embedded-path retirement (tracked separately) follows once the per-marker startup metric confirms every accreditation has reached `stream` in every environment.

## Rollback

Flipping `FEATURE_FLAG_WASTE_BALANCE_LEDGER` back to `false` stops new accreditations from being swept; already-migrated accreditations remain on the stream, and accreditations stuck in `migrating` are returned to `embedded` by the stuck-marker recovery on the next runner start. Per-accreditation `stream → embedded` retreat is possible but tricky and is not built by this design — if a stream issue surfaces we fix forward and re-migrate.

## Observability

The sweep logs each migration attempt — accreditation ID, outcome, and stats about the work done. Failures additionally log the error.

On service start-up, a query counts accreditations grouped by `canonicalSource` marker (`embedded`, `migrating`, `stream`) and logs the result. The `embedded` count trending to zero across deploys is the rollout-progress signal; a non-zero `migrating` count at startup is the trigger for stuck-marker recovery.

## Related

- [ADR 0036 — Event-sourced waste balance stream](../decisions/0036-event-sourced-waste-balance-stream.md) — the target design this rollout migrates onto
- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md) — the superseded per-row ledger
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the stream cutover enables retiring
