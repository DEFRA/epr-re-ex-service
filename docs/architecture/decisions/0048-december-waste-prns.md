# 48. December-waste PRNs via an additive waste-balance dimension

## Status

Proposed. Extends [ADR-0036](./0036-event-sourced-waste-balance-stream.md).

## Context

PRNs are to gain an `isDecemberWaste` flag. A December-waste PRN is more valuable, so an operator must not be able to simply tick a box to upgrade one — the claim has to be validated against what they actually processed in December. "December waste" denotes a PRN raised exclusively for re-ex operations conducted in December, which is determinable from the summary log: each waste-record row carries a controlling date (`DATE_LOAD_LEFT_SITE` for reprocessors, `DATE_OF_EXPORT` for exporters, resolved per processing type by `reporting-date-fields.js`).

The `isDecemberWaste` field already exists on the PRN document, required, currently hard-coded `false`, and surfaced in every read response — but nothing sets or validates it, and it is not on the create payload.

The validation the business needs is a cap:

- An operator cannot raise December PRNs for more than they processed in December.
- The cap nets off December PRNs already raised.
- The cap nets off December PRNs that have been cancelled — reversals must restore December capacity.
- December and non-December are **separate pools**: a non-December PRN checks a non-December balance, a December PRN checks a December balance. December tonnage is effectively reserved from ordinary PRNs.

A further constraint shaped the decision: we want to avoid maintaining two separate ledgers with two concurrency guards.

[ADR-0036](./0036-event-sourced-waste-balance-stream.md) established the substrate this builds on. The waste balance is an event-sourced stream partitioned by `(registrationId, accreditationId)`; each event carries a `closingBalance` of `{ amount, availableAmount }`; a `summary-log-submitted` event carries a frozen `creditTotal` snapshot and applies `delta = creditTotal − previousCreditTotal` to both fields; PRN transitions map to `prn-created` / `prn-issued` / `prn-creation-cancelled` / `prn-cancelled-after-issue` / `prn-accepted` / `prn-rejected`; the balance is the `closingBalance` of the latest event, read once; a compound unique index on `(registrationId, accreditationId, number)` is the single optimistic-concurrency surface. This ADR fixes only the December extension to that model.

## Decision

Extend the existing stream with an **additive** December dimension, rather than a second ledger or a just-in-time query.

### Additive fields, total stays total

`closingBalance` keeps its existing fields meaning exactly what they mean today — the total across both pools — and gains a precisely-named December portion alongside:

```
closingBalance: {
  amount,                     // unchanged — total (december + nonDecember)
  availableAmount,            // unchanged — total
  decemberAmount,             // new, optional — december portion of amount
  decemberAvailableAmount     // new, optional — december portion of availableAmount
}
```

`nonDecember` is never stored — it is derived: `amount − decemberAmount`, `availableAmount − decemberAvailableAmount`. One dimension is added, not two.

Every existing arithmetic rule from ADR-0036 stays byte-for-byte the same — the rules keep moving `amount` and `availableAmount` as the total. A thin December layer is added on top, keyed off the event's dimension:

- PRN events gain a `dimension: 'december' | 'nonDecember'`, copied from the PRN's `isDecemberWaste`. December-tagged events additionally move `decemberAmount` / `decemberAvailableAmount` by the same delta they already apply to the total; non-December events touch only the total fields. Reversals read the same tag, so a cancelled December PRN credits the December fields — restoring December capacity. Storing the dimension on the event (rather than re-reading the PRN) keeps each event self-contained and replay-safe, consistent with ADR-0036's actor-vs-cause principle.
- `summary-log-submitted` keeps `creditTotal` (the full sum, crediting the total fields as today) and gains one additive payload field, `decemberCreditTotal`, computed by bucketing INCLUDED rows on their controlling date — December of the accreditation year to the December bucket, everything else to neither. The close rule applies the unchanged total delta plus a December delta (`current − previous`, previous absent treated as 0), so resubmissions that move tonnage in or out of December self-correct through the same machinery ADR-0036 already relies on.

### The checks

The write-side deciders take the PRN's `isDecemberWaste`:

- **December PRN.** `prn-created` requires `decemberAvailableAmount ≥ tonnage`; `prn-issued` requires `decemberAmount ≥ tonnage`. Insufficiency surfaces as a distinct rejection (`INSUFFICIENT_DECEMBER_AVAILABLE_BALANCE` / `INSUFFICIENT_DECEMBER_TOTAL_BALANCE`, 409), kept separate from the ordinary insufficiency so the frontend can message "not enough December-processed tonnage". The total check still runs and is automatically satisfied, since `decemberAvailableAmount ≤ availableAmount`.
- **Non-December PRN.** Checks the derived nonDecember figures (`availableAmount − decemberAvailableAmount`, and the amount equivalent).

