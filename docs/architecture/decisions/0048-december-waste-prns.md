# 48. December-waste PRNs via an additive waste-balance dimension

## Status

Proposed. Extends [ADR-0036](./0036-event-sourced-waste-balance-stream.md).

## Context

PRNs are to gain an `isDecemberWaste` flag. A December-waste PRN is more valuable, so an operator must not be able to simply tick a box to upgrade one — the claim has to be validated against what they actually processed in December. "December waste" denotes a PRN raised exclusively for re-ex operations conducted in December, which is determinable from the summary log: every row that affects the balance already does so on a specific date fixed by the accreditation's processing type, and December membership is read from that same date (see "Which December" below).

The `isDecemberWaste` field already exists on the PRN document, required, currently hard-coded `false`, and surfaced in every read response — but nothing sets or validates it, and it is not on the create payload.

The validation the business needs is a cap:

- An operator cannot raise December PRNs for more than they processed in December.
- The cap nets off December PRNs already raised.
- The cap nets off December PRNs that have been cancelled — reversals must restore December capacity.
- December and non-December are **separate pools**: a non-December PRN checks a non-December balance, a December PRN checks a December balance. December tonnage is effectively reserved from ordinary PRNs.

A further constraint shaped the decision: we want to avoid maintaining two separate ledgers with two concurrency guards.

[ADR-0036](./0036-event-sourced-waste-balance-stream.md) established the substrate this builds on; the full model lives there. This ADR depends on four load-bearing facts from it, and fixes only the December extension: the balance is the `closingBalance` of the latest event, read once; a compound unique index on `(registrationId, accreditationId, number)` is the single optimistic-concurrency surface; a `summary-log-submitted` event carries a frozen `creditTotal` snapshot and applies `delta = creditTotal − previousCreditTotal`; and a PRN transition appends one balance-affecting event.

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
- `summary-log-submitted` keeps `creditTotal` (the full sum, crediting the total fields as today) and gains one additive payload field, `decemberCreditTotal`. It is computed by the **same rule that already computes `creditTotal`** (the `contributionFor` / `creditedTonnageByMonth` resolution in `credited-tonnage.js`: which rows credit or deduct, the tonnage column, and the balance-affecting date), restricted to the rows whose balance-affecting date falls in December. Because `decemberCreditTotal` is that same computation narrowed by date, it is by construction a subset (net of December deductions) of `creditTotal`, so the December figures never exceed the total in the ordinary course. Concretely, `decemberCreditTotal` is the `${accreditationYear}-12` month bucket that `creditedTonnageByMonth` already emits. Classification must reuse that resolver, **not** `reporting-date-fields.js`, which serves report-section periods and can name two dates for one exporter row. The close rule applies the unchanged total delta plus a December delta (`current − previous`, previous absent treated as 0), so resubmissions that move tonnage in or out of December self-correct through the same machinery ADR-0036 already relies on.

### The checks

The write-side deciders take the PRN's `isDecemberWaste`:

- **December PRN.** `prn-created` requires `decemberAvailableAmount ≥ tonnage`; `prn-issued` requires `decemberAmount ≥ tonnage`. Insufficiency surfaces as a distinct rejection (`INSUFFICIENT_DECEMBER_AVAILABLE_BALANCE` / `INSUFFICIENT_DECEMBER_TOTAL_BALANCE`, 409), kept separate from the ordinary insufficiency so the frontend can message "not enough December-processed tonnage". The total check also runs, independently; in the ordinary course `decemberAvailableAmount ≤ availableAmount` so the total is not the binding constraint for a December PRN, but neither dimension is assumed to dominate the other (see "Negative balances" below), so both checks are enforced on their own field.
- **Non-December PRN.** Checks the derived nonDecember figures (`availableAmount − decemberAvailableAmount`, and the amount equivalent).

Because the December debit rides the same event append and the same slot-conflict guard as the total, December overspend is impossible by construction and atomic with the total check — the property ADR-0036 built the single concurrency surface to guarantee, inherited for free.

### Which December

