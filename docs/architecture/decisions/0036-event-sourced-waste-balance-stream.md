# 36. Event-sourced waste balance stream

Date: 2026-06-02

## Status

Accepted. Supersedes [ADR-0031](./0031-waste-balance-transaction-ledger.md).

## Context

The waste balance has accumulated overlapping consistency problems:

1. **Coupled writes without concurrency control.** `saveBalance` has no version predicate; concurrent PRN operations against the same PRN produce staggered double-debits when the PRN status CAS rejects the loser but the balance write has already landed ([PAE-1439](https://eaflood.atlassian.net/browse/PAE-1439)).
2. **Statutory row-removal rule (VAL009).** Anchored in SI 2024/1332, Sch 8, para 32 (7-year retention). Already enforced at the validation layer; surfaced here only because the audit trail design must support it.
3. **Summary-log submission TTL footgun.** The 20-minute SUBMITTING document TTL creates an edge case in submission semantics. Audit-corrected on 2026-05-08 — the current calculator's delta is naturally idempotent, but the underlying design fragility remains.

[ADR-0031](./0031-waste-balance-transaction-ledger.md) addresses point 1 by moving transactions out of the embedded array into a per-accreditation append-only ledger, with running totals on each entry.

This ADR supersedes ADR-0031 at the conceptual level. The storage shape and concurrency mechanics carry forward; the model shifts from per-row transactions to **business events** at the granularity the domain actually operates on — one event per summary log submission, one per balance-affecting PRN transition.

The goal is a genuinely event-sourced stream: immutable facts capturing balance-affecting business operations, each carrying enough context to be self-auditing, with the balance derivable as a single indexed read.

Migration and cutover timing are out of scope for this ADR — they are owned by the [rollout and cutover design](../discovery/waste-balance-ledger-rollout.md), which gates each accreditation onto the stream via a per-accreditation `canonicalSource` marker (`embedded → migrating → stream`).

## Decision

Replace the per-row transaction ledger with an **event-sourced stream** per registration phase.

A **stream** is partitioned by the composite `(registrationId, accreditationId)`, with `accreditationId: null` for the registered-only phase. Each event is one document in a single ledger collection.

Each event carries:

- **Stream identity:** `registrationId`, `accreditationId` (nullable), `organisationId` (denormalised, same trick ADR-0031 uses for org-level queries), `number` (sequential per stream from 1).
- **Event identity:** `kind` (discriminator), `payload` (kind-specific).
- **Running balance:** `openingBalance` and `closingBalance`, each `{ amount, availableAmount }`. Mirrors the ledger snapshot shape from ADR-0031. Always present for schema uniformity.
- **Provenance:** `createdAt`, `createdBy: { id, name }`.

**Actor vs cause.** `createdBy` is the **actor** — the user who triggered the event — and is uniform across every kind. For a `summary-log-submitted` event it is stamped from the SubmitUser at submit time, so every row in that submission shares one `createdBy` (per-submission actor, not per-row author); for a PRN event it is the user who performed the operation. The **cause** — the upstream business operation and the entity it affected — is the event itself: its `kind` and `payload`. The actor is never folded into the payload. An actor query ("every event user X caused") resolves uniformly against `createdBy` across all kinds; a cause query resolves against `kind`/`payload` without digging the actor out of differing payload shapes.

Uniqueness of `(registrationId, accreditationId, number)` is enforced by a compound unique index — the same optimistic-append mechanism as ADR-0031, just with the partition broadened to cover registered-only phases.

### Locating the active stream

The system reads the registration's current accreditation status from the registration document. That determines the partition: `(registrationId, currentAccreditationId)` if accredited, `(registrationId, null)` if registered-only. No stream metadata is stored in the ledger itself — the events collection is the stream.

A registration may have multiple streams over its lifetime (one per accreditation period, plus one registered-only stream); at most one is active at any moment. Inactive streams are not modified or marked — nothing happens to a stream when it stops being active; it simply receives no further writes.

### Event taxonomy (v1)

Seven kinds. The discriminated payload makes additions (`manual-adjustment`, `accreditation-granted`, `accreditation-date-range-changed`, etc.) backwards-compatible — new `kind` value, new payload shape, no schema migration.

| `kind`                      | `payload`                       | Valid in registered-only? | Effect on `closingBalance.amount` | Effect on `closingBalance.availableAmount` |
| --------------------------- | ------------------------------- | ------------------------- | --------------------------------- | ------------------------------------------ |
| `summary-log-submitted`     | `{ summaryLogId, creditTotal }` | ✅                        | += delta (see below)              | += delta                                   |
| `prn-created`               | `{ prnId, amount }`             | ❌                        | —                                 | −amount (ringfence)                        |
| `prn-issued`                | `{ prnId, amount }`             | ❌                        | −amount                           | — (ringfence already counted it)           |
| `prn-creation-cancelled`    | `{ prnId, amount }`             | ❌                        | —                                 | +amount (release ringfence)                |
| `prn-cancelled-after-issue` | `{ prnId, amount }`             | ❌                        | +amount                           | +amount (reverse both)                     |
| `prn-accepted`              | `{ prnId, amount }`             | ❌                        | — (lifecycle only)                | — (lifecycle only)                         |
| `prn-rejected`              | `{ prnId, amount }`             | ❌                        | — (lifecycle only)                | — (lifecycle only)                         |

The two PRN lifecycle kinds (`prn-accepted`, `prn-rejected`) close the balance at exactly their opening — they move no money. They are on the stream so that every balance-affecting _and_ lifecycle PRN transition is recorded as an event (see "Resolved: lifecycle-only PRN transitions on the stream"). The authoritative mapping from PRN state transitions to event kinds is owned by the write-side decider in `epr-backend` and documented in the [waste balance LLD](../defined/pepr-lld.md#waste-balance); this ADR fixes the model, not the exhaustive transition table, so the mapping can evolve with the PRN state machine without an ADR amendment.

### `summary-log-submitted` and the frozen snapshot

`creditTotal` is a frozen snapshot of the absolute credit contribution this submission produced, computed at submission time with all then-current contextual factors — the merged row state of the registration as it stands at submission time (including this submission's row-version writes), the accreditation date range in effect, and anything else that shapes the total.

The snapshot decouples balance computation from the waste-records storage shape: prior contributions are read from prior events, not reconstructed by walking the sparse-versioned waste-records collection. If a contextual factor changes later (e.g. the accreditation date range is amended), prior submissions' snapshots remain as they were — events are immutable facts at their point in time. When such factors become first-class on the stream (a future extension), they slot in alongside `summary-log-submitted` and the balance is whatever the latest event's closing says.

When a `summary-log-submitted` event is written:

1. Compute `creditTotal` from the merged row state of the registration at submission time and current contextual factors.
2. Read the previous `summary-log-submitted` event on this stream (single indexed query). If none exists, `previousCreditTotal = 0`.
3. `delta = creditTotal - previousCreditTotal`.
4. Read the latest event (any kind) for its `closingBalance`; that becomes this event's `openingBalance`.
5. `closingBalance.amount = openingBalance.amount + delta`; `closingBalance.availableAmount = openingBalance.availableAmount + delta`.
6. Append the event.

Per-row audit — what row R contributed to submission S — remains answerable from the waste-records collection's version chain (versions tagged with `summaryLog.id`, sparse diffs merged in array order through the chain). It's not on the balance hot path. The canonicity walk recovers the state as of any committed submission by walking versions in array order from index 0 up to and including the target submission's version — see "Row-version canonicity" for the algorithm and the trailing-orphan handling.

### PRN state transitions

The PRN lifecycle is genuinely two-phase, which is why `amount` and `availableAmount` exist as separate fields. The mapping between PRN state transitions and stream events:

| PRN transition                                    | Stream event                | Balance effect                                                                                       |
| ------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DRAFT → AWAITING_AUTHORISATION`                  | `prn-created`               | Ringfence: `closingBalance.availableAmount -= amount`                                                |
| `AWAITING_AUTHORISATION → AWAITING_ACCEPTANCE`    | `prn-issued`                | Confirm debit: `closingBalance.amount -= amount` (`availableAmount` already down from the ringfence) |
| `AWAITING_AUTHORISATION → CANCELLED` or `DELETED` | `prn-creation-cancelled`    | Release ringfence: `closingBalance.availableAmount += amount`                                        |
| `AWAITING_CANCELLATION → CANCELLED`               | `prn-cancelled-after-issue` | Reverse both: `closingBalance.amount += amount`, `closingBalance.availableAmount += amount`          |
| `AWAITING_ACCEPTANCE → ACCEPTED`                  | `prn-accepted`              | None — lifecycle only (`closingBalance` equals `openingBalance`)                                     |
| Rejection of an issued PRN                        | `prn-rejected`              | None — lifecycle only (`closingBalance` equals `openingBalance`)                                     |

This table is illustrative of the balance effects, not the exhaustive PRN state machine. The authoritative transition-to-event mapping lives in the write-side decider in `epr-backend` and the [waste balance LLD](../defined/pepr-lld.md#waste-balance), so it can track the PRN state machine without an ADR amendment.

### Worked example

A registration moves through a registered-only submission, gets accredited, then accumulates submissions and PRN activity on its accredited stream.

**Stream 1 — `(regId, null)`** (registered-only). Whether registered-only streams carry a running balance is a product decision; the schema and delta arithmetic don't require it either way. This example assumes the product choice is not to maintain a balance pre-accreditation, so closing totals stay at zero.

| #   | `kind`                  | `payload`                                   | closingBalance (amount / availableAmount) |
| --- | ----------------------- | ------------------------------------------- | ----------------------------------------- |
| 1   | `summary-log-submitted` | `{ summaryLogId: SL-1, creditTotal: 1500 }` | 0 / 0                                     |

The accreditation is granted. The partition selector now resolves to `(regId, accId)`, so subsequent writes land on **Stream 2 — `(regId, accId)`**. Stream 1 stays exactly as it is; no document is touched to mark the change.

| #   | `kind`                      | `payload`                                   | closingBalance (amount / availableAmount) | Notes                                                                |
| --- | --------------------------- | ------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| 1   | `summary-log-submitted`     | `{ summaryLogId: SL-2, creditTotal: 2000 }` | 2000 / 2000                               | First on this stream; `previousCreditTotal = 0`, delta = 2000        |
| 2   | `prn-created`               | `{ prnId: PRN-1, amount: 800 }`             | 2000 / 1200                               | Ringfence on availableAmount                                         |
| 3   | `summary-log-submitted`     | `{ summaryLogId: SL-3, creditTotal: 3500 }` | 3500 / 2700                               | `previousCreditTotal = 2000`, delta = 1500 applied to both fields    |
| 4   | `prn-creation-cancelled`    | `{ prnId: PRN-1, amount: 800 }`             | 3500 / 3500                               | Ringfence released                                                   |
| 5   | `prn-created`               | `{ prnId: PRN-2, amount: 600 }`             | 3500 / 2900                               | Ringfence on availableAmount                                         |
| 6   | `prn-issued`                | `{ prnId: PRN-2, amount: 600 }`             | 2900 / 2900                               | Debit confirmed on amount; availableAmount already counted at create |
| 7   | `prn-cancelled-after-issue` | `{ prnId: PRN-2, amount: 600 }`             | 3500 / 3500                               | Reverses both fields                                                 |

Current balance after event 7 is `3500 / 3500`, read directly from the latest event. A subsequent `summary-log-submitted` with `creditTotal = 4000` would compute its delta against event 3 — the latest `summary-log-submitted` on the stream — giving `delta = 4000 − 3500 = 500`, and close at `4000 / 4000`.

### Reading the balance

The current balance for an accredited stream is the `closingBalance` on its highest-numbered event — a single indexed read, same as ADR-0031. No cached projection; no second source of truth to drift.

Whether registered-only streams maintain a running balance is a product decision; the schema supports either choice without change. If the product choice is not to maintain a pre-accreditation balance, `closingBalance` stays at `{ amount: 0, availableAmount: 0 }` on every event for schema uniformity.

### Decimal arithmetic

Every amount on an event (`payload.creditTotal`, `payload.amount`, and both `openingBalance` and `closingBalance` snapshots) is stored as MongoDB `Decimal128`, and arithmetic over those amounts goes through `decimal.js` via the helpers in `src/common/helpers/decimal-utils.js` (precision 34 to match the Decimal128 spec, `ROUND_HALF_UP`). Storing as BSON Double would silently introduce IEEE 754 drift over the cumulative closing-total chain — at the scale this design operates at, that drift becomes material against operator-entered tonnages, and the `delta = creditTotal − previousCreditTotal` arithmetic in particular relies on exact arithmetic to recognise a re-submitted snapshot as a zero delta.

The application boundary stays in JS-number shape: schemas validate amounts as `Joi.number()`, and the storage adapter converts to `Decimal128` on write and back via `toNumber` on read. Aggregation pipelines that touch amount fields must keep their literal numeric operands in Decimal128 (`{ $toDecimal: -1 }` rather than a bare integer) so `$sum`, `$multiply`, and `$switch` outputs preserve the type instead of widening back to Double.

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

The application layer enforces a single-active-session-per-registration lease (the SUBMITTING document), so concurrent submissions for the same `(registrationId, accreditationId)` are precluded in normal operation. The data layer carries two defence-in-depth mechanisms that surface a conflict to the caller if the lease ever fails:

**Optimistic concurrency on the waste-record document.** The waste-record document gains a top-level `version` integer field — same convention as the summary-log repository (`repositories/summary-logs/mongodb.js`): insert with `version: 1`, update filter on `{ _id, version: capturedVersion }`, atomically `$inc` the version on success. If another writer has bumped the version in between, the filter doesn't match and the write fails. The caller decides the response — recompute and retry, surface an error to the operator, or any other policy — the data layer's contract is only that the conflict is detected, not silently absorbed.

**Compound unique index on event slots.** `(registrationId, accreditationId, number)` enforces sequential numbering, identical to ADR-0031. Two sessions racing for the same slot fail with a duplicate-key error. As above, the data layer guarantees detection but not response. A session that observed the slot from a now-stale view of the stream tip cannot silently retry at the next number, because its `creditTotal` was computed against state that the winning session has since advanced — any retry needs to be a fresh computation against current state, which is a decision for the caller, not the data layer.

The load-bearing rule is detection over absorption: every conflict surfaces as a write failure that the caller must handle. The stream's `creditTotal` arithmetic is correct only when every successful append corresponds to a `creditTotal` computed against the state immediately following the previous event, so any uncertainty about which event was previous must be exposed, not hidden.

There is no second optimistic-lock surface for the balance itself — no separate document to update for closing totals.

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

| Operation                        | Step 1                                                                                                                                                                                                                            | Step 2                                                                                                             | If step 1 fails                                                                                                                                                                     | If step 2 fails                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary log submission           | Write row versions to waste-records (each a sparse diff against the row's latest _written_ predecessor — orphan or committed; tagged with this submission's `summaryLogId`), with a SUBMITTING session document tracking progress | Append `summary-log-submitted` event computed from the row state as of submission time                             | Balance unchanged; partially-written row versions persist uncommitted, never enter the stream, and are invisible to reads via the canonicity walk; SUBMITTING session document TTLs | Balance unchanged; the row versions written by this session persist as trailing orphans in the chain and are invisible to the canonicity walk; operator re-submits with a fresh `summaryLogId` — the chain is never rewritten, so orphan versions accumulate harmlessly |
| PRN balance-affecting transition | Append PRN event                                                                                                                                                                                                                  | Update PRN document projection (status, dates) and advance the `eventNumber` watermark to the new event's `number` | Balance unchanged; PRN doc unchanged; retry safe                                                                                                                                    | Balance correctly updated; PRN doc projection stale, but reads remain correct via the watermark catch-up (see "Reading PRN state")                                                                                                                                      |

The summary-log ordering means an interrupted submission leaves no balance trace at all — the historical TTL-on-`SUBMITTING` footgun is neutralised because the balance was never moved off the previous event. Row versions written during the failed attempt persist in waste-records as trailing orphans that the canonicity walk excludes (see "Row-version canonicity"); they stay in the chain indefinitely.

The PRN ordering inverts: the event lands first because it is the source of truth for balance, and the PRN document's status field becomes a projection. Because lifecycle-only transitions are also recorded as events (see "Resolved: lifecycle-only PRN transitions on the stream"), this holds for every PRN transition — if there's both an event and a doc write, the event goes first and the doc is recoverable from it.

**What stays consistent in all cases.**

- The balance is correct given the events that landed. No reconciliation is needed to compute it — the closing totals on the latest event are authoritative.
- A `summary-log-submitted` event implies a complete `creditTotal` snapshot — the snapshot is computed once at write time from the merged row state of the registration at submission time and cannot be partially computed.
- A PRN event implies the balance has already been moved for that PRN transition.

**What may be temporarily stale, and how it recovers.**

- **PRN document projection** (status field, lifecycle timestamps) — if a PRN event landed but the doc update didn't, the doc's `eventNumber` watermark is behind the stream. Reads remain correct because the read path folds in any events with `number > doc.eventNumber` (see "Reading PRN state"). A subsequent successful write for the same PRN advances the watermark and the tail shrinks back to empty; no separate reconciliation job is required.
- **`SUBMITTING` session document for an abandoned submission** — TTL collects it. Its role is session tracking for the in-flight submission process, not protection of row versions; the TTL never touches waste-records.
- **Row versions tagged with a `summaryLogId` whose event never landed** are the expected outcome of a failed submission. They persist in waste-records indefinitely as orphans — the chain is never rewritten. The canonicity walk (see "Row-version canonicity") absorbs them only when a subsequent committed version's sparse diff was computed against them; trailing orphans (no subsequent committed version) are excluded and contribute nothing to balance, calculator output, or committed row state.

**Concurrent retries.** Two concurrent attempts of the same operation race on the partial unique index. Exactly one wins; the loser's append fails with a duplicate-key error. The loser treats the operation as already completed and proceeds to (or re-attempts) the projection write if applicable.

### Row-version canonicity

**Row monotonicity premise.** Submission validation forbids row deletion — a submission whose workbook drops a previously-submitted row fails validation at the application boundary. Every committed submission's workbook is therefore a superset of every prior committed submission's. This makes the chain a complete witness for per-row contribution to every submission: a row exists in submission S iff its first-committed version's `summaryLog` event is at or before S on the stream, and its state at S is recoverable by the canonicity walk (see below) up to S's version. No per-event manifest of workbook contents is needed because absence-from-workbook is structurally impossible for a committed submission.

Row versions land in waste-records during a SUBMITTING session, but they are not committed until that session's stream event lands. Between write and commit a version is uncommitted — visible in storage, but absent from the stream.

There is no general read path that materialises row state from the version chain: balance and totals come from the event stream's `creditTotal` snapshots, and aggregation across rows happens at submission write-time when the session is producing the new `creditTotal`. The version chain is internal infrastructure — consulted at the next submission's write-time and by rare audit queries, not by routine operator-facing reads.

**Write side — sparse diff against the latest written predecessor.** Each version stores a sparse diff against the row's latest _written_ predecessor (orphan or committed). The write algorithm is:

1. Read the row document, including its current materialised `data` field and its `version` integer.
2. Compute the workbook value's sparse diff against `data`.
3. Append the new version (tagged with this submission's `summaryLogId`) with that sparse diff, and atomically update `data` to the full new state. The write asserts via optimistic concurrency that the row document's `version` integer is unchanged since step 1's read, and atomically increments it; if the version has moved, the write fails and the caller is responsible for the response (see "Concurrency").

This is exactly what the current `transformFromSummaryLog` / `appendVersions` path already does — the event-sourced design preserves it.

**Read side — the canonicity walk.** To recover the row state as of committed submission Z, find Z's version in the chain (the version tagged with Z's `summaryLogId`) and walk versions in array order from index 0 up to and including that index, applying each sparse diff cumulatively. For the latest committed state, Z is the _latest_ version on the chain whose `summaryLogId` is in the stream.

Orphans that fall _before_ the last committed version are absorbed by the walk — the subsequent committed version's sparse diff was computed against them, so they sit on the canonical path. Trailing orphans (versions after the latest committed) are excluded — they were never absorbed by a successor and represent abandoned work.

The chain is strictly append-only. Uncommitted versions left behind by failed prior sessions stay in storage; they are never pruned at write time. The materialised `data` field reflects the latest _written_ state, which may include trailing orphan residue — it is correct for the next write's diff (which builds on it), but it is NOT the canonical committed state for any row the current submission does not touch. `creditTotal` computation must therefore use the canonicity walk for any row whose committed state matters, not `data` read in bulk.

This makes the read side more involved than a single materialised lookup, but the chain is consulted only at write-time and by rare audit queries, so the cost lands on a cold path. The trade keeps the write side fast and the integrity contract tight.

**Worked example.**

- Row R has v1 tagged A (committed): full state `{col_x: 5, col_y: 3}`. `data = {col_x: 5, col_y: 3}`.
- Submission B writes v2 tagged B: workbook says `{col_x: 7, col_y: 3}`. Sparse diff vs `data`: `{col_x: 7}`. `data` becomes `{col_x: 7, col_y: 3}`. B fails — its event never lands.
- Submission C writes v3 tagged C: workbook says `{col_x: 7, col_y: 9}`. Sparse diff vs `data`: `{col_y: 9}` (col_x is already 7 in `data`, so it's not in the diff). `data` becomes `{col_x: 7, col_y: 9}`. C's event lands.

Reading the state as of C: latest stream-tagged version is v3 (index 2). Walk v1 → v2 → v3 applying sparse diffs: `{col_x: 5, col_y: 3}` → `{col_x: 7, col_y: 3}` → `{col_x: 7, col_y: 9}`. ✓ Matches C's actual workbook submission. v2's contribution to col_x is absorbed by v3 — which is correct, because C's operator also submitted col_x = 7.

For a row R that C doesn't touch but B did: R's chain is `[v1, v2]`, `data = {col_x: 7}` (B-contaminated). Reading the state as of C: latest stream-tagged version on R's chain is v1. Walk stops at v1. State = `{col_x: 5}`. ✓ B's contribution to R is correctly excluded — there is no subsequent committed version on R's chain to absorb it.

If a subsequent submission D fails and writes v4 to a row whose latest committed version was v3: v4 becomes a trailing orphan. Reading the latest committed state stops at v3 — v4 is ignored. `data` reflects v4, but the canonical state does not.

## Resolved: lifecycle-only PRN transitions on the stream

Some PRN transitions don't affect the balance — `AWAITING_ACCEPTANCE → ACCEPTED` and the rejection path among them. The question was whether to keep these off-stream (the stream stays a pure balance ledger; the PRN document remains the source of truth for non-balance lifecycle) or to record every PRN state change as an event (the stream becomes the single source of truth for PRN lifecycle as well as balance).

**Decision: record lifecycle-only transitions as events.** The taxonomy carries `prn-accepted` and `prn-rejected` as zero-effect kinds (`closingBalance` equals `openingBalance`). PRN status becomes a projection derived from the stream rather than state maintained independently on the document, which removes the dual-source-of-truth shape and brings every transition — balance-affecting or not — under the same watermark catch-up, so a failed lifecycle write recovers identically to a failed balance write (see "Reading PRN state" and "Partial failure and recovery"). The cost is a slightly larger taxonomy and zero-effect events on the stream; the gain is uniform partial-failure recovery and one source of truth for PRN state.

The exhaustive transition-to-event mapping is owned by the write-side decider in `epr-backend` and the [waste balance LLD](../defined/pepr-lld.md#waste-balance), not by this ADR.

## Considered alternatives

**Continue with ADR-0031's per-row transactions.** Works but stays at row granularity, requires the per-row delta reconciliation mechanism to be operator-recovery-correct, and frames the storage as transactions rather than events. The framing matters for extensibility: adding `accreditation-date-range-changed` to a transaction ledger is awkward; adding it to an event stream is just another kind.

**Materialise a separate current-balance document alongside the stream.** Rejected for the same reasons ADR-0031 rejected it — closing totals on each event mean a single indexed read suffices, and a materialised view adds a second optimistic-concurrency surface and stale-cache failure modes.

**Single stream per registration, phases not physically separated.** Rejected — re-accreditation under a new `accreditationId` belongs in its own stream because numbering, opening totals, and the audit boundary all naturally restart. Reusing the same partition across phase boundaries blurs that.

**Per-row events instead of per-submission.** Closer to ADR-0031. Rejected — operators don't think in rows; they submit summary logs. One submission produces one event keeps the stream at the granularity the domain operates on, and the frozen snapshot removes the per-row delta walk from the balance path.

**Compute `creditTotal` lazily by walking waste-records on every read.** Rejected — defeats the purpose of the snapshot. Contextual factors at submission time would need to be re-derived (or stored separately), and the immutability guarantee is lost.

**Two-phase commit / multi-document transaction across event + projection.** Rejected — adds a heavyweight mechanism to solve a problem the idempotent-append + ordered-writes pattern already handles. The system already tolerates eventually-consistent projections (the PRN status field has no realtime-correctness requirement that the balance lacks), so paying the cost of a transaction to keep them in lockstep is unwarranted.

**Per-row `committedHead` pointer for canonicity.** Each row document carries a watermark advanced on every stream commit, pointing at the row's latest canonical version; reads merge `[0..committedHead]`, accepting orphans below the watermark as canonical. Rejected in favour of the canonicity walk — `committedHead` requires O(rows-with-pending-versions) writes per stream commit (the commit step must sweep rows touched since the last commit, not just rows touched by the committing session). The canonicity walk recovers the same answer at read time without coupling the commit to a row-sweep.

**Timestamp comparison for canonicity.** Versions carry `writtenAt`, events carry `committedAt`; the canonical chain is versions with `writtenAt ≤ latestEvent.committedAt`. Rejected — relies on non-interleaved sessions and a monotonic database clock, neither of which the design wants to depend on for correctness when a structural alternative exists.

**Stage uncommitted versions outside waste-records.** A SUBMITTING-scoped staging area holds in-flight row versions; commit moves them into the canonical `versions[]` arrays idempotently. Rejected — solves the same problem at the cost of a larger schema/storage shift and an extra round of writes at commit time. The canonicity walk achieves the same separation of canonical from uncommitted within the existing collection.

**Stored `previousSummaryLog.id` pointer on each version.** Each new version carries an explicit reference to the summary log of its predecessor state, making each delta's "from" state self-describing without consulting the stream. Rejected as redundant — the stream is already the canonical list of committed summary log IDs, so the predecessor is reconstructible at any time as "R's latest version whose `summaryLogId` is in the stream". A stored pointer would denormalise information that's already authoritative on the stream, with no integrity gain and a maintenance hazard if the pointer ever diverged from the stream's truth.

**Per-event row manifest of workbook contents.** Each `summary-log-submitted` event carries an explicit list of `(type, rowId)` pairs representing the rows in the workbook at submission time, so the `creditTotal` snapshot is self-witnessing for which rows contributed. Rejected because the row-monotonicity premise (rows cannot be deleted from a workbook — validation rejects any submission that drops a previously-submitted row) makes presence-in-the-registration's-row-set equivalent to presence-in-every-subsequent-submission's-workbook. The chain alone witnesses every row's contribution to every submission, so the manifest would be redundant. At 60K rows × daily submissions × year-long accreditations, the storage savings from omitting the manifest are material (hundreds of MB per accreditation per year).

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

- **Supersedes the ADR-0031 implementation.** The per-row transaction-ledger code built against ADR-0031 is superseded; the design-neutral plumbing (the storage shape, the slot-conflict concurrency primitive, the `canonicalSource` cutover marker) carries forward to the stream, and the per-row-specific parts (the embedded `transactions[]` reconciliation, `creditedAmount` denormalisation) retire with it. Cutover timing is owned by the rollout design, not this ADR.
- **Per-row provenance moves off the hot path.** "What did summary log S contribute for row R?" is still answerable via the waste-records collection's version chain, but not via a single indexed query on the stream.
- **`creditTotal` re-computation cost at submission time.** Writers compute the full snapshot from the live upload + contextual factors. Cost is bounded by submission size, not by accreditation history.
- **`closingBalance.amount` and `closingBalance.availableAmount` shift together for `summary-log-submitted` events.** The split only matters when PRN events move them independently — reinforces ADR-0031's both-fields-per-event invariant.
- **Per-kind partial unique indexes** on natural idempotency keys (`prnId`, `summaryLogId`). Each new event kind that needs at-most-once semantics adds an index. The set is small and bounded by the event taxonomy.
- **PRN document status becomes a projection with a watermark catch-up read pattern.** Reads carry a cost of one indexed point-query (`payload.prnId` filtered by `number > doc.eventNumber`) on top of loading the document — usually returning zero events. The doc is no longer the sole source of truth for PRN state; consumers that bypass the read helper would see a stale view.

## Out of scope

- **Migration / cutover from current state.** Deliberately separate; this doc fixes the target design only.
- **Accreditation lifecycle events** (`accreditation-granted`, `accreditation-expired`, `accreditation-date-range-changed`). Future extensions enabled by the discriminated payload.
- **Manual adjustments** and **regulator overrides**. Future extensions.
- **Two-phase patterns beyond PRN issuance** (e.g. the summary-log SUBMITTING TTL). Addressed elsewhere.

## Related

- [ADR-0031](./0031-waste-balance-transaction-ledger.md) — the per-row transaction ledger this design supersedes
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — the underlying `amount = sum(credits) − sum(debits)` projection
- [Waste balance ledger rollout](../discovery/waste-balance-ledger-rollout.md) — rollout and cutover design (the `canonicalSource` marker that gates each accreditation onto the stream)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — parent Jira ticket
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — design drift root cause
- [PAE-1439](https://eaflood.atlassian.net/browse/PAE-1439) — concurrency issue resolved by this design
