# 31. Waste balance per-event transaction ledger

Date: 2026-04-21

## Status

Proposed

## Context

The [waste balance LLD](../defined/pepr-lld.md#waste-balance) describes a `transactions` array on the waste balance document but does not explicitly choose between per-event and per-row emission. Its schema has `entities[]` as a plural array on each transaction, and one transaction in the worked example bundles two `waste_record:received` entities from the same upload (40 tonnes CREDIT, two rows, one transaction) — both consistent with a per-event reading. The remaining transactions in the example are single-entity and neutral between the two readings.

The as-built went per-row. Since PR #526 ([DEFRA/epr-backend#526](https://github.com/DEFRA/epr-backend/pull/526), PAE-659, December 2025) the calculator emits **one transaction per waste record** and reconciles re-uploads via a `creditedAmountMap` keyed by `String(rowId)`. [summary-log-data-flow.md](../defined/summary-log-data-flow.md) was later written to describe this per-row delta mechanism as if it were the intended design. The LLD and `summary-log-data-flow.md` therefore pull in opposite directions, neither acknowledges the other, and no ADR has chosen between them.

Two problems have since surfaced from the per-row as-built:

**Correctness ([PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364)).** `rowId` is not unique across waste record types — the real identity is `(type, rowId)`. A Received row and a Reprocessed row that share a rowId collide in the map, and the Reprocessed target of 0 silently wipes the Received credit. The diagnostic landing on PR #1086 has already identified seven affected registrations on production, one with 13,037 colliding rowIds.

**Scale ([PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382)).** Per-row emission produces unbounded document growth. Per-transaction BSON cost is 400-600 bytes, so MongoDB's 16MB document ceiling equates to roughly 30,000 transactions, with noticeable read/write and optimistic-lock churn starting at 1,000-2,000. A reprocessor submitting 200 changed rows per day for a year produces 73,000 transactions — already past the ceiling. Failure is per-accreditation and silent. A hidden multiplier compounds this: each transaction's entity carries `previousVersionIds[]`, which grows by a UUID per re-submit of the same row.

A per-event ledger does not have either failure mode. There is no per-row lookup, so no key can collide. The ledger grows by one entry per business event, not per affected row, so a 3,000-row upload appends one to three transactions instead of up to 3,000. The LLD's `amount` and `availableAmount` fields are defined as projections over the transactions (`amount = sum(credits) - sum(debits)`); the transactions are the balance, not a secondary audit trail.

## Decision

Adopt a per-event transaction ledger, structured so that the current balance is a projection on the accreditation's transactions:

- Each accreditation has its own append-only **ledger** of transactions. A transaction is appended for every business event that moves the balance — a summary log upload or a PRN operation.
- Each transaction carries a `number` that is sequential per accreditation, starting at 1. Uniqueness of `(accreditationId, number)` is enforced by the database, so two writers cannot claim the same slot.
- The **waste balance document** becomes a projection of the ledger. It holds the running totals (`amount`, `availableAmount`) and the `lastTransactionNumber` it is correct at. There is no embedded transaction array.

Implemented in new MongoDB collections running alongside the existing `waste-balances`, so the two designs can coexist during cutover — reads fall back to the v1 shape until each accreditation has a v2 projection.

In v2:

- A summary log upload appends **one transaction per affected waste record type**, carrying every included record in `entities` and an `amount` equal to the net change to that type's contribution since the previous transaction. The ledger grows by one to three transactions per upload (one per affected type), not one per affected row.
- PRN operations continue to append one transaction per action.
- **All writers share one append mechanism.** Summary log, PRN issuance, PRN cancellation, future writers — all go through the same optimistic-write path below. Without this, two kinds of writer could race over the same accreditation and produce inconsistent running totals.
- The ledger is append-only. There is no per-row keying anywhere.
- Entities carry `currentVersionId` only. `previousVersionIds[]` is dropped — prior versions of a waste record are already recorded on the waste-records document, and duplicating that history on every transaction inflates the ledger without adding audit value not already available at source.

### Writing a transaction

Every write, regardless of origin, follows the same steps:

1. Read the current waste balance document. You get the running totals and `lastTransactionNumber`.
2. Compute the change the business event produces.
3. Append a new transaction at `number = lastTransactionNumber + 1`. If the database rejects the insert because another writer has already claimed that number, go back to step 1 and retry.
4. Update the waste balance document to reflect the new transaction, using an optimistic lock on `lastTransactionNumber` — the same optimistic-update pattern already used elsewhere in the backend.

If step 4 fails because another writer has updated the waste balance between reads, no data is lost: the ledger already holds the transaction, and the next reader or writer detects the staleness and catches up.

### Checking freshness

Comparing `wasteBalance.lastTransactionNumber` against the highest `number` in the ledger for that accreditation is a two-integer check. If they match, the waste balance is current. If the waste balance is behind, the reader can wait, re-project from the ledger, or accept that the balance may be one or two transactions stale, depending on the use case.

### Pattern

This is event sourcing with a projection — the ledger is the event stream, the waste balance document is the projection. We are not adopting any event-sourcing library or framework. The pattern is applied in the existing Hapi + MongoDB idiom, using optimistic-locking primitives already in use elsewhere in the backend.

## Considered alternatives

**Keep per-row emission, move the array out into a sibling collection.** Addresses the scale risk in PAE-1382 by freeing each transaction from the 16MB ceiling, but does not on its own fix the per-row keying bug (PAE-1364) — the calculator still emits one transaction per row and the entity-id collision persists, just in a different shape of storage. Rejected because per-event is consistent with the LLD's schema and multi-entity example, and choosing per-event fixes the correctness bug and the scale bug in one change.

## Consequences

### Positive

- Eliminates the class of bugs caused by per-row keying, including PAE-1364 and any future overlap in entity-identity space. No per-row keying exists in v2.
- Bounds document growth. One to three transactions per summary log upload, one per PRN operation — a daily-uploading reprocessor produces on the order of 365-1000 ledger entries per year, comfortably below the 16MB ceiling (≈30,000 at today's per-transaction size). Dropping `previousVersionIds[]` removes the per-entity unbounded-growth multiplier identified in PAE-1382. The scale risk is fully retired.
- The waste balance document shrinks to running totals plus one integer — cheap to read, cheap to update, bounded in size forever.
- **Freshness is cheap to check.** Comparing two integers tells any reader whether the waste balance is current. Today the only way to check is to rebuild.
- **Self-healing.** If the waste balance update fails mid-write, the ledger still holds the correct transaction; the next reader or writer detects the staleness via `lastTransactionNumber` and catches up. The ledger is the source of truth; the waste balance is a derived view.
- Resolves the ambiguity between the LLD and `summary-log-data-flow.md` by making per-event the canonical design, consistent with the LLD's schema and multi-entity example.
- Ledger entries map one-to-one to business events, making the audit trail readable when it is eventually surfaced.

### Negative

- Requires new collections and a cutover path. Readers must handle both v1 and v2 during transition.
- PRN write paths move onto the shared append mechanism rather than writing their own transactions directly. They already emit one transaction per action so the shape change is minor, but the mechanism change is not a no-op — the work isn't purely additive on top of v1.
- Anyone reading a v2 transaction in isolation no longer sees the version history on the entity — they must consult the waste-records document to trace prior versions. This is a move from duplicated state to a single source of truth, but any tooling or UI that relied on `previousVersionIds[]` on the ledger must now follow the reference.
- `summary-log-data-flow.md` needs rewriting to match the chosen design — the "Prior transactions per rowId" and "delta mechanism" descriptions will no longer apply. The LLD's worked example would also benefit from a comment noting that each transaction represents one business event, to close the ambiguity that allowed the drift in the first place.

## Related

- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — schema and multi-entity example this ADR is consistent with
- [Summary log data flow](../defined/summary-log-data-flow.md) — currently describes the per-row as-built; needs rewriting alongside this decision
- [DEFRA/epr-backend#490](https://github.com/DEFRA/epr-backend/pull/490) (PAE-659) — initial calculator
- [DEFRA/epr-backend#526](https://github.com/DEFRA/epr-backend/pull/526) (PAE-659) — introduced per-row `creditedAmountMap`; the per-row as-built originated here
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — correctness bug caused by the per-row as-built
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — scale bug caused by the per-row as-built
