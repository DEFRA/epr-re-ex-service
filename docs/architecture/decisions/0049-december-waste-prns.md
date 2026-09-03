# 49. December-waste PRNs via an additive waste-balance dimension

## Status

Accepted. Extends [ADR-0036](./0036-event-sourced-waste-balance-stream.md).

## Context

PRNs (and the exporter equivalent, PERNs) are to gain an `isDecemberWaste` flag. The driver is a statutory disclosure duty. Under the Producer Responsibility Obligations (Packaging and Packaging Waste) Regulations 2024 (SI 2024/1332, Schedule 8), a reprocessor "must ensure that any PRN it issues which relates to packaging waste received for recycling in December of a year specifies that fact" (para 24(4)); an exporter carries the equivalent duty for waste "received at an overseas reprocessing site for recycling in December" (para 27(3)). To discharge that duty the system must determine, per note, whether it relates to December-received waste — and must not let a note be tagged December for tonnage that was not received in December, since the flag would then misstate the fact the statute requires it to state. (December-tagged evidence is also commercially more valuable, which is the incentive to over-tag; but the load-bearing requirement here is the labelling duty, not the value.) "December waste" is therefore determinable from the summary log: every row that affects the balance already does so on a specific date fixed by the accreditation's processing type, and December membership is read from that same date (see "Which December" below).

The `isDecemberWaste` field already exists on the PRN document, required, currently hard-coded `false`, and surfaced in every read response — but nothing sets or validates it, and it is not on the create payload.

The validation the business needs is a cap:

- An operator cannot raise December PRNs for more than they processed in December.
- The cap nets off December PRNs already raised.
- The cap nets off December PRNs that have been cancelled — reversals must restore December capacity.
- December and non-December are **separate pools**: a non-December PRN checks a non-December balance, a December PRN checks a December balance. December tonnage is effectively reserved from ordinary PRNs.

These caps are the mechanism we choose, not a shape the SI mandates: the Regulations impose truthfulness per note and per load (paras 24(1), 25, and the no-double-issuance condition at para 31(d)), not an aggregate December ceiling. The cap enforces that per-note truthfulness across a pooled balance.

A further constraint shaped the decision: we want to avoid maintaining two separate ledgers with two concurrency guards.

[ADR-0036](./0036-event-sourced-waste-balance-stream.md) established the substrate this builds on; the full model lives there. This ADR depends on four load-bearing facts from it, and fixes only the December extension: the balance is the `closingBalance` of the latest event, read once; a compound unique index on `(registrationId, accreditationId, number)` is the single optimistic-concurrency surface; a `summary-log-submitted` event carries a frozen `creditTotal` snapshot and applies `delta = creditTotal − previousCreditTotal`; and a PRN transition appends one balance-affecting event.

## Decision

Extend the existing stream with an **additive** December dimension, rather than a second ledger or a just-in-time query.

### Declared at raise time, not derived

The December duty runs in both directions: paras 24(4)/27(3) require the marker on any note relating to December-received waste, and under reg 117(4) omitting a true marker is an offence just as asserting a false one is (reg 117(3)(c)). A flag the operator may freely decline is therefore not safe.

The system still cannot derive the flag per note, because a PRN is not bound to specific summary-log loads: it draws tonnage from an aggregate pool, so "does this note relate to December waste?" is an allocation question rather than a lookup. Per-note derivation presumes a per-load evidence model; the pooled balance this ADR extends does not carry that binding.

What the model does guarantee is that the aggregate declaration stays truthful in both directions. The cap makes over-declaration impossible by construction; the explicit December pool lets the frontend require a December declaration whenever December-attributable capacity is being drawn, rather than leave it to free choice, which is how the omission direction (reg 117(4)) is discharged. The backend's contract is to honour and validate `isDecemberWaste` on the create payload and to keep both pools honest; requiring declaration when December capacity is spent is the frontend contract on top of it.

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

Every existing arithmetic rule from ADR-0036 stays byte-for-byte the same — the rules keep moving `amount` and `availableAmount` as the total. A thin December layer is added on top, keyed off the PRN's `isDecemberWaste` flag carried on the event:

