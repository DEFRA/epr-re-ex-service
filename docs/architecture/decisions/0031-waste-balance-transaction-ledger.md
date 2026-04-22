# 31. Waste balance transaction ledger

Date: 2026-04-21

## Status

Proposed

## Context

The waste balance document embeds a `transactions[]` array recording every credit, debit, and pending debit that moves the accreditation's balance. Each transaction is around 400-600 bytes of BSON, so a daily-uploading reprocessor approaches MongoDB's 16MB document ceiling within a year ([PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382)) — at current emission rates the ceiling lands at roughly 30,000 transactions. Failure is per-accreditation and silent. A hidden multiplier compounds this: each transaction's entity carries `previousVersionIds[]`, which grows by a UUID per re-submit of the same row.

The [waste balance LLD](../defined/pepr-lld.md#waste-balance) defines `amount` and `availableAmount` as projections over the transaction history (`amount = sum(credits) - sum(debits)`) — the transactions are the authoritative record of the balance. In practice the current balance calculation in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) derives the balance from the waste-records collection directly, bypassing the ledger. This is a workaround for a separate correctness issue ([PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364)), and while it's safe today it leaves the ledger as an underused artefact and couples the balance to a source (waste records) that wasn't designed to be authoritative for it. Returning to a ledger-derived balance — the design the LLD describes — requires a storage shape where the ledger is durable and authoritative at scale, which the embedded-array approach cannot provide.

## Decision

Move the transactions out of the waste balance document into a separate append-only ledger collection. The ledger becomes the authoritative record of every balance-affecting event. The waste balance document becomes a materialised projection over the ledger — running totals kept in sync as transactions append, rebuildable from the ledger at any time.

This is a standard ledger-and-projection pattern: an append-only log of transactions backed by sequential numbering, with a cached summary (the projection) that can be reconstructed from the log. Variants appear in double-entry accounting, event-sourced systems, and any design where a derived state must be reconcilable against a durable history. Nothing novel is being invented.

Shape:

- Each accreditation has an append-only **ledger** — a collection of transactions. Each transaction is its own document.
- Each transaction carries a `number` that is sequential per accreditation, starting at 1. Uniqueness of `(accreditationId, number)` is enforced by the database, so two writers cannot claim the same slot.
- The **waste balance document** becomes a projection: the running totals (`amount`, `availableAmount`) and the `lastTransactionNumber` it is correct at. No embedded transaction array.

Implemented in new MongoDB collections running alongside the existing `waste-balances`, so the two designs can coexist during cutover — reads fall back to the v1 shape until each accreditation has a v2 projection.

### Transaction shape

Each transaction document keeps almost the same field set as today. The only changes are those the mechanism requires.

**New fields:**

- `accreditationId` — top-level reference; partition key for the ledger (previously implicit in the embedding document).
- `number` — sequential per accreditation, starting at 1.

**Removed fields:**

- `id` (the existing UUID on embedded transactions) — dropped. Nothing outside the waste-balance document references it: the public API exposes only totals, the admin and public frontends do not display it, and audit logs record transaction payloads by value rather than by id lookup. `(accreditationId, number)` becomes the sole business identifier for a transaction.
- `entities[].previousVersionIds[]` — dropped. Version history is available on the waste-records document; duplicating it on every transaction adds no audit value available from source.

**Kept unchanged:**

- `type` (`credit`, `debit`, `pending_debit`)
- `createdAt`, `createdBy`
- `amount` (the delta)
- `openingAmount`, `closingAmount`, `openingAvailableAmount`, `closingAvailableAmount` — running totals recorded per transaction, so every entry is self-auditing (`opening + delta = closing`) without needing to consult its predecessor.
- `entities[]` with `id`, `currentVersionId`, `type`.

Uniqueness of `(accreditationId, number)` is enforced by a compound unique index. That single index also serves the read patterns — "find transactions for this accreditation", "find transaction N", "sort by number" — so one index covers both the optimistic-append lock and the query path. The MongoDB-assigned `_id` remains an auto-generated `ObjectId` used only inside the storage layer.

### Writing a transaction

Every write follows the same steps:

1. Read the current waste balance document. You get the running totals and `lastTransactionNumber`.
2. Compute the change the business event produces.
3. Append a new transaction at `number = lastTransactionNumber + 1`. If the database rejects the insert because another writer has already claimed that number, go back to step 1 and retry.
4. Update the waste balance document to reflect the new transaction, using an optimistic lock on `lastTransactionNumber` — the same optimistic-update pattern already used elsewhere in the backend.

If step 4 fails because another writer has updated the waste balance between reads, no data is lost: the ledger already holds the transaction, and the next reader or writer detects the staleness and catches up.

### Checking freshness and rebuilding

Comparing `wasteBalance.lastTransactionNumber` against the highest `number` in the ledger for that accreditation is a two-integer check. If they match, the projection is current. If it is behind, any reader can reproject by folding the missing transactions into the running totals. The projection is never authoritative; the ledger is. Recovery — rebuilding the projection from the ledger — is a first-class operation rather than a special case.

## Considered alternatives

**Keep transactions embedded, manage growth via archival or pruning.** Defers the size problem rather than removing it. The projection stays coupled to a bounded-capacity document, and the ledger cannot safely be the authoritative source of truth under concurrent writes. Rejected — we'd be revisiting the same decision when the ceiling returns, and it doesn't unlock a return to ledger-derived balance calculation.

**Keep the current workaround: derive balance from waste records and leave the ledger largely unused.** Works in the short term but waste records are not the natural source of truth for a balance that is moved by both summary-log uploads and PRN operations. Rejected because it freezes the current ledger into an artefact of history rather than a durable source of truth.

**Keep the existing UUID `id` on transactions alongside the sequential `number`.** Carrying two identifiers for the same transaction creates a second surface area — any future caller has to choose which to use, and both have to stay in sync. Since `(accreditationId, number)` is already unique by construction and is what every read and write needs to use, a separate UUID adds no capability. Rejected.

**Use a compound `_id: { accreditationId, number }` instead of flat fields plus a compound unique index.** The composite would give uniqueness for free from the primary key, at a saving of 24 bytes per document. Rejected because every query would have to reach through dotted paths (`{ '_id.accreditationId': ... }`), which is visually noisier and less obvious to readers than top-level fields. The extra ObjectId is cheap; the query ergonomics are not.

## Consequences

### Positive

- **Removes the scale limit.** Transactions live in their own collection, with an index on `(accreditationId, number)`. The 16MB document ceiling no longer applies per accreditation. Dropping `previousVersionIds[]` removes the per-entity unbounded-growth multiplier as well.
- **Restores the ledger as the source of truth.** Balance calculation can return to being derived from the transaction history (the LLD's original design). This in turn allows the [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) workaround in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) to be revisited once correct keying is in place.
- **Uses a well-established bookkeeping pattern.** Append-only ledger + sequential numbering per aggregate + materialised projection is the standard design in double-entry accounting, event-sourced systems, and financial ledgers.
- **The projection is rebuildable.** If the waste balance document is damaged, out of date, or missing, it can be reprojected from the ledger. Recovery is a first-class operation.
- **Cheap freshness check.** Comparing two integers (`lastTransactionNumber` vs the ledger's max) tells any reader whether they're looking at fresh or stale totals.
- **The waste balance document shrinks** to running totals plus one integer — cheap to read, cheap to update, bounded in size forever.

### Negative

- Requires new collections and a cutover path. Readers must handle both v1 and v2 during transition.
- PRN write paths move from updating the embedded transactions array to appending to the ledger collection via the shared optimistic-write mechanism. The transaction shape itself is unchanged but the mechanism is, so the migration is not purely additive on top of v1.
- Anyone reading a v2 transaction in isolation no longer sees the version history on the entity — they must consult the waste-records document to trace prior versions. Any tooling or UI that relied on `previousVersionIds[]` on the ledger must follow the reference instead.
- `summary-log-data-flow.md` needs updating to describe the new storage shape.

## Related

- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — the `amount = sum(credits) - sum(debits)` projection this ADR makes operationally reliable
- [Summary log data flow](../defined/summary-log-data-flow.md) — needs updating alongside this decision
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver for this ADR
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — separate correctness fix, currently workaround-fixed in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091); returning to ledger-derived balance calculation (which this ADR enables) is the longer-term fix
