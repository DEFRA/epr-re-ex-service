# Event-Sourced Waste Balance Stream

## Status

Proposed — for discussion. Supersedes [ADR-0031](../decisions/0031-waste-balance-transaction-ledger.md) if accepted.

## Context

The waste balance has accumulated overlapping consistency problems:

1. **Design drift.** The per-row delta mechanism shipped in December 2025 diverged from the original per-event ledger design in the LLD. The tactical fix in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) derives balance from waste records, leaving the ledger as an underused artefact.
2. **Coupled writes without concurrency control.** `saveBalance` has no version predicate; concurrent PRN operations against the same PRN produce staggered double-debits when the PRN status CAS rejects the loser but the balance write has already landed ([PAE-1439](https://eaflood.atlassian.net/browse/PAE-1439)).
3. **Statutory row-removal rule (VAL009).** Anchored in SI 2024/1332, Sch 8, para 32 (7-year retention). Already enforced at the validation layer; surfaced here only because the audit trail design must support it.
4. **Summary-log submission TTL footgun.** The 20-minute SUBMITTING document TTL creates an edge case in submission semantics. Audit-corrected on 2026-05-08 — the current calculator's delta is naturally idempotent, but the underlying design fragility remains.

[ADR-0031](../decisions/0031-waste-balance-transaction-ledger.md) addresses points 1 and 2 by moving transactions out of the embedded array into a per-accreditation append-only ledger, with running totals on each entry. Implementation is in-flight (PRs #1130, #1137, #1148, #1158, #1161; rollout discovery [PR #202](https://github.com/DEFRA/epr-re-ex-service/pull/202)).

This document proposes a redesign that supersedes ADR-0031 at the conceptual level. The storage shape and concurrency mechanics carry forward; the model shifts from per-row transactions to **business events** at the granularity the domain actually operates on — one event per summary log submission, one per balance-affecting PRN transition.

The goal is a genuinely event-sourced stream: immutable facts capturing balance-affecting business operations, each carrying enough context to be self-auditing, with the balance derivable as a single indexed read.

This is a target design for discussion. Implementation timing — whether to pause ADR-0031 work, land ADR-0031 first then iterate, or pivot in-flight PRs — is deliberately not scoped here.

## Decision

Replace the per-row transaction ledger with an **event-sourced stream** per registration phase.

A **stream** is partitioned by the composite `(registrationId, accreditationId)`, with `accreditationId: null` for the registered-only phase. Each event is one document in a single ledger collection.

Each event carries:

- **Stream identity:** `registrationId`, `accreditationId` (nullable), `organisationId` (denormalised, same trick ADR-0031 uses for org-level queries), `number` (sequential per stream from 1).
- **Event identity:** `kind` (discriminator), `payload` (kind-specific).
- **Running balance:** `openingAmount`, `closingAmount`, `openingAvailableAmount`, `closingAvailableAmount`. Always present for schema uniformity; zero throughout the registered-only phase.
- **Provenance:** `createdAt`, `createdBy`.

Uniqueness of `(registrationId, accreditationId, number)` is enforced by a compound unique index — the same optimistic-append mechanism as ADR-0031, just with the partition broadened to cover registered-only phases.

### Locating the active stream

The system reads the registration's current accreditation status from the registration document. That determines the partition: `(registrationId, currentAccreditationId)` if accredited, `(registrationId, null)` if registered-only. No stream metadata is stored in the ledger itself — the events collection is the stream.

A registration may have multiple streams over its lifetime (one per accreditation period, plus one registered-only stream); at most one is active at any moment. Old partitions are sealed by virtue of nothing further being written.

### Event taxonomy (v1)

Five kinds. The discriminated payload makes additions (`manual-adjustment`, `accreditation-granted`, `accreditation-date-range-changed`, etc.) backwards-compatible — new `kind` value, new payload shape, no schema migration.

| `kind`                      | `payload`                       | Valid in registered-only?       | Effect on `closingAmount` | Effect on `closingAvailableAmount` |
| --------------------------- | ------------------------------- | ------------------------------- | ------------------------- | ---------------------------------- |
| `summary-log-submitted`     | `{ summaryLogId, creditTotal }` | ✅ recorded; balance stays at 0 | += delta (see below)      | += delta                           |
| `prn-created`               | `{ prnId, amount }`             | ❌                              | —                         | −amount (ringfence)                |
| `prn-issued`                | `{ prnId, amount }`             | ❌                              | −amount                   | — (ringfence already counted it)   |
| `prn-creation-cancelled`    | `{ prnId, amount }`             | ❌                              | —                         | +amount (release ringfence)        |
| `prn-cancelled-after-issue` | `{ prnId, amount }`             | ❌                              | +amount                   | +amount (reverse both)             |

### `summary-log-submitted` and the frozen snapshot

`creditTotal` is a frozen snapshot of the absolute credit contribution this submission produced, computed at submission time with all then-current contextual factors — the merged row state of the registration as it stands at submission time (including this submission's row-version writes), the accreditation date range in effect, and anything else that shapes the total.

The snapshot decouples balance computation from the waste-records storage shape: prior contributions are read from prior events, not reconstructed by walking the sparse-versioned waste-records collection. If a contextual factor changes later (e.g. the accreditation date range is amended), prior submissions' snapshots remain as they were — events are immutable facts at their point in time. When such factors become first-class on the stream (a future extension), they slot in alongside `summary-log-submitted` and the balance is whatever the latest event's closing says.

When a `summary-log-submitted` event is written:

1. Compute `creditTotal` from the merged row state of the registration at submission time and current contextual factors.
2. Read the previous `summary-log-submitted` event on this stream (single indexed query). If none exists, `previousCreditTotal = 0`.
3. `delta = creditTotal - previousCreditTotal`.
4. Read the latest event (any kind) for `openingAmount`, `openingAvailableAmount`.
5. `closingAmount = openingAmount + delta`; `closingAvailableAmount = openingAvailableAmount + delta`.
6. Append the event.

Per-row audit — what row R contributed to submission S — remains answerable from the waste-records collection's version chain (versions tagged with `summaryLog.id`, sparse `data` merged through the chain). It's not on the balance hot path. Reads filter the chain by stream-tagged `summaryLogId` — see "Row-version canonicity" for the write-side mechanism that makes this filter sound.

### PRN state transitions

The PRN lifecycle is genuinely two-phase, which is why `amount` and `availableAmount` exist as separate fields. The mapping between PRN state transitions and stream events:

| PRN transition                                    | Stream event                | Balance effect                                                                             |
| ------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `DRAFT → AWAITING_AUTHORISATION`                  | `prn-created`               | Ringfence: `closingAvailableAmount -= amount`                                              |
| `AWAITING_AUTHORISATION → AWAITING_ACCEPTANCE`    | `prn-issued`                | Confirm debit: `closingAmount -= amount` (availableAmount already down from the ringfence) |
| `AWAITING_AUTHORISATION → CANCELLED` or `DELETED` | `prn-creation-cancelled`    | Release ringfence: `closingAvailableAmount += amount`                                      |
| `AWAITING_CANCELLATION → CANCELLED`               | `prn-cancelled-after-issue` | Reverse both: `closingAmount += amount`, `closingAvailableAmount += amount`                |
| `AWAITING_ACCEPTANCE → ACCEPTED`                  | (see open decision)         | None — lifecycle only                                                                      |
| `AWAITING_ACCEPTANCE → AWAITING_CANCELLATION`     | (see open decision)         | None — lifecycle only                                                                      |
| `DRAFT → DISCARDED`                               | (see open decision)         | None — pre-ringfence                                                                       |

### Worked example

A registration moves through a registered-only submission, gets accredited, then accumulates submissions and PRN activity on its accredited stream.

**Stream 1 — `(regId, null)`** (registered-only). The taxonomy admits `summary-log-submitted` here for audit purposes; closing totals stay at zero by definition.

| #   | `kind`                  | `payload`                                   | closing (amount / available) |
| --- | ----------------------- | ------------------------------------------- | ---------------------------- |
| 1   | `summary-log-submitted` | `{ summaryLogId: SL-1, creditTotal: 1500 }` | 0 / 0                        |

The accreditation is granted. Stream 1 is sealed (nothing further is written to it) and **Stream 2 — `(regId, accId)`** becomes the active partition:

| #   | `kind`                      | `payload`                                   | closing (amount / available) | Notes                                                                |
| --- | --------------------------- | ------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| 1   | `summary-log-submitted`     | `{ summaryLogId: SL-2, creditTotal: 2000 }` | 2000 / 2000                  | First on this stream; `previousCreditTotal = 0`, delta = 2000        |
| 2   | `summary-log-submitted`     | `{ summaryLogId: SL-3, creditTotal: 3500 }` | 3500 / 3500                  | `previousCreditTotal = 2000`, delta = 1500                           |
| 3   | `prn-created`               | `{ prnId: PRN-1, amount: 800 }`             | 3500 / 2700                  | Ringfence on availableAmount                                         |
| 4   | `prn-creation-cancelled`    | `{ prnId: PRN-1, amount: 800 }`             | 3500 / 3500                  | Ringfence released                                                   |
| 5   | `prn-created`               | `{ prnId: PRN-2, amount: 600 }`             | 3500 / 2900                  | Ringfence on availableAmount                                         |
| 6   | `prn-issued`                | `{ prnId: PRN-2, amount: 600 }`             | 2900 / 2900                  | Debit confirmed on amount; availableAmount already counted at create |
| 7   | `prn-cancelled-after-issue` | `{ prnId: PRN-2, amount: 600 }`             | 3500 / 3500                  | Reverses both fields                                                 |

Current balance after event 7 is `3500 / 3500`, read directly from the latest event. A subsequent `summary-log-submitted` with `creditTotal = 4000` would compute its delta against event 2 — the latest `summary-log-submitted` on the stream — giving `delta = 4000 − 3500 = 500`, and close at `4000 / 4000`.

### Reading the balance

The current balance for an accredited stream is the `closingAmount` and `closingAvailableAmount` on its highest-numbered event — a single indexed read, same as ADR-0031. No cached projection; no second source of truth to drift.

Registered-only streams have a trivial balance of zero; closing fields stay zero on every event for schema uniformity.

### Reading PRN state

A PRN's current state is reconstructed from **its document plus any events not yet folded into it**. The document carries:

- The descriptive fields (creator, amount, accreditation, dates) and the projected `status`.
- An `eventNumber` watermark — the `number` of the latest stream event already projected into the document.

On read:

1. Load the PRN document.
2. Query the stream for events where `payload.prnId = doc.prnId` and `number > doc.eventNumber` (indexed point query, usually returns zero events).
3. Fold the tail in to produce the live state.

The watermark closes the gap left by a failed projection write. Reads are always correct; only the document's freshness varies. A subsequent successful write for the same PRN advances the watermark and the tail shrinks back to empty.

### Concurrency

Identical mechanism to ADR-0031. The compound unique index on `(registrationId, accreditationId, number)` enforces the slot. Writers read the latest event, compute the next number, attempt insert; retry on conflict. There is no second optimistic-lock surface for the balance itself — no separate document to update for closing totals.

### Partial failure and recovery

Two failure shapes drove this redesign as much as the consistency problems above:

- **PRN status change vs. balance update desync.** Today, updating the PRN document and writing the balance are separate writes; either can succeed while the other fails. [PAE-1439](https://eaflood.atlassian.net/browse/PAE-1439) is the live instance.
- **Summary log submission interrupted.** Row-version writes and balance writes happen across multiple steps. An interrupt between them leaves the audit trail and the balance disagreeing.

The commit boundary in the new design is the event append. The balance is, by construction, whatever the latest event's closing totals say — there is no separate balance store to drift. So every partial failure resolves to one of two outcomes: the event landed (balance and audit are both updated) or it didn't (neither is). No in-between.

**Idempotent appends.** Each balance-affecting operation has a natural idempotency key in its payload — `prnId` for PRN events, `summaryLogId` for summary-log events. Partial unique indexes, one per kind, enforce at-most-once writes:

- `(registrationId, accreditationId, kind, payload.prnId)` partial on PRN kinds
- `(registrationId, accreditationId, kind, payload.summaryLogId)` partial on `summary-log-submitted`

A retry of a stalled operation that already landed fails on the duplicate-key check rather than by appending a second event. Retries are safe.

**Write ordering.** Different operations order their writes to keep the event append as the commit:

| Operation                        | Step 1                                                                                                                                                                                                                                                                      | Step 2                                                                                                             | If step 1 fails                                                                                                                                                                       | If step 2 fails                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary log submission           | Write row versions to waste-records (each a sparse diff against the row's latest _committed_ predecessor, with uncommitted versions for the row dropped from the chain; tagged with this submission's `summaryLogId`), with a SUBMITTING session document tracking progress | Append `summary-log-submitted` event computed from the row state as of submission time                             | Balance unchanged; partially-written row versions persist uncommitted, never enter the stream, and are invisible to reads via the canonicity filter; SUBMITTING session document TTLs | Balance unchanged; the row versions written by this session persist uncommitted and invisible to reads via the canonicity filter; operator re-submits with a fresh `summaryLogId` — the new session's row writes will drop these uncommitted versions when touching the same rows |
| PRN balance-affecting transition | Append PRN event                                                                                                                                                                                                                                                            | Update PRN document projection (status, dates) and advance the `eventNumber` watermark to the new event's `number` | Balance unchanged; PRN doc unchanged; retry safe                                                                                                                                      | Balance correctly updated; PRN doc projection stale, but reads remain correct via the watermark catch-up (see "Reading PRN state")                                                                                                                                                |

The summary-log ordering means an interrupted submission leaves no balance trace at all — the historical TTL-on-`SUBMITTING` footgun is neutralised because the balance was never moved off the previous event. Row versions written during the failed attempt persist in waste-records but are invisible to reads via the canonicity filter (see "Row-version canonicity"); they are physically removed from a row's chain the next time a successful submission writes that row.

The PRN ordering inverts: the event lands first because it is the source of truth for balance, and the PRN document's status field becomes a projection. This depends on the open decision below (Option A vs Option B for lifecycle transitions). Either way, the principle is the same — if there's both an event and a doc write, the event goes first and the doc is recoverable from it.

**What stays consistent in all cases.**

- The balance is correct given the events that landed. No reconciliation is needed to compute it — the closing totals on the latest event are authoritative.
- A `summary-log-submitted` event implies a complete `creditTotal` snapshot — the snapshot is computed once at write time from the merged row state of the registration at submission time and cannot be partially computed.
- A PRN event implies the balance has already been moved for that PRN transition.

**What may be temporarily stale, and how it recovers.**

- **PRN document projection** (status field, lifecycle timestamps) — if a PRN event landed but the doc update didn't, the doc's `eventNumber` watermark is behind the stream. Reads remain correct because the read path folds in any events with `number > doc.eventNumber` (see "Reading PRN state"). A subsequent successful write for the same PRN advances the watermark and the tail shrinks back to empty; no separate reconciliation job is required.
- **`SUBMITTING` session document for an abandoned submission** — TTL collects it. Its role is session tracking for the in-flight submission process, not protection of row versions; the TTL never touches waste-records.
- **Row versions tagged with a `summaryLogId` whose event never landed** are the expected outcome of a failed submission. They persist in waste-records until the next submission that touches the same row removes them as part of its write. In the interim they are invisible to reads via the canonicity filter (see "Row-version canonicity") and contribute nothing to balance, calculator output, or row state.

**Concurrent retries.** Two concurrent attempts of the same operation race on the partial unique index. Exactly one wins; the loser's append fails with a duplicate-key error. The loser treats the operation as already completed and proceeds to (or re-attempts) the projection write if applicable.

### Row-version canonicity

Row versions land in waste-records during a SUBMITTING session, but they are not committed until that session's stream event lands. Between write and commit a version is uncommitted — visible in storage, but not part of the canonical chain.

There is no general read path that materialises row state from the version chain: balance and totals come from the event stream's `creditTotal` snapshots, and aggregation across rows happens at submission write-time when the session is producing the new `creditTotal`. The version chain is internal infrastructure — consulted at the next submission's write-time and by rare audit queries, not by routine operator-facing reads.

The canonicity invariant is maintained at write time:

1. When the session writes a row, resolve the row's latest **committed** version — the latest version in the chain whose `summaryLogId` is in the stream — and merge from start up to (and including) that version to produce the committed state.
2. Diff the workbook value against the committed state.
3. Drop any uncommitted versions for this row from the chain.
4. Append the new version (tagged with this submission's `summaryLogId`) as a sparse diff against the committed predecessor.

Every committed version is therefore self-sufficient against earlier committed versions. Anywhere the chain is consulted, the operation `keep versions whose summaryLogId is in the stream, sparse-merge them` produces the right state — no special handling for blessed orphans, because the write side has prevented them from existing.

**Worked example.**

- Row R has v1 tagged A (committed): `col_x = 5`.
- Submission B's session writes v2 tagged B: `col_x = 7`. B fails — its event never lands. v2 stays in storage, uncommitted.
- Submission C's session writes R. It resolves R's committed state (v1, `col_x = 5`), diffs against the operator's workbook value `col_x = 7`, drops v2 from R's chain, and appends v3 (tagged C) with `col_x = 7`. C's event lands.
- After C: R's chain is `[v1, v3]`. Both stream-tagged. Merge: `col_x = 7`. Matches the operator's submission and C's `creditTotal`.

For a row R that C doesn't touch but that B did:

- R's chain after B's failure: `[v1, v2]`. v2 uncommitted.
- C's session does not touch R. v2 stays in the chain.
- Anyone subsequently consulting R's chain filters by stream-membership: only v1 is in the stream. Merge: v1's state. Correct — the operator did not change R under C, so R remains at A's committed value.

In-flight sessions (events not yet appended) write uncommitted versions tagged with their own `summaryLogId`. The filter excludes them by construction.

## Open decisions

**Lifecycle-only PRN transitions on the stream?** Three transitions don't affect the balance: `AWAITING_ACCEPTANCE → ACCEPTED`, `AWAITING_ACCEPTANCE → AWAITING_CANCELLATION`, `DRAFT → DISCARDED`. They're lifecycle moves the PRN document already records.

- **Option A — Keep them off-stream.** The stream stays a pure balance ledger. The PRN document remains the source of truth for non-balance lifecycle. Smaller event taxonomy; tighter focus. Trade-off: lifecycle-only transitions are direct doc writes with no event behind them, so they fall outside the watermark catch-up and have no partial-failure recovery — a failed lifecycle write leaves the doc inconsistent until the next manual fix.
- **Option B — Put every PRN state change on the stream.** The stream becomes the single source of truth for PRN lifecycle as well as balance. Larger taxonomy (eight kinds), but PRN status is purely derived rather than maintained on the document — removes the dual-source-of-truth shape and brings every transition under the watermark catch-up for uniform partial-failure recovery.

Neither is decided yet.

## Considered alternatives

**Continue with ADR-0031's per-row transactions.** Works but stays at row granularity, requires the per-row delta reconciliation mechanism to be operator-recovery-correct, and frames the storage as transactions rather than events. The framing matters for extensibility: adding `accreditation-date-range-changed` to a transaction ledger is awkward; adding it to an event stream is just another kind.

**Materialise a separate current-balance document alongside the stream.** Rejected for the same reasons ADR-0031 rejected it — closing totals on each event mean a single indexed read suffices, and a materialised view adds a second optimistic-concurrency surface and stale-cache failure modes.

**Single stream per registration, phases not physically separated.** Rejected — re-accreditation under a new `accreditationId` belongs in its own stream because numbering, opening totals, and the audit boundary all naturally restart. Reusing the same partition across phase boundaries blurs that.

**Per-row events instead of per-submission.** Closer to ADR-0031. Rejected — operators don't think in rows; they submit summary logs. One submission produces one event keeps the stream at the granularity the domain operates on, and the frozen snapshot removes the per-row delta walk from the balance path.

**Compute `creditTotal` lazily by walking waste-records on every read.** Rejected — defeats the purpose of the snapshot. Contextual factors at submission time would need to be re-derived (or stored separately), and the immutability guarantee is lost.

**Two-phase commit / multi-document transaction across event + projection.** Rejected — adds a heavyweight mechanism to solve a problem the idempotent-append + ordered-writes pattern already handles. The system already tolerates eventually-consistent projections (the PRN status field has no realtime-correctness requirement that the balance lacks), so paying the cost of a transaction to keep them in lockstep is unwarranted.

**Per-row `committedHead` pointer for canonicity.** Each row document carries a watermark advanced on every stream commit, pointing at the row's latest canonical version; reads merge `[0..committedHead]`, accepting orphans below the watermark as canonical. Rejected in favour of the write-side diff-against-committed mechanism — `committedHead` requires O(rows-with-pending-versions) writes per stream commit (the commit step must sweep rows touched since the last commit, not just rows touched by the committing session). The write-side mechanism does the same work amortised across submissions, only when a row is actually touched, and keeps the chain tidy.

**Timestamp comparison for canonicity.** Versions carry `writtenAt`, events carry `committedAt`; the canonical chain is versions with `writtenAt ≤ latestEvent.committedAt`. Rejected — relies on non-interleaved sessions and a monotonic database clock, neither of which the design wants to depend on for correctness when a structural alternative exists.

**Stage uncommitted versions outside waste-records.** A SUBMITTING-scoped staging area holds in-flight row versions; commit moves them into the canonical `versions[]` arrays idempotently. Rejected — solves the same problem at the cost of a larger schema/storage shift and an extra round of writes at commit time. The write-side diff-against-committed mechanism achieves the same separation of uncommitted from canonical within the existing collection.

## Consequences

### Positive

- **Removes the scale limit** that drove ADR-0031. Events live in their own collection, partition-indexed.
- **Coarser granularity** than ADR-0031 — one event per submission, not one per row. Stream lengths reduce by two to three orders of magnitude for high-volume reprocessors.
- **Frozen contextual factors** via the `creditTotal` snapshot. Re-derivation cannot drift even if accreditation parameters change.
- **Direct extensibility.** New balance-affecting factors enter as new event kinds; the stream's discriminated payload absorbs them without schema migration.
- **Constant-cost balance reads** — single indexed lookup on the latest event.
- **Single concurrency surface** — `(registrationId, accreditationId, number)` unique index.
- **Decouples balance from waste-records storage shape.** Sparse version chains in waste-records become a pure row-level audit trail rather than an input to balance computation.

### Negative

- **Supersedes in-flight ADR-0031 implementation.** PRs #1130, #1137, #1148, #1158, #1161 and rollout discovery #202 are either redirected or paused. Implementation timing is out of scope for this doc.
- **Per-row provenance moves off the hot path.** "What did summary log S contribute for row R?" is still answerable via the waste-records collection's version chain, but not via a single indexed query on the stream.
- **`creditTotal` re-computation cost at submission time.** Writers compute the full snapshot from the live upload + contextual factors. Cost is bounded by submission size, not by accreditation history.
- **`closingAmount` and `closingAvailableAmount` shift together for `summary-log-submitted` events.** The split only matters when PRN events move them independently — reinforces ADR-0031's both-fields-per-event invariant.
- **Per-kind partial unique indexes** on natural idempotency keys (`prnId`, `summaryLogId`). Each new event kind that needs at-most-once semantics adds an index. The set is small and bounded by the event taxonomy.
- **PRN document status becomes a projection with a watermark catch-up read pattern.** Reads carry a cost of one indexed point-query (`payload.prnId` filtered by `number > doc.eventNumber`) on top of loading the document — usually returning zero events. The doc is no longer the sole source of truth for PRN state; consumers that bypass the read helper would see a stale view.

## Out of scope

- **Migration / cutover from current state.** Deliberately separate; this doc fixes the target design only.
- **Accreditation lifecycle events** (`accreditation-granted`, `accreditation-expired`, `accreditation-date-range-changed`). Future extensions enabled by the discriminated payload.
- **Manual adjustments** and **regulator overrides**. Future extensions.
- **Two-phase patterns beyond PRN issuance** (e.g. the summary-log SUBMITTING TTL). Addressed elsewhere.

## Related

- [ADR-0031](../decisions/0031-waste-balance-transaction-ledger.md) — the per-row transaction ledger this design supersedes
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — the underlying `amount = sum(credits) − sum(debits)` projection
- [Waste balance ledger rollout](./waste-balance-ledger-rollout.md) — rollout discovery for ADR-0031
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — parent Jira ticket
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — design drift root cause
- [PAE-1439](https://eaflood.atlassian.net/browse/PAE-1439) — concurrency issue resolved by this design