- PRN events carry the PRN's `isDecemberWaste` flag directly — no separate `dimension` tag is introduced. For exporter and reprocessor-input accreditations the event takes the PRN's flag as-is; a reprocessor-output PRN's event always carries `isDecemberWaste: false`, whatever the PRN self-declares, because output accreditations accrue no December capacity (see Scope). December-flagged events additionally move `decemberAmount` / `decemberAvailableAmount` by the same delta they already apply to the total; non-December events touch only the total fields. Reversals read the same flag, so a cancelled December PRN credits the December fields — restoring December capacity. Snapshotting `isDecemberWaste` onto the event (rather than re-reading the PRN) keeps each event self-contained and replay-safe, consistent with ADR-0036's actor-vs-cause principle.
- `summary-log-submitted` keeps `creditTotal` (the full sum, crediting the total fields as today) and gains one additive payload field, `decemberCreditTotal`. It is computed by the **same rule that already computes `creditTotal`** (the `contributionFor` / `creditedTonnageByMonth` resolution in `credited-tonnage.js`: which rows credit or deduct, the tonnage column, and the balance-affecting date), restricted to the rows whose balance-affecting date falls in December, **and only for exporter and reprocessor-input accreditations** (a reprocessor-output accreditation accrues no `decemberCreditTotal` — see Scope). Because `decemberCreditTotal` is that same computation narrowed by date, it is by construction a subset (net of December deductions) of `creditTotal`, so the December figures never exceed the total in the ordinary course. Concretely, `decemberCreditTotal` is the `${accreditationYear}-12` month bucket that `creditedTonnageByMonth` already emits. Classification must reuse that resolver, **not** `reporting-date-fields.js`, which serves report-section periods and can name two dates for one exporter row. This is a legal requirement, not only a mechanical one: for exporters the resolver buckets on `DATE_RECEIVED_BY_OSR` — the date received at the overseas reprocessing site — which is precisely the date para 27(3) keys the December duty on. `reporting-date-fields.js` would offer `DATE_OF_EXPORT`, the export-date test of the predecessor 2005/2007 regime, which is the _wrong_ trigger for December under the 2024 Regs. The close rule applies the unchanged total delta plus a December delta (`current − previous`, previous absent treated as 0), so resubmissions that move tonnage in or out of December self-correct through the same machinery ADR-0036 already relies on.

### The checks

The write-side deciders take the PRN's `isDecemberWaste` and check **only the pool that PRN draws on** — each dimension is guarded on its own field, and the total is never itself a raise-gate:

- **December PRN.** `prn-created` requires `decemberAvailableAmount ≥ tonnage`; `prn-issued` requires `decemberAmount ≥ tonnage`. The total is **not** additionally checked. The total is only the sum of the two pools, and a December PRN backed by genuine December-processed tonnage must not be refused because the _non-December_ dimension has been driven negative: a resubmission cutting non-December credit below what non-December PRNs already drew can make `availableAmount < decemberAvailableAmount`, and a concurrent total check would then reject a December PRN the December pool fully backs. Bounding the December PRN by the December field alone avoids that, and is symmetric with how a non-December PRN is bounded.
- **Non-December PRN.** Checks the derived nonDecember figures (`availableAmount − decemberAvailableAmount`, and the amount equivalent).

Because each dimension is guarded on its own field, a refused raise has one unambiguous cause — the pool it drew on — which the frontend already knows. Whether that insufficiency is surfaced as a dedicated rejection code or the existing insufficiency rejection carrying the pool context is a write-side implementation detail, not fixed here.

Because the December debit rides the same event append and the same slot-conflict guard as the total, December overspend is impossible by construction and atomic — the property ADR-0036 built the single concurrency surface to guarantee, inherited for free.

### Which December

"December" means the calendar month December (month 12) of the PRN's `accreditationYear`, matched against each row's balance-affecting date. That date is exactly the one `credited-tonnage.js` already buckets on, and `creditedTonnageByMonth` already keys its buckets by calendar month via `monthKeyForDate`, so the December bucket is `${accreditationYear}-12` with no separate date resolver to introduce. This assumes an accreditation's validity does not span a second, non-target-year December; the accreditation validity model ([ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md)) governs those dates, and the implementation should confirm that assumption against it rather than treat it as self-evident.

### Negative balances

Any dimension — December, the derived non-December, or the total — can go transiently negative. This is not new and is not troublesome: it is exactly the behaviour the total balance already has under ADR-0036. A PRN is issued against a frozen `creditTotal` snapshot; a later resubmission that reduces the relevant credit below what has already been issued drives that dimension's closing figure negative. The additive December dimension inherits this property unchanged. The `≥ tonnage` checks handle it correctly by construction: a dimension whose available figure is negative admits no further raises (every `tonnage` is at least 1), and capacity returns as later credit does. There is deliberately no clamp — clamping would lose the true arithmetic the `current − previous` delta depends on.