Because the December debit rides the same event append and the same slot-conflict guard as the total, December overspend is impossible by construction and atomic with the total check — the property ADR-0036 built the single concurrency surface to guarantee, inherited for free.

### Which December

Accreditations are valid for a single calendar year, so "December" is unambiguous — the December of the accreditation year. The only per-type detail is which date field marks a row as December, and that reuses the existing `reporting-date-fields.js` resolver.

### Scope

PRNs require a non-null `accreditationId`; registered-only streams (`accreditationId: null`) raise no PRNs. December-waste therefore touches only accredited reprocessors and exporters, and the registered-only month-only date fields are out of scope.

### Migration and enforcement — lazy and self-gating

The system was not live last December, and no summary log can carry a December-dated load until December. Every existing ledger's December portion is therefore exactly zero — there is no tonnage to attribute and the derived nonDecember cannot go negative. So:

- The two December fields are added as optional; read and close paths default absent to 0.
- New events carry the fields; the first December-bearing summary log populates them via the ordinary `current − previous` delta.
- **No batch backfill** — existing ledgers are already "zero December", which is the truth.
- **No feature flag** — enforcement self-gates. A December PRN checks `decemberAvailableAmount`, which stays 0 until real December tonnage lands, so December PRNs are correctly impossible before December. A non-December check is `availableAmount − 0 = availableAmount`, byte-for-byte today's behaviour until then.

## Considered alternatives

**Pure just-in-time check at raise time.** On a December raise, sum the transaction amounts of INCLUDED rows whose controlling date is in December, net off active December PRNs, and reject if the raise exceeds the remainder — with no persisted December state. Rejected: it sidesteps the stream's optimistic-concurrency guard (two concurrent December raises could both pass and overspend the December cap — precisely the class of double-debit ADR-0036 exists to prevent, reintroduced for the more valuable PRNs), and it re-queries rows on every raise instead of reading the balance once.

**A separate December ledger partition.** A second event-sourced stream keyed to isolate December. Rejected: it is the two-balances outcome the constraints rule out — duplicate machinery and a second concurrency surface — and the partition key `(registrationId, accreditationId)` does not naturally extend, since `accreditationId` must be a real accreditation. The additive dimension gets the same isolation within the existing single stream.

**Store `nonDecember` explicitly alongside `december`.** Rejected as redundant: with `amount` retained as the total, nonDecember is exactly `total − december` and derivable at no cost. Storing it would add a third and fourth field that must be kept consistent with the total by every write, with no integrity gain.

## Consequences

### Positive

- **One stream, one concurrency surface.** December rides the existing slot-conflict guard; December overspend is impossible by construction and atomic with the total check.
- **Additive and expand-only.** Existing arithmetic is untouched; the total fields keep their meaning. There is nothing to contract away later — `amount` remains the total.
- **Resubmission-correct for free.** December uses the same `current − previous` delta as `creditTotal`, so tonnage moving in or out of December self-corrects.
- **No migration and no flag.** Zero-December is already true of every existing ledger, so enforcement can be live immediately and self-gates until real December tonnage exists.
- **Constant-cost reads unchanged.** The balance is still the latest event's `closingBalance`, now carrying two extra fields.

### Negative

- **A new dimension tag on PRN events.** Every PRN event must carry `dimension`, and the close layer must route on it. The set of kinds is unchanged; only the payload widens.
- **December bucketing at submission time.** The `creditTotal` computation gains a parallel December sum, adding per-row date classification to the write path (bounded by submission size, as `creditTotal` already is).
- **Absent-as-zero defaulting.** Readers of `closingBalance` must treat the December fields as 0 when absent, for the lifetime of pre-dimension events.
- **Retroactive reduction is not unwound.** As with the total balance today, a resubmission that reduces December tonnage below what has already been issued cannot unwind an already-issued December PRN — the cap governs new raises, not settled ones. This is the existing accepted behaviour of the balance, inherited unchanged.

## Out of scope

- **The operator opt-in UX.** How and when the operator consciously chooses the flag is a frontend concern; the backend's contract is to honour and validate `isDecemberWaste` on the create payload.
- **Why December waste is more valuable and how that value is applied downstream.** This ADR fixes only the balance model that keeps the claim honest.
- **The exhaustive PRN transition-to-event mapping.** Owned by the write-side decider in `epr-backend` and the waste balance LLD, per ADR-0036.

## Related

- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — the event-sourced waste balance stream this extends
- [ADR-0031](./0031-waste-balance-transaction-ledger.md) — the per-row transaction ledger ADR-0036 superseded
- [ADR-0024](./0024-create-prn-api-strategy.md) — Create PRN API strategy
- [ADR-0034](./0034-multi-year-accreditation-model.md) — accreditation validity model (single calendar year, which fixes "which December")
- Bead `defra-3w6c` — the design record behind this ADR
- PAE-000 — placeholder Jira reference (to be assigned)
