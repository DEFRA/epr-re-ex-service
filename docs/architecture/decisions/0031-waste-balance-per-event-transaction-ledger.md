# 31. Waste balance per-event transaction ledger

Date: 2026-04-21

## Status

Proposed

## Context

The [waste balance LLD](../defined/pepr-lld.md#waste-balance) describes the `transactions` array on a waste balance document as a **per-event ledger**: each business action (a summary log upload, a PRN operation) produces one transaction, which may reference multiple entities. The worked example in that doc shows a single CREDIT of 40 tonnes with two `waste_record:received` entities — one upload event, two records, one ledger entry.

The as-built implementation diverged from this. Since PR #526 ([DEFRA/epr-backend#526](https://github.com/DEFRA/epr-backend/pull/526), PAE-659, December 2025) the calculator emits **one transaction per waste record** and reconciles re-uploads via a `creditedAmountMap` keyed by `String(rowId)`. `summary-log-data-flow.md` was later written to describe this per-row delta mechanism as if it were the intended design. Neither document acknowledges the other, and no ADR records the shift.

Two problems have since surfaced from this divergence:

**Correctness ([PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364)).** `rowId` is not unique across waste record types — the real identity is `(type, rowId)`. A Received row and a Reprocessed row that share a rowId collide in the map, and the Reprocessed target of 0 silently wipes the Received credit. The diagnostic landing on PR #1086 has already identified seven affected registrations on production, one with 13,037 colliding rowIds.

**Scale ([PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382)).** Per-row emission produces unbounded document growth. Per-transaction BSON cost is 400-600 bytes, so MongoDB's 16MB document ceiling equates to roughly 30,000 transactions, with noticeable read/write and optimistic-lock churn starting at 1,000-2,000. A reprocessor submitting 200 changed rows per day for a year produces 73,000 transactions — already past the ceiling. Failure is per-accreditation and silent. A hidden multiplier compounds this: each transaction's entity carries `previousVersionIds[]`, which grows by a UUID per re-submit of the same row.

The per-event design in the LLD does not have either failure mode. There is no per-row lookup, so no key can collide. The ledger grows by one entry per business event, not per affected row, so a 3,000-row upload appends one to three transactions instead of up to 3,000. The `amount` and `availableAmount` fields are defined in the LLD as projections over the ledger (`amount = sum(credits) - sum(debits)`); the transactions are the balance, not a secondary audit trail.

## Decision

Restore the per-event transaction ledger described in the LLD.

Implemented in a new MongoDB collection (`waste-balances-v2` or similar) running alongside the existing collection, so the two can coexist during cutover and reads fall back to v1 until each accreditation has a v2 document.

In v2:

- A summary log upload produces **one transaction per affected waste record type**, carrying every included record in `entities` and an `amount` equal to the net change to the waste-record contribution since the previous transaction. The ledger grows by one entry per upload.
- PRN operations continue to produce one transaction per action, as they already do. PRN transactions from v1 are carried over unchanged on cutover.
- `amount` and `availableAmount` are stored as materialised projections of the ledger, kept in sync as transactions append.
- The ledger is append-only. There is no per-row keying anywhere.
- Entities carry `currentVersionId` only — the version that contributed to *this* event. `previousVersionIds[]` is dropped. Prior versions of a waste record are already recorded on the waste-records document; duplicating that history on every transaction inflates the ledger without adding audit value that isn't already available at source.

## Considered alternatives

**One document per transaction (separate `waste-balance-transactions` collection).** Addresses the scale risk in PAE-1382 by moving transactions out of the waste-balance document, but does not on its own fix the per-row keying bug (PAE-1364) — the calculator could still emit one transaction per row into a sibling collection and the entity-id collision would persist. Rejected because per-event semantics are already specified in the LLD and the correctness fix and the scale fix are one change: restoring per-event.

## Consequences

### Positive

- Eliminates the class of bugs caused by per-row keying, including PAE-1364 and any future overlap in entity-identity space.
- Bounds document growth. One transaction per upload per waste record type means a daily-uploading reprocessor produces on the order of 365-1000 transactions per year, comfortably below the 16MB ceiling (≈30,000 at today's per-transaction size). Dropping `previousVersionIds[]` removes the per-entity unbounded-growth multiplier identified in PAE-1382. The scale risk is fully retired.
- Brings the implementation back in line with the LLD. No silent design drift.
- Ledger entries map one-to-one to business events, making the audit trail readable when it is eventually surfaced.
- PRN code paths are untouched — they already follow the per-event pattern.

### Negative

- Requires a new collection and a cutover path. Readers must handle both v1 and v2 during transition.
- Anyone reading a v2 transaction in isolation no longer sees the version history on the entity — they must consult the waste-records document to trace prior versions. This is a move from duplicated state to a single source of truth, but any tooling or UI that relied on `previousVersionIds[]` on the ledger must now follow the reference.
- `summary-log-data-flow.md` needs correction to match the restored design — the "Prior transactions per rowId" and "delta mechanism" descriptions will no longer apply.

## Related

- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — per-event design this ADR restores
- [Summary log data flow](../defined/summary-log-data-flow.md) — currently describes the per-row as-built; needs updating alongside this decision
- [DEFRA/epr-backend#490](https://github.com/DEFRA/epr-backend/pull/490) (PAE-659) — initial calculator
- [DEFRA/epr-backend#526](https://github.com/DEFRA/epr-backend/pull/526) (PAE-659) — introduced per-row `creditedAmountMap`, where the divergence entered the codebase
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — correctness bug caused by the divergence
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — scale bug caused by the divergence