### Scope

PRNs require a non-null `accreditationId`; registered-only streams (`accreditationId: null`) raise no PRNs. December-waste therefore touches only accredited reprocessors and exporters, and the registered-only month-only date fields are out of scope.

**Reprocessors issuing on output are outside the December dimension.** A reprocessor-output accreditation credits its balance from _processed_ rows, whose balance-affecting date is the date the load left site (`DATE_LOAD_LEFT_SITE`) — not a date the waste was _received for recycling_, which is the trigger paras 24(4)/27(3) key the December duty on. So an output accreditation accrues **no** `decemberCreditTotal`, and an output PRN's balance event always carries `isDecemberWaste: false` regardless of the PRN's self-declared flag. Output reprocessors still self-declare `isDecemberWaste` for the statutory disclosure, but here that flag is disclosure-only — it never accrues, reserves or debits a December balance, and their single balance is unchanged. The December dimension — the credit narrowing, the event flag and the checks above — therefore applies only to exporter and reprocessor-input accreditations.

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

- **One stream, one concurrency surface.** December rides the existing slot-conflict guard; December overspend is impossible by construction and atomic, each dimension guarded on its own field.
- **Additive and expand-only.** Existing arithmetic is untouched; the total fields keep their meaning. There is nothing to contract away later — `amount` remains the total.
- **Resubmission-correct for free.** December uses the same `current − previous` delta as `creditTotal`, so tonnage moving in or out of December self-corrects.
- **No migration and no flag.** Zero-December is already true of every existing ledger, so enforcement can be live immediately and self-gates until real December tonnage exists.
- **Constant-cost reads unchanged.** The balance is still the latest event's `closingBalance`, now carrying two extra fields.

### Negative

- **The `isDecemberWaste` flag on PRN events.** Every PRN balance event must carry `isDecemberWaste`, and the close layer must route on it. The set of kinds is unchanged; only the payload widens.
- **December bucketing at submission time.** The `creditTotal` computation gains a parallel December sum, adding per-row date classification to the write path (bounded by submission size, as `creditTotal` already is).
- **Absent-as-zero defaulting.** Readers of `closingBalance` must treat the December fields as 0 when absent, for the lifetime of events written before the December fields existed.
- **Retroactive reduction is not unwound, and dimensions can go negative.** As with the total balance today, a resubmission that reduces December tonnage below what has already been issued cannot unwind an already-issued December PRN — the cap governs new raises, not settled ones — and can drive that dimension (or the derived non-December, or the total) transiently negative. This is the existing accepted behaviour of the balance, inherited unchanged; see "Negative balances". The `≥ tonnage` checks stay correct throughout, so no clamp or reconciliation is added.

## Out of scope

- **The frontend declaration flow.** How the operator is prompted to declare December (including requiring it when December-attributable capacity is being drawn, per "Declared at raise time, not derived") is a frontend concern; the backend's contract is to honour and validate `isDecemberWaste` on the create payload.
- **How December-tagged evidence is treated downstream, and why it is more valuable.** The statutory driver for this ADR is the para 24(4)/27(3) labelling duty; how the December flag is consumed or priced downstream is out of scope. This ADR fixes only the balance model that keeps the flag honest.
- **The exhaustive PRN transition-to-event mapping.** Owned by the write-side decider in `epr-backend` and the waste balance LLD, per ADR-0036.

## Related

- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — the event-sourced waste balance stream this extends
- [ADR-0031](./0031-waste-balance-transaction-ledger.md) — the per-row transaction ledger ADR-0036 superseded
- [ADR-0024](./0024-create-prn-api-strategy.md) — Create PRN API strategy
- [ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md) — accreditation validity and status rules (governs the dates behind "which December")
- [ADR-0034](./0034-multi-year-accreditation-model.md) — multi-year accreditation model (year derived from `validFrom`; source of the PRN's `accreditationYear`)
- [SI 2024/1332, Schedule 8](https://www.legislation.gov.uk/ukdsi/2024/9780348264654/schedule/8) — the statutory December-labelling duty: para 24(4) (reprocessors, keyed on receipt for recycling) and para 27(3) (exporters, keyed on receipt at the overseas reprocessing site). Predecessor wording: [SI 2005/3468, Schedule 5](https://www.legislation.gov.uk/uksi/2005/3468/schedule/5/made).
- Bead `defra-3w6c` — the design record behind this ADR
- PAE-000 — placeholder Jira reference (to be assigned)