"December" means the calendar month December (month 12) of the PRN's `accreditationYear`, matched against each row's balance-affecting date. That date is exactly the one `credited-tonnage.js` already buckets on, and `creditedTonnageByMonth` already keys its buckets by calendar month via `monthKeyForDate`, so the December bucket is `${accreditationYear}-12` with no separate date resolver to introduce. This assumes an accreditation's validity does not span a second, non-target-year December; the accreditation validity model ([ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md)) governs those dates, and the implementation should confirm that assumption against it rather than treat it as self-evident.

### Negative balances

Any dimension — December, the derived non-December, or the total — can go transiently negative. This is not new and is not troublesome: it is exactly the behaviour the total balance already has under ADR-0036. A PRN is issued against a frozen `creditTotal` snapshot; a later resubmission that reduces the relevant credit below what has already been issued drives that dimension's closing figure negative. The additive December dimension inherits this property unchanged. The `≥ tonnage` checks handle it correctly by construction: a dimension whose available figure is negative admits no further raises (every `tonnage` is at least 1), and capacity returns as later credit does. There is deliberately no clamp — clamping would lose the true arithmetic the `current − previous` delta depends on.

### Scope

PRNs require a non-null `accreditationId`; registered-only streams (`accreditationId: null`) raise no PRNs. December-waste therefore touches only accredited reprocessors and exporters, and the registered-only month-only date fields are out of scope.

### Migration and enforcement — lazy and self-gating

The system was not live last December, and no summary log can carry a December-dated load until December. Every existing ledger's December portion is therefore exactly zero — there is nothing to attribute, so the split needs no backfill. So:

- The two December fields are added as optional; read and close paths default absent to 0.
- New events carry the fields; the first December-bearing summary log populates them via the ordinary `current − previous` delta.
- **No batch backfill** — existing ledgers are already "zero December", which is the truth.
- **No feature flag** — enforcement self-gates. A December PRN checks `decemberAvailableAmount`, which stays 0 until real December tonnage lands, so December PRNs are correctly impossible before December. A non-December check is `availableAmount − 0 = availableAmount`, byte-for-byte today's behaviour until then.

**Ordering constraint.** Because the go-live is implicit (the first December-dated row, whenever it arrives), the create-payload `isDecemberWaste` field and its validation must be shipped **before** the first December summary log can be accepted. If a December-dated row lands while nothing tags PRNs as December, the "impossible by construction" guarantee is vacuous: every PRN defaults to the non-December pool and the separation silently does not happen. The implementation must treat "December tonnage can enter the system" and "PRNs can be tagged December" as a single release gate, not two independent ones.

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
- **Retroactive reduction is not unwound, and dimensions can go negative.** As with the total balance today, a resubmission that reduces December tonnage below what has already been issued cannot unwind an already-issued December PRN — the cap governs new raises, not settled ones — and can drive that dimension (or the derived non-December, or the total) transiently negative. This is the existing accepted behaviour of the balance, inherited unchanged; see "Negative balances". The `≥ tonnage` checks stay correct throughout, so no clamp or reconciliation is added.

## Out of scope

- **The operator opt-in UX.** How and when the operator consciously chooses the flag is a frontend concern; the backend's contract is to honour and validate `isDecemberWaste` on the create payload.
- **Why December waste is more valuable and how that value is applied downstream.** This ADR fixes only the balance model that keeps the claim honest.
- **The exhaustive PRN transition-to-event mapping.** Owned by the write-side decider in `epr-backend` and the waste balance LLD, per ADR-0036.

## Related

- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — the event-sourced waste balance stream this extends
- [ADR-0031](./0031-waste-balance-transaction-ledger.md) — the per-row transaction ledger ADR-0036 superseded
- [ADR-0024](./0024-create-prn-api-strategy.md) — Create PRN API strategy
- [ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md) — accreditation validity and status rules (governs the dates behind "which December")
- [ADR-0034](./0034-multi-year-accreditation-model.md) — multi-year accreditation model (year derived from `validFrom`; source of the PRN's `accreditationYear`)
- Bead `defra-3w6c` — the design record behind this ADR
- PAE-000 — placeholder Jira reference (to be assigned)
