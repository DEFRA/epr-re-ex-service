# 31. Waste balance transaction ledger

Date: 2026-04-21

## Status

Proposed

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

Implemented as a new MongoDB ledger collection. The existing `waste-balances` collection remains in place during cutover; reads fall back to it until each accreditation has been transitioned to the ledger.

### Transaction shape

Each transaction document keeps almost the same field set as today. The only changes are those the mechanism requires.

**New fields:**

- `accreditationId` — top-level reference; partition key for the ledger (previously implicit in the embedding document).
- `organisationId`, `registrationId` — denormalised onto each transaction. Organisation-level and registration-level queries (e.g. `GET /v1/organisations/{id}/waste-balances`) then resolve with a single indexed lookup rather than requiring a join from accreditation back to its parents. Both values are immutable for the lifetime of an accreditation, so the denormalisation is safe.
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

1. Read the latest transaction for the accreditation — one indexed read (`find({accreditationId}).sort({number: -1}).limit(1)`). You get its `number` and its closing totals. If no transactions exist yet, start from `number = 0` and zero totals.
2. Compute the change the business event produces.
3. Insert a new transaction at `number = latestNumber + 1` with the updated closing totals. If the database rejects the insert because another writer has already claimed that number, go back to step 1 and retry.

The unique index on `(accreditationId, number)` is the only enforcement point for concurrency. There is no second document to update and no second optimistic-lock surface.

### Reading the current balance

The current balance for an accreditation is the `closingAmount` and `closingAvailableAmount` on its highest-numbered transaction — a single indexed read. If no transactions exist, the balance is zero.

No cached projection exists, so there is no staleness to check and no reconciliation path to maintain. The ledger is the authoritative and sole store of balance state.

## Considered alternatives

**Keep transactions embedded, manage growth via archival or pruning.** Defers the size problem rather than removing it. The projection stays coupled to a bounded-capacity document, and the ledger cannot safely be the authoritative source of truth under concurrent writes. Rejected — we'd be revisiting the same decision when the ceiling returns, and it doesn't unlock a return to ledger-derived balance calculation.

**Keep the current workaround: derive balance from waste records and leave the ledger largely unused.** Works in the short term but waste records are not the natural source of truth for a balance that is moved by both summary-log uploads and PRN operations. Rejected because it freezes the current ledger into an artefact of history rather than a durable source of truth.

**Keep the existing UUID `id` on transactions alongside the sequential `number`.** Carrying two identifiers for the same transaction creates a second surface area — any future caller has to choose which to use, and both have to stay in sync. Since `(accreditationId, number)` is already unique by construction and is what every read and write needs to use, a separate UUID adds no capability. Rejected.

**Use a compound `_id: { accreditationId, number }` instead of flat fields plus a compound unique index.** The composite would give uniqueness for free from the primary key, at a saving of 24 bytes per document. Rejected because every query would have to reach through dotted paths (`{ '_id.accreditationId': ... }`), which is visually noisier and less obvious to readers than top-level fields. The extra ObjectId is cheap; the query ergonomics are not.

**Keep a materialised projection document alongside the ledger.** Maintain the waste balance as a separate document carrying `amount`, `availableAmount`, and `lastTransactionNumber`, updated after each ledger append under an optimistic lock, rebuildable from the ledger on demand. Rejected because every transaction already carries its own closing totals, so the current balance is available in a single indexed read on the latest transaction — the projection would cache information already cheap to derive. Maintaining it introduces a second optimistic-concurrency surface, creates stale-cache and projection-repair states that otherwise do not exist, and doubles the collection count to migrate and reason about, for no measurable query benefit.

## Consequences

### Positive

- **Removes the scale limit.** Transactions live in their own collection, with an index on `(accreditationId, number)`. The 16MB document ceiling no longer applies per accreditation. Dropping `previousVersionIds[]` removes the per-entity unbounded-growth multiplier as well.
- **Makes the ledger the authoritative and sole store of balance state.** Balance calculation returns to being derived from the transaction history (the LLD's original design). This in turn allows the [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) workaround in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) to be revisited once correct keying is in place.
- **Uses a well-established bookkeeping pattern.** Append-only ledger + sequential numbering per aggregate is the standard design in double-entry accounting, event-sourced systems, and financial ledgers. Carrying the running totals on each entry is the standard trick for making any entry self-auditing against its predecessor (`opening + delta = closing`).
- **No cached state to maintain.** There is no separate projection document that can go stale, get corrupted, or need repair — so the failure modes associated with maintaining one simply do not exist.
- **Single write mechanism.** Summary-log row writes and PRN operations both append to the same ledger through the same optimistic-append path — no separate code to update a projection, no second concurrency surface.
- **Constant-cost balance reads.** The current balance for an accreditation is a single indexed read on the latest transaction — O(1) via the `(accreditationId, number)` index. Organisation-level and registration-level queries resolve with a single-pass aggregation against denormalised `organisationId` / `registrationId` fields on each transaction.

### Negative

- Requires a new collection and a cutover path. Readers must handle both v1 (balance on the waste-balance document) and v2 (balance derived from the ledger's latest transaction) during the transition.
- PRN write paths move from updating the embedded transactions array to appending to the ledger collection via the shared optimistic-write mechanism. The transaction shape itself is nearly unchanged but the mechanism is, so the migration is not purely additive on top of v1.
- Anyone reading a v2 transaction in isolation no longer sees the version history on the entity — they must consult the waste-records document to trace prior versions. Any tooling or UI that relied on `previousVersionIds[]` on the ledger must follow the reference instead.
- Organisation-level and registration-level balance queries rely on `organisationId` and `registrationId` being denormalised onto every transaction. These values are immutable for the lifetime of an accreditation, so the denormalisation is safe, but each transaction document is a few dozen bytes larger than strictly necessary.
- `summary-log-data-flow.md` needs updating to describe the new storage shape.

## Related

- [Waste balance LLD](../defined/pepr-lld.md#waste-balance) — the `amount = sum(credits) - sum(debits)` projection this ADR makes operationally reliable
- [Summary log data flow](../defined/summary-log-data-flow.md) — needs updating alongside this decision
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver for this ADR
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) — separate correctness fix, currently workaround-fixed in [DEFRA/epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091); returning to ledger-derived balance calculation (which this ADR enables) is the longer-term fix
