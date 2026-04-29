# 31. Waste balance transaction ledger

Date: 2026-04-21

## Status

Accepted

**Amended 2026-04-29:** denormalise the running per-`wasteRecordId` credited total onto summary-log-row transactions (`closingCreditedAmount`), so per-row delta reconciliation reads via `find-latest` rather than signed-sum aggregation. No production data exists under this ADR yet, so the change is amend-in-place rather than superseding.

## Context

The waste balance document embeds a `transactions[]` array recording every credit, debit, and pending debit that moves the accreditation's balance. Each transaction is around 400-600 bytes of BSON, so a daily-uploading reprocessor approaches MongoDB's 16MB document ceiling within a year ([PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382)) — at current emission rates the ceiling lands at roughly 30,000 transactions. Failure is per-accreditation and silent. A hidden multiplier compounds this: each transaction's entity carries `previousVersionIds[]`, which grows by a UUID per re-submit of the same row.

The [waste balance LLD](../defined/pepr-lld.md#waste-balance) defines `amount` and `availableAmount` as projections over the transaction history (`amount = sum(credits) - sum(debits)`) — the transactions are the authoritative record of the balance. In practice the current balance calculation in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) derives the balance from the waste-records collection directly, bypassing the ledger. This is a workaround for a separate correctness issue ([PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364)), and while it's safe today it leaves the ledger as an underused artefact and couples the balance to a source (waste records) that wasn't designed to be authoritative for it. Returning to a ledger-derived balance — the design the LLD describes — requires a storage shape where the ledger is durable and authoritative at scale, which the embedded-array approach cannot provide.

## Decision

Move the transactions out of the waste balance document into a separate append-only ledger collection. The ledger becomes the authoritative and sole store of balance state. Each transaction carries the running totals it produced (`closingAmount`, `closingAvailableAmount`), so the current balance is always the closing totals on the latest transaction — no separate projection document is needed.

This is a standard ledger pattern: an append-only log of transactions with sequential numbering per aggregate. Variants appear in double-entry accounting, event-sourced systems, and any design where state is reconstructible from a durable history. What's slightly unusual here is that each entry also carries its own snapshot of the resulting totals, which collapses the classical event-sourcing trichotomy of events, snapshots, and projections into a single row. That collapse is what lets the ledger stand alone as both audit trail and current-state store.

Shape:

- Each accreditation has an append-only **ledger** — a collection of transactions. Each transaction is its own document.
- Each transaction carries a `number` that is sequential per accreditation, starting at 1. Uniqueness of `(accreditationId, number)` is enforced by the database, so two writers cannot claim the same slot.
- Each transaction carries the running totals (`closingAmount`, `closingAvailableAmount`) it produced. The current balance for an accreditation is the closing totals on its highest-numbered transaction — one indexed read.
- **One balance-affecting event produces exactly one transaction, referring to exactly one affected entity.** A summary-log row produces one transaction referring to one waste record; a PRN operation (creation, issuance, acceptance, cancellation) produces one transaction referring to one PRN; a manual adjustment produces one transaction. The affected entity is identified within the transaction's `source` object — there is no multi-entity shape.

Implemented as a new MongoDB ledger collection. The existing `waste-balances` collection remains in place during cutover; reads fall back to it until each accreditation has been transitioned to the ledger.

### Transaction shape

Each transaction document keeps almost the same field set as today. The only changes are those the mechanism requires.

**New fields:**

- `accreditationId` — top-level reference; partition key for the ledger (previously implicit in the embedding document).
- `organisationId`, `registrationId` — denormalised onto each transaction. Organisation-level and registration-level queries (e.g. `GET /v1/organisations/{id}/waste-balances`) then resolve with a single indexed lookup rather than requiring a join from accreditation back to its parents. Both values are immutable for the lifetime of an accreditation, so the denormalisation is safe.
- `number` — sequential per accreditation, starting at 1.
- `source` — nested object recording both the upstream event that caused this transaction and the entity it affected, discriminated by `source.kind`:
  - `summary-log-row` → `source.summaryLogRow: { summaryLogId, rowId, rowType, wasteRecordId, wasteRecordVersionId }`
  - `prn-operation` → `source.prnOperation: { prnId, operationType }`
  - `manual-adjustment` → `source.manualAdjustment: { userId, reason }`

  Exactly one sub-object is populated per transaction. Because one summary-log row produces exactly one waste-record update, and one PRN operation affects exactly one PRN, the source uniquely identifies both the cause and the affected entity — there is no need for a separate entity array. Queries resolve directly: "which transactions did summary log S produce?" is a single indexed lookup on `source.summaryLogRow.summaryLogId`; "which transactions touched waste record W?" is `source.summaryLogRow.wasteRecordId`; "which transactions did a specific row cause?" is a compound lookup on `(summaryLogId, rowId, rowType)`. No traversal through waste-records.
- `closingCreditedAmount` (`Decimal128`) — **summary-log-row transactions only**. The closing net credit total for the affected `wasteRecordId` after this transaction is applied: `previousClosingCreditedFor(wasteRecordId) + amount(signed) = closingCreditedAmount`. PRN operations and manual adjustments do not carry this field; their reconciliation keys (`prnId`, `userId`) live in different namespaces.

**Removed fields:**

- `id` (the existing UUID on embedded transactions) — dropped. Nothing outside the waste-balance document references it: the public API exposes only totals, the admin and public frontends do not display it, and audit logs record transaction payloads by value rather than by id lookup. `(accreditationId, number)` becomes the sole business identifier for a transaction.
- `entities[]` — dropped entirely. The existing shape is a plural array for forward flexibility, but under per-row emission every transaction has exactly one entity and every current code path (`buildTransaction`, `buildPrnCreationTransaction`, `buildPrnIssuedTransaction`, `buildPrnCancellationTransaction`, `buildIssuedPrnCancellationTransaction`) hardcodes a single-element array literal. The affected entity is fully determined by the source kind, so folding its identifiers into `source` removes a lie in the schema (plural-with-guaranteed-length-one) without losing any information.
- `entities[].previousVersionIds[]` — dropped along with the array. Version history is reconstructable from the ledger itself: every transaction that touched waste record W references it via `source.summaryLogRow.wasteRecordId` with the version id at that point, so querying for that `wasteRecordId` sorted by `number` yields the full version progression in chronological order. Carrying `previousVersionIds[]` on every transaction was an unbounded duplication of history already implicit in the transaction chain.

**Kept unchanged:**

- `type` (`credit`, `debit`, `pending_debit`)
- `createdAt`, `createdBy`
- `amount` (the delta)
- `openingAmount`, `closingAmount`, `openingAvailableAmount`, `closingAvailableAmount` — running totals recorded per transaction, so every entry is self-auditing (`opening + delta = closing`) without needing to consult its predecessor.

Uniqueness of `(accreditationId, number)` is enforced by a compound unique index. That single index also serves the read patterns — "find transactions for this accreditation", "find transaction N", "sort by number" — so one index covers both the optimistic-append lock and the query path. The MongoDB-assigned `_id` remains an auto-generated `ObjectId` used only inside the storage layer.

A second compound index `(accreditationId, source.summaryLogRow.wasteRecordId, number)` (descending on `number`) serves the per-row delta reconciliation read — find-latest-summary-log-row-transaction-per-`wasteRecordId`. Only summary-log-row transactions populate `source.summaryLogRow.wasteRecordId`, so PRN operations, PRN pending debits, and manual adjustments do not appear in the index — the per-row reconciliation needs no pending-debit filter.

### Writing a transaction

Every write follows the same steps:

1. Read the latest transaction for the accreditation — one indexed read (`find({accreditationId}).sort({number: -1}).limit(1)`). You get its `number` and its closing totals. If no transactions exist yet, start from `number = 0` and zero totals.
2. Compute the change the business event produces.
3. Insert a new transaction at `number = latestNumber + 1` with the updated global closing totals (and, for summary-log-row transactions, with `closingCreditedAmount = previousClosingCreditedFor(wasteRecordId) + amount`, where the previous value comes from the latest prior summary-log-row transaction matching the same `wasteRecordId` or zero if none exists). If the database rejects the insert because another writer has already claimed that number, go back to step 1 and retry.

The unique index on `(accreditationId, number)` is the only enforcement point for concurrency. There is no second document to update and no second optimistic-lock surface.

### Per-row delta reconciliation

Summary-log-row writes carry a per-row idempotency invariant — the read-before-emit rule — that makes operator re-upload the recovery path for any partial prior submission. For each row in an incoming summary log:

1. Compute `targetAmount` from the waste record's current data (the value the latest waste-record version carries after this upload).
2. Read `alreadyCredited` from the `closingCreditedAmount` on the latest prior summary-log-row transaction whose `source.summaryLogRow.wasteRecordId` matches this row — one indexed seek per row, served by the secondary index above. If no prior transaction exists for this `wasteRecordId`, `alreadyCredited` is zero.
3. Compute `delta = targetAmount - alreadyCredited`.
4. If `delta = 0`, emit nothing — the row is already correctly credited.
5. Otherwise append one ledger transaction for the signed delta.

Every submission is self-converging under this invariant: whatever state a partial prior run left behind — no prior transactions, some prior transactions, a full prior contribution — a re-upload ends with the ledger at the correct totals for each row. The mechanism is the same idea as the embedded-array implementation's in-memory `creditedAmountMap` (`calculator.js`, keyed by `rowId`), but persisted: every summary-log-row transaction stamps the running per-`wasteRecordId` total it produced (`closingCreditedAmount`) onto itself, so reconciliation reads it via `find-latest` rather than recomputing it from history. Re-keying onto `wasteRecordId` rules out the PAE-1380 rowId-collision class, and persisting the running total extends the closing-totals self-audit (`opening + delta = closing`) from the global balance to per-`wasteRecordId` tracking.

PRN operations and manual adjustments key on `prnId` and `userId` respectively and carry their deltas directly; the read-before-emit invariant applies only to summary-log-row writes.

### Reading the current balance

The current balance for an accreditation is the `closingAmount` and `closingAvailableAmount` on its highest-numbered transaction — a single indexed read. If no transactions exist, the balance is zero.

No cached projection exists, so there is no staleness to check and no reconciliation path to maintain. The ledger is the authoritative and sole store of balance state.

## Considered alternatives

**Keep transactions embedded, manage growth via archival or pruning.** Defers the size problem rather than removing it. The projection stays coupled to a bounded-capacity document, and the ledger cannot safely be the authoritative source of truth under concurrent writes. Rejected — we'd be revisiting the same decision when the ceiling returns, and it doesn't unlock a return to ledger-derived balance calculation.

**Keep the current workaround: derive balance from waste records and leave the ledger largely unused.** Works in the short term but waste records are not the natural source of truth for a balance that is moved by both summary-log uploads and PRN operations. Rejected because it freezes the current ledger into an artefact of history rather than a durable source of truth.

**Keep the existing UUID `id` on transactions alongside the sequential `number`.** Carrying two identifiers for the same transaction creates a second surface area — any future caller has to choose which to use, and both have to stay in sync. Since `(accreditationId, number)` is already unique by construction and is what every read and write needs to use, a separate UUID adds no capability. Rejected.

**Use a compound `_id: { accreditationId, number }` instead of flat fields plus a compound unique index.** The composite would give uniqueness for free from the primary key, at a saving of 24 bytes per document. Rejected because every query would have to reach through dotted paths (`{ '_id.accreditationId': ... }`), which is visually noisier and less obvious to readers than top-level fields. The extra ObjectId is cheap; the query ergonomics are not.

**Keep a materialised projection document alongside the ledger.** Maintain the waste balance as a separate document carrying `amount`, `availableAmount`, and `lastTransactionNumber`, updated after each ledger append under an optimistic lock, rebuildable from the ledger on demand. Rejected because every transaction already carries its own closing totals, so the current balance is available in a single indexed read on the latest transaction — the projection would cache information already cheap to derive. Maintaining it introduces a second optimistic-concurrency surface, creates stale-cache and projection-repair states that otherwise do not exist, and doubles the collection count to migrate and reason about, for no measurable query benefit.

**Keep `entities[]` (plural array) on transactions for forward flexibility.** The LLD currently specifies `entities: WASTE-BALANCE-TRANSACTION-ENTITY[]` and one worked example bundles two entities in a single transaction. Rejected because no production code path has ever populated the array with more than one element: five construction sites (`buildTransaction`, `buildPrnCreationTransaction`, `buildPrnIssuedTransaction`, `buildPrnCancellationTransaction`, `buildIssuedPrnCancellationTransaction`) each hardcode a single-element literal, and per-row emission guarantees this will remain the case. Every caller reads `entities[0]`. Collapsing the entity identifiers into `source` removes the plural-with-guaranteed-length-one lie without losing any capability; if a multi-entity transaction is ever genuinely required, the shape can be evolved at that point rather than reserved speculatively today.

**Compute `alreadyCredited` via signed-sum aggregation over prior matching transactions, without persisting a per-`wasteRecordId` running total.** The original shape of this ADR before the 2026-04-29 amendment. Rejected because the closing-totals discipline (`opening + delta = closing` carried on every transaction) was applied only to the global running totals, not to per-`wasteRecordId` tracking. The aggregation primitive carries signed-sum semantics, sign handling, pending-debit filtering, and `accreditationId` scoping — discipline that lives outside the ledger and leaks into both the contract surface and the consumer's reasoning. Persisting `closingCreditedAmount` on each summary-log-row transaction makes the per-row read primitive symmetrical with the balance read primitive (`find-latest-by-key`), and the pending-debit filter disappears because PRN pending debits do not carry a `wasteRecordId` source path. Cost is one `Decimal128` field per summary-log-row transaction.

## Consequences

### Positive

- **Removes the scale limit.** Transactions live in their own collection, with an index on `(accreditationId, number)`. The 16MB document ceiling no longer applies per accreditation. Dropping `previousVersionIds[]` removes the per-entity unbounded-growth multiplier as well.
- **Makes the ledger the authoritative and sole store of balance state.** Balance calculation returns to being derived from the transaction history (the LLD's original design). This in turn allows the [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) workaround in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) to be revisited once correct keying is in place.
- **Uses a well-established bookkeeping pattern.** Append-only ledger + sequential numbering per aggregate is the standard design in double-entry accounting, event-sourced systems, and financial ledgers. Carrying the running totals on each entry is the standard trick for making any entry self-auditing against its predecessor (`opening + delta = closing`).
- **No cached state to maintain.** There is no separate projection document that can go stale, get corrupted, or need repair — so the failure modes associated with maintaining one simply do not exist.
- **Single write mechanism.** Summary-log row writes and PRN operations both append to the same ledger through the same optimistic-append path — no separate code to update a projection, no second concurrency surface.
- **Constant-cost balance reads.** The current balance for an accreditation is a single indexed read on the latest transaction — O(1) via the `(accreditationId, number)` index. Organisation-level and registration-level queries resolve with a single-pass aggregation against denormalised `organisationId` / `registrationId` fields on each transaction.
- **Per-row reconciliation matches the global balance discipline.** Each summary-log-row transaction is self-auditing per `wasteRecordId` (`previousClosingCreditedFor + delta = closingCreditedFor`), and the read primitive is a single indexed seek on the secondary index. Pending-debit filtering and signed-sum reasoning live inside the ledger's own discipline rather than at the consumer.
- **Provenance queries are direct — both for causes and for entity history.** The nested `source` object means "which transactions did summary log S produce?", "which transactions did PRN P cause?", and "how did waste record W evolve?" all resolve with a single indexed query on the ledger. The chain of transactions referencing the same `wasteRecordId`, sorted by `number`, is the full version progression in chronological order with balance context at each step — the ledger is authoritative for both balance state _and_ entity version history, with no traversal through waste-records needed. This is also what the PAE-1364 long-term fix needs for summary-log → transaction reconciliation.

### Negative

- Requires a new collection and a cutover path. Readers must handle both v1 (balance on the waste-balance document) and v2 (balance derived from the ledger's latest transaction) during the transition.
- PRN write paths move from updating the embedded transactions array to appending to the ledger collection via the shared optimistic-write mechanism. The transaction shape itself is nearly unchanged but the mechanism is, so the migration is not purely additive on top of v1.
- Anyone reading a single v2 transaction no longer sees the full version history of the affected entity inline — only the current version id (via `source`). The information is still ledger-native: consumers reconstruct the history by querying for all transactions referencing the same `wasteRecordId` and sorting by `number`. The access pattern changes from an in-place array read to a per-record indexed query.
- The LLD needs updating to match: `entities[]` → single entity identifiers folded into `source`, and the worked example that shows a multi-entity transaction needs revising to reflect the per-row, single-entity invariant.
- Organisation-level and registration-level balance queries rely on `organisationId` and `registrationId` being denormalised onto every transaction. These values are immutable for the lifetime of an accreditation, so the denormalisation is safe, but each transaction document is a few dozen bytes larger than strictly necessary.
- Summary-log-row transactions also carry `closingCreditedAmount` — one extra `Decimal128` per row transaction (~16 bytes) on top of the four global running totals. Modest per-document, but explicit, and confined to summary-log-row transactions only.
- `summary-log-data-flow.md` needs updating to describe the new storage shape.
- Summary-log submission writes a batch of ledger transactions — one per balance-affecting row — via per-transaction optimistic appends. Under the embedded-array shape the equivalent step was a single `$set` + `$push $each` on the waste-balance document, atomic at the document level; the ledger shape replaces that with N independent writes and a crash mid-batch can leave K of N committed. Partial ledger contributions are individually self-consistent (each row still carries valid opening/closing totals against its predecessor), but the batch can be incomplete. Because the authoritative balance is read from the closing totals on the latest ledger entry, those totals reflect only the K rows that landed — the balance is inaccurate with respect to the submitted summary log, and nothing in the ledger distinguishes this interim state from a fully-committed submission, until the operator re-uploads. Recovery relies on the operator-re-upload path and the per-row delta reconciliation invariant above: on re-upload, already-credited rows produce zero deltas and emit nothing, missing rows emit their full credits, and the end state converges regardless of how much of the prior submission landed. The single-document atomicity the embedded-array shape provided for free is replaced by a caller-level invariant that every summary-log-row writer must preserve.

## Related

- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — the `amount = sum(credits) - sum(debits)` projection this ADR makes operationally reliable
- [Summary log data flow](../defined/summary-log-data-flow.md) — needs updating alongside this decision
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver for this ADR
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — separate correctness fix, currently workaround-fixed in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091); returning to ledger-derived balance calculation (which this ADR enables) is the longer-term fix
