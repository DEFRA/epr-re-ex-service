# Waste Balance Ledger — Rollout and Cutover Strategy

## Status

Built, not yet rolled out. The flag-gated read and write paths, the `canonicalSource` marker, the sweep runner with recovery and dry-run mode, and the startup census are implemented and deployed with the flag OFF in every environment. This doc is the operational reference for the per-environment flag rollout and cutover, which has not yet begun. It has been reconciled against the implementation; where the build diverged from the original plan that is noted in place.

## Context

[ADR 0036](../decisions/0036-event-sourced-waste-balance-stream.md) replaces the embedded `transactions[]` array on each waste-balance document with a per-registration-phase append-only event ledger. Each event carries its own running totals (`openingBalance` and `closingBalance`, each `{ amount, availableAmount }`) so the current balance is a single indexed read on the highest-numbered event for that registration phase. The event ledger supersedes the per-row transaction ledger of [ADR 0031](../decisions/0031-waste-balance-transaction-ledger.md); the storage shape, the slot-conflict concurrency primitive, and the `canonicalSource` cutover marker carry forward.

The ledger is gated behind `FEATURE_FLAG_WASTE_BALANCE_LEDGER` (default `false` cross-environment). Per ADR 0036, writes go to a single store; reads route on the per-accreditation `canonicalSource` marker introduced below.

The ledger changes the write shape: a summary-log submission becomes a single `summary-log-submitted` event append carrying a frozen `creditTotal` snapshot, and each balance-affecting PRN transition becomes one PRN event append, rather than the embedded array's atomic document update. Event granularity is one event per submission and one per PRN transition — two to three orders of magnitude fewer events than the per-row ledger produced — so reads stay a constant single-document lookup. A perf-test run remains part of the rollout to confirm the append path holds at load.

The rest of this doc covers how each accreditation's data moves from the embedded array onto the ledger.

## Per-accreditation cutover

### Recommendation

**Sweep-driven per-accreditation migration at flag-flip time, rebuilding the ledger from authoritative sources (waste records + PRN history), using a tri-state `canonicalSource` marker (`embedded | migrating | ledger`) per accreditation. Concurrency between the sweep and live writes is serialised by a version-conditional flip on the waste-balance document, not by excluding submissions.**

Each accreditation carries the `canonicalSource` marker on its waste-balance document. While the marker reads `embedded`, the existing embedded write path runs as today and reads come from the document's `amount` / `availableAmount`. At flag-flip per environment a sweep iterates accreditations and rebuilds the ledger for each: a conditional flip moves the marker into `migrating`, the ledger is populated by replaying the accreditation's waste-records history and PRN operation history into events, then a second conditional flip moves the marker to `ledger`. Subsequent reads and writes for that accreditation route to the ledger.

Live writes are not blocked during the rebuild. A concurrent embedded write — a summary-log balance write or a PRN transition — increments the waste-balance document `version`, which makes the conditional flip no-op so the accreditation is simply retried on a later sweep pass. The one remaining window (a summary-log submission whose waste-record write has landed but whose balance write has not) is closed by the stream's delta arithmetic rather than by exclusion (§Submission and rebuild concurrency).

### Why rebuild from authoritative sources, not embedded-transaction replay

Full-fidelity replay of the embedded `transactions[]` array would be the textbook answer. It is rejected because embedded transaction entities carry the naked `rowId` plus waste-record version ids (`currentVersionId`, `previousVersionIds[]`), but no direct `wasteRecordId` or `summaryLogId`. An accreditation's historical embedded transactions cannot be deterministically mapped back to waste records without an ambiguous join — the same `rowId` recurs across monthly summary logs for the same supplier row. The PAE-1364 incident is the live demonstration of that ambiguity.

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) sidesteps that ambiguity by deriving balance directly from the waste records collection. That makes waste records the current source of truth for balance, and PRN history the source of truth for PRN-driven contributions. Rebuilding the ledger from those two collections is unambiguous: each historical summary log becomes one `summary-log-submitted` event carrying its real `summaryLogId` and a `creditTotal` reconstructed from the merged row state at that submission, and each PRN operation becomes the PRN event for its transition (`prn-created`, `prn-issued`, and so on) carrying its real `prnId`. Both preserve the original submitter as `createdBy` rather than a synthetic system actor. Per-row provenance does not move onto the event — it stays in the waste-records version chain, where the event-sourced design already keeps it.

