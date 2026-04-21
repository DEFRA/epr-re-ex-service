# 31. Waste balance per-event transaction ledger

Date: 2026-04-21

## Status

Proposed

## Context

The [waste balance LLD](../defined/pepr-lld.md#waste-balance) describes the `transactions` array on a waste balance document as a **per-event ledger**: each business action (a summary log upload, a PRN operation) produces one transaction, which may reference multiple entities. The worked example in that doc shows a single CREDIT of 40 tonnes with two `waste_record:received` entities — one upload event, two records, one ledger entry.

The as-built implementation diverged from this. Since PR #526 ([DEFRA/epr-backend#526](https://github.com/DEFRA/epr-backend/pull/526), PAE-659, December 2025) the calculator emits **one transaction per waste record** and reconciles re-uploads via a `creditedAmountMap` keyed by `String(rowId)`. `summary-log-data-flow.md` was later written to describe this per-row delta mechanism as if it were the intended design. Neither document acknowledges the other, and no ADR records the shift.

The divergence has now produced a production bug ([PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364)). Because `rowId` is not unique across waste record types — the real identity is `(type, rowId)` — a Received row and a Reprocessed row that share a rowId collide in the map, and the Reprocessed target of 0 silently wipes the Received credit. The diagnostic landing on PR #1086 has already identified seven affected registrations on production, one with 13,037 colliding rowIds.

The per-event design in the LLD does not have this failure mode. There is no per-row lookup, so no key can collide. The `amount` and `availableAmount` fields are defined in the LLD as projections over the ledger (`amount = sum(credits) - sum(debits)`); the transactions are the balance, not a secondary audit trail.

## Decision

Restore the per-event transaction ledger described in the LLD.

Implemented in a new MongoDB collection (`waste-balances-v2` or similar) running alongside the existing collection, so the two can coexist during cutover and reads fall back to v1 until each accreditation has a v2 document.

In v2:

- A summary log upload produces **one transaction per affected waste record type**, carrying every included record in `entities` and an `amount` equal to the net change to the waste-record contribution since the previous transaction. The ledger grows by one entry per upload.
- PRN operations continue to produce one transaction per action, as they already do. PRN transactions from v1 are carried over unchanged on cutover.
- `amount` and `availableAmount` are stored as materialised projections of the ledger, kept in sync as transactions append.
- The ledger is append-only. There is no per-row keying anywhere.

## Consequences

### Positive

- Eliminates the class of bugs caused by per-row keying, including PAE-1364 and any future overlap in entity-identity space.
- Brings the implementation back in line with the LLD. No silent design drift.
- Ledger entries map one-to-one to business events, making the audit trail readable when it is eventually surfaced.
- PRN code paths are untouched — they already follow the per-event pattern.

### Negative

- Requires a new collection and a cutover path. Readers must handle both v1 and v2 during transition.
- Per-upload ledger growth: one transaction per upload rather than zero-or-one deltas per row. In practice this is much smaller than the current per-row output (a 3,000-row upload becomes one to three transactions instead of up to 3,000).
- `summary-log-data-flow.md` needs correction to match the restored design — the "Prior transactions per rowId" and "delta mechanism" descriptions will no longer apply.

## Related

- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — per-event design this ADR restores
- [Summary log data flow](../defined/summary-log-data-flow.md) — currently describes the per-row as-built; needs updating alongside this decision
- [DEFRA/epr-backend#490](https://github.com/DEFRA/epr-backend/pull/490) (PAE-659) — initial calculator
- [DEFRA/epr-backend#526](https://github.com/DEFRA/epr-backend/pull/526) (PAE-659) — introduced per-row `creditedAmountMap`, where the divergence entered the codebase
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — production bug caused by the divergence