This dissolves three problems a seed-forward design would have carried: there is no PRN lifecycle continuity gap, no `manual-adjustment` reintroduction needed as an inflation-correction escape hatch, and no post-cutover-of-pre-cutover-row inflation risk because each replayed `summary-log-submitted` event already carries that submission's own `creditTotal` snapshot. Reinstating the waste balance ledger as the authoritative source of truth is the goal of PAE-1382 itself; rebuilding from authoritative sources delivers it directly.

The replay's internal mechanics — how each historical submission's `creditTotal` is reconstructed from the waste-records version chain, and how the original submitter is sourced for `createdBy` — are out of scope here. This doc fixes the rollout and cutover orchestration around that replay, not the replay's reconstruction logic.

### Why upfront sweep, not lazy-on-submission

A lazy alternative — rebuild triggered by the next summary-log submission per accreditation, running while the submission is in SUBMITTING state — would amortise the rebuild cost onto user-visible submission latency. It is rejected because it spreads migration out over operators' upload cadence and never reaches accreditations that have wound down. A second sweep mechanism would be needed before the embedded path could be retired, and designing and shipping it as a follow-up is more work than just sweeping upfront.

Upfront sweep makes the rollout deterministic: flag flip starts migration, the embedded count on the per-marker startup metric decays predictably, one mechanism drains both active and wound-down accreditations, and embedded-path retirement is gated only on `embedded` reaching zero. Migration is transparent to submitting users — a submission that coincides with an active sweep is not rejected; it either makes the sweep's flip no-op (the promotion retries, invisibly to the user) or self-corrects through the stream's delta arithmetic. The cost falls on the sweep as promotion retries, not on operators.

### Migration shape

The sweep only migrates accreditations that already have an embedded balance. Once the flag is on, a brand-new accreditation is created with `canonicalSource: 'ledger'` directly — it never passes through `embedded` or `migrating`. So the sweep's job is to drain the pre-existing embedded population; the embedded count is the count of accreditations that predate the flag in that environment, not a count that new activity replenishes.

A sweep job iterates accreditations whose marker is still `embedded`, running these steps per accreditation. The exact orchestration mechanism (queue-driven, single-runner, sharded by registration) is deferred to the implementing work. The sweep captures the waste-balance document `version` once at the start of an accreditation's promotion and conditions both flips on it; it computes the rebuilt events, flips to `migrating`, writes them, then flips to `ledger`.

1. **Conditional flip `embedded → migrating`.** Atomic update on the waste-balance document, filtered on `{ accreditationId, canonicalSource: 'embedded', version: V }` where V is the version captured at the start of this promotion. The update sets `canonicalSource: 'migrating'` and stamps `migratingSince`. If the filter fails — a concurrent embedded write incremented `version` since the capture — skip this accreditation and retry on the next sweep pass. The flip itself does not increment `version`.
2. **Clear any stale ledger events.** Delete ledger events for this accreditation. A previous failed sweep attempt may have written events before crashing or hitting a flip conflict; any events that exist while the marker is `migrating` are by definition the residue of an interrupted attempt and invisible to readers (which route by marker). The operation is unconditional and idempotent.
3. **Replay history into the ledger.** Append the rebuilt events: each historical summary log becomes a `summary-log-submitted` event with its real `summaryLogId`, reconstructed `creditTotal`, and original-submitter `createdBy`; each PRN operation becomes the PRN event for its transition with its real `prnId` and the operating user's `createdBy`. The rebuild appends events directly, bypassing the per-submission audit emission the live write path performs, so no fresh audit entries are emitted (§Audit emission suppression).
4. **Conditional flip `migrating → ledger`.** Atomic update filtered on `{ accreditationId, canonicalSource: 'migrating', version: V }` — the same version captured at the start. If the filter matches, the flip lands and reads/writes for that accreditation route to the ledger. If it does not — a concurrent embedded or PRN write incremented `version` during the rebuild — the flip no-ops and the promotion is abandoned for this pass. The accreditation is left `migrating`; the next runner start resets it to `embedded` (§Stuck-migrating recovery) and it is re-swept from scratch. There is no in-place re-replay, and the marker does not remain `migrating` across the gap between runs except transiently until the next start.

### Submission and rebuild concurrency

The live submission write path is two separate writes against two collections: `wasteRecordRepository.appendVersions` followed by the balance write (an embedded `transactions[]` update, or — when the marker reads `ledger` — a `summary-log-submitted` event append). These are not wrapped in a transaction, so a sweep can interleave between them. An earlier draft of this design serialised that window by extending `transitionToSubmittingExclusive` to 409 any submission while its accreditation was `migrating`. That exclusion was **not** built, and on analysis it is **not needed** — the window is closed by two mechanisms already present in the design:

1. **The embedded balance write bumps `version`; both flips are version-conditional.** A submission that takes the embedded path during the `migrating` window increments the waste-balance `version` on its balance write, so the `migrating → ledger` flip (conditioned on the version captured before the rebuild) no-ops, the promotion is abandoned, and the accreditation is re-swept later. The submission completes normally on the embedded path. The serialisation primitive is the `version` field, not a submission lock.

2. **A duplicated or missed `summary-log-submitted` append is a balance no-op via delta arithmetic.** The genuinely racy window — the submission's waste-record write has landed but its balance write has not — is the one a version filter cannot catch, because `appendVersions` writes the waste-records collection and does not touch the waste-balance `version`. Here the rebuild reads the already-written waste-record versions and so already accounts for that submission's tonnage. When the submission's balance write then runs, re-reads `canonicalSource`, finds `ledger`, and appends its `summary-log-submitted` event, the delta against the previous `summary-log-submitted` snapshot is `creditTotal − creditTotal = 0` — the append moves the balance by nothing. Symmetrically, a submission the rebuild did _not_ see self-corrects on its eventual append, because the delta picks up the difference. Either way the balance ends correct without exclusion.

The safety of mechanism 2 rests on an invariant worth stating explicitly: the waste-record write (`appendVersions`) never bumps the waste-balance `version`, while every embedded balance write does. That asymmetry is what lets the version filter catch the embedded path while the delta arithmetic covers the cross-collection window. If a future change made `appendVersions` touch the waste-balance document, this reasoning would need revisiting.

### PRN concurrency during migration

A PRN write that lands while the marker is `migrating` treats it as `embedded` — appends to `transactions[]`, increments `version`. The version-conditional `migrating → ledger` flip catches this: the concurrent PRN write incremented `version`, so the flip no-ops, the promotion is abandoned, and the accreditation is reset to `embedded` and re-swept. The replayed PRN history on the re-sweep picks up the new PRN operation.

PRN's embedded waste-balance update is a single-document atomic write — there is no waste-records / waste-balance two-step write to slip through, so the version filter alone is sufficient for the PRN path. The cross-collection window covered by the delta arithmetic above is specific to the summary-log path.

Two waste-balance repository operations are new in this design beyond what the sweep itself requires: the conditional `embedded → migrating` flip at step 1 and the conditional `migrating → ledger` flip at step 4. Existing waste-balance writes maintain `version` as a monotonically increasing field but do not currently use it as a filter predicate; the conditional flips introduce that pattern on this collection.

### Audit emission suppression

The live summary-log write path emits one audit entry per submission — a `safeAudit` event plus a `systemLogsRepository.insert`. The rebuild does not emit any audit entries: it appends events directly, bypassing that per-submission audit emission. Each summary log that contributed to the replayed history was already audited at its original submission time; the rebuild does not need to add new audit entries on top of those.

The event-append primitive itself has no audit side effects — suppression is achieved by code structure, not by a flag on the primitive.

### Stuck-migrating recovery

If the sweep process dies between step 1 (flip to `migrating`) and step 4 (flip to `ledger`), the document is left in `migrating`. It does not block anything — a `migrating` accreditation still reads and writes on the embedded path, exactly as `embedded` does (the marker-aware read only switches to the stream at `ledger`, and both PRN and summary-log balance writes treat anything other than `ledger` as embedded) — it is simply not yet promoted. Recovery: the sweep runner's startup pass resets every document still in `migrating` back to `embedded` and re-sweeps it. Because a single sweep run promotes each accreditation within that run, any document still `migrating` at the next start is by definition the residue of an interrupted run, so the reset is unconditional — there is no `migratingSince` age threshold. (`migratingSince` is stamped on the flip to `migrating` but is not currently read by recovery; it remains available for diagnostics.) Step 2 of the subsequent sweep clears any residual ledger events so the re-attempt starts clean.

The same mechanism recovers state if the flag is flipped back to OFF mid-sweep — accreditations stuck in `migrating` are returned to `embedded` on the next runner start regardless of flag state.

### Dry run

Before flipping the flag in an environment, the sweep runner is run in dry-run mode: the same rebuild code path as the live sweep, with the persist and flip steps elided. The output is:

- A per-accreditation discrepancy report comparing rebuilt balance against the current embedded balance. For PAE-1364-affected accreditations divergence is expected and tracked separately; for all others, persistent divergence across multiple dry-run passes indicates rebuild-logic bugs or data oddities to investigate before flipping the flag.
- Per-accreditation rebuild duration, which lets us estimate total sweep wall-clock per environment.
- Surfacing of accreditations whose rebuild errors out, before the flag flip rather than at it.

Nothing is persisted, so dry runs are harmless to run with live traffic ongoing. Transient discrepancies caused by writes landing during the dry run wash out on a subsequent pass; persistent discrepancies are the real signal. Dry runs are re-run as often as needed and are a precondition for flipping the flag in each environment.

### Sequencing with the PAE-1364 workaround

The PAE-1364 workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) made waste records the current source of truth for balance. The seven accreditations affected by PAE-1364 are already operationally recovered — operator re-uploads plus the workaround give correct user-visible balances. The rebuild's job for them is to bring the stored ledger back into agreement with that balance; for every other accreditation it rebuilds the ledger from the same source the workaround uses. PAE-1364 recovery therefore needs no separate step before cutover, and reinstating the ledger as authoritative supersedes the workaround at the same time.

The cutover order is:

1. Flag-gated read and write paths deploy everywhere with the flag OFF — including the tri-state `canonicalSource` marker on the waste-balance document, the marker-aware read path, the PRN write path that treats `migrating` as `embedded`, and the sweep runner with stuck-migrating recovery and dry-run mode. Without the flag set, no accreditation enters `migrating` and new accreditations continue to be created `embedded`, so behaviour is identical to today.
2. Dry runs are executed in each environment along the promotion path until the discrepancy report is clean for that environment.
3. Flag flips per environment. The sweep runs and migrates each accreditation through `embedded → migrating → ledger`.
4. Embedded-path retirement (tracked separately) follows once the per-marker startup metric confirms every accreditation has reached `ledger` in every environment.

## Rollback

Flipping `FEATURE_FLAG_WASTE_BALANCE_LEDGER` back to `false` stops new accreditations from being swept; already-migrated accreditations remain on the ledger, and accreditations stuck in `migrating` are returned to `embedded` by the stuck-marker recovery on the next runner start. Per-accreditation `ledger → embedded` retreat is possible but tricky and is not built by this design — if a ledger issue surfaces we fix forward and re-migrate.

## Observability

The sweep logs each migration attempt — accreditation ID, outcome, and stats about the work done. Failures additionally log the error.

On service start-up, a query counts accreditations grouped by `canonicalSource` marker (`embedded`, `migrating`, `ledger`) and logs the result. The `embedded` count trending to zero across deploys is the rollout-progress signal; a non-zero `migrating` count at startup marks an interrupted run, which recovery resets to `embedded` on that same start.

## Related

- [ADR 0036 — Event-sourced waste balance stream](../decisions/0036-event-sourced-waste-balance-stream.md) — the target design this rollout migrates onto
- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md) — the superseded per-row ledger
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the ledger cutover enables retiring
