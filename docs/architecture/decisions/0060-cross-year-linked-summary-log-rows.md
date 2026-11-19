# 60. Cross-year linked summary-log rows

Date: 2026-11-19

## Status

Proposed. Amends [ADR-0048](./0048-dual-multi-year-summary-logs.md): a later year's validation may read an earlier year's submitted row states. Nothing is written across a year boundary.

| ADR                                                                   | Title                                                 | Relationship                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [0048](0048-dual-multi-year-summary-logs.md)                          | Dual and multi-year summary logs                      | Amends: Part 1's "no carry-over across a year boundary" gains one exception, a read at validation.           |
| [0058](0058-validation-writes-summary-log-row-states.md)              | Validation writes summary-log row states              | Amends: linked rows are filled in once, at validation, and the context gains the previous year's position.   |
| [0037](0037-summary-log-row-states-with-membership.md)                | Summary-log row states with membership                | Extends: `data` keeps its meaning; a linked row state also records where its values came from.               |
| [0059](0059-waste-records-exports-carry-template-declared-columns.md) | Waste-records exports carry template-declared columns | Constrains: the link sits beside `data`, not in it, so it never reaches the exports as an undeclared column. |

## Context

An accredited exporter can export a load in one year that is received overseas in the next. Under ADR-0048 each year has its own summary log, row states and waste balance, so a load exported in 2026 and received overseas in 2027 counts in neither: it is outside the 2026 accreditation because it was received overseas in 2027, and outside the 2027 accreditation because it was exported in 2026.

The business chose to resolve this by letting the operator link the two years explicitly ([PAE-2012](https://eaflood.atlassian.net/browse/PAE-2012)). From 2027 the accredited exporter's received-loads table and the registered-only exporter's loads-exported table each have a previous-year row ID column (`PREVIOUS_YEAR_ROW_ID`). A 2027 row that names a 2026 row there is a **linked row**. It is not a re-upload of the 2026 row: it holds whatever completion data was missing in 2026, and takes the rest from the 2026 row. The 2027 waste balance and 2027 reports are informed only by 2027 rows, including the values a linked row takes from its 2026 row ([PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282)).

The column is stored today, but nothing reads it. This ADR decides where a linked row takes its 2026 values, what its row state records, how its credit is decided and how the later year stays consistent with the earlier one. ADR-0058 settles the first in principle: validation is the only place rows are built, so that is where a linked row is filled in.

## Decision

### Validation fills in linked rows from the earlier year's submitted row states

Linking applies to a table whose schema declares that it links years, not to any table that happens to carry a previous-year row ID column. From 2027 two tables do ([PAE-2283](https://eaflood.atlassian.net/browse/PAE-2283)):

- the accredited exporter's received-loads table
- the registered-only exporter's loads-exported table

Filling in and the previous-year position in the context apply to both. The credit exemption applies only to the accredited table, the only one with a balance. The date rule (below) applies to every row, linked or not.

When a summary log is validated, each row with a previous-year row ID is resolved against the registration's **latest submitted** previous-year summary log in the **same stream**:

- **Accredited log:** the previous year's accredited stream, found through the registration's previous-year accreditation in the organisation read model (each year's accreditation is a separate record, so the current ledger id with the year changed does not find it).
- **Registered-only log:** the previous year's registered-only stream.
- **No such stream** (for example registered-only in 2026, accredited in 2027): every link is unresolved and the previous year's position is `null`.

Within the stream, validation reads the latest commit that restates the year's row states (today, the latest `summary-log-submitted` event; a later commit type that restates memberships, as ADR-0037 allows, counts too), then the row state with that `rowId` and `wasteRecordType` in its membership. Uncommitted previous-year uploads are never read: their memberships are inert.

That commit is read **once** per validation, and both the fill-in and the context use it: rows are filled in from the row states of the summary log it names, and its event number is the previous year's position in the context (below). Two separate reads could straddle a previous-year submission, filling rows from one submission while recording the next as the position, and the context check would then pass a log filled from out-of-date values.

A resolved row is **filled in** before any other validation runs:

- A blank cell takes the previous-year row's value. An operator cannot clear a previous-year value on the linked row.
- A supplied cell keeps the supplied value.
- Only the later template's declared columns are filled in, excluding the row ID and the previous-year row ID.
- A column renamed between years needs an explicit mapping; it is not matched by name.

Syntax validation (including every cross-field check), required-field checks and classification then see the filled-in row. So a linked row is checked as a whole load, values supplied on it are checked against inherited ones, and the check page shows the filled-in reading.

For example, with three of the columns:

| Column                 | 2026 row `1500` | 2027 row `1000` as entered | 2027 row `1000` filled in |
| ---------------------- | --------------- | -------------------------- | ------------------------- |
| `DATE_OF_EXPORT`       | 2026-12-28      | (blank)                    | 2026-12-28, inherited     |
| `OSR_ID`               | 012             | 047                        | 047, supplied value wins  |
| `DATE_RECEIVED_BY_OSR` | (blank)         | 2027-01-06                 | 2027-01-06, supplied      |

A previous-year row ID that matches no submitted previous-year row will be rejected by validation ([PAE-2097](https://eaflood.atlassian.net/browse/PAE-2097)). Until then, such a row is not filled in and is stored as the operator wrote it (see Consequences).

A linked row's `data` carries previous-year dates by design. A validation rule that rejects earlier-year dates ([PAE-2101](https://eaflood.atlassian.net/browse/PAE-2101)) therefore applies to the cells the operator supplied, not to inherited values.

### Cross-field checks allow for stored rounding on linked rows

Inherited tonnages and weights are the stored two-decimal-place values (ADR-0037 coerces at write), not what the operator typed; other inputs, such as the recyclable proportion, are stored as entered. A cross-field check can therefore fail on a linked row through rounding alone. A 2026 load of 10.12 t at a proportion of 0.37 has a tonnage of 3.7444 t, stored as 3.74 t. On the linked row the check recomputes 3.7444 t and compares it with the inherited 3.74 t.

So on a row whose `data` has a previous-year row ID, each cross-field check widens its comparison by the most that two-decimal-place storage of its inputs can account for, and by no more. For the export tonnage check the allowance is:

- 0.005 t on the stored tonnage
- up to 0.015 t carried from the net weight, re-derived from three rounded weights
- up to 0.005 t carried from the non-target weight

That totals about 0.025 t. The net weight check needs no allowance: the stored net weight is re-derived from the stored gross, tare and pallet weights, so it reconciles by construction. Unlinked rows keep today's comparison.

The check still catches a real mismatch. In the example above, the inherited 3.74 t is within the allowance of the recalculated 3.7444 t, so the row passes. If the operator instead supplies a tonnage of 3.80 t on the linked row against the same inherited weights and proportion, it is 0.056 t out, beyond the allowance, so the row is rejected.

A cross-field failure on a linked row can involve a cell the operator left blank, so its error says which values came from the previous year's row, and the operator knows which summary log to correct.

### `data` is the complete load; `link` records where it came from

Every summary log restates every load in full (ADR-0037), so a row state's `data` has always meant "this load's values as of this submission". A linked row's filled-in values mean exactly that, so they are stored in `data`. Every reader of row states (the waste balance, reports, exports, the credited-tonnage report) reads a linked row like any other: no reader combines two sources, looks across years or reads `link`. Two kinds of reader do change: classification and cross-field checks read the previous-year row ID in `data`, and readers that place rows in periods by date gain a rule about the row's year (below).

What is new is provenance: some of the load's values were last entered in a different year's file. That is recorded beside `data` in a `link`, which no reader of the balance, reports or exports uses:

```
{
  …row identity…,
  data: { …filled-in, coerced row… },
  link: {
    year: 2026,
    rowId: 1500,
    rowStateId: "…",            // the previous-year row state it was filled in from
    suppliedFields: [ … ]        // the fields the operator supplied on the linked row
  },
  classification: { … },
  summaryLogIds: [ … ]
}
```

`link` is used by row history and by a later recalculation, which needs `suppliedFields` to fill the row in again without the workbook (ADR-0058 removed the workbook from submission). It is part of the row state's content (`processingType`, `data`, `link` and `classification`), and so of the upsert key: a linked row whose `data` is unchanged but whose previous-year row state has changed gets a new document, visible in its history.

`link` sits beside `data`, not inside it: `data` holds the template's columns (ADR-0037), and a key no template declares would be dropped from the waste-records exports with a warning (ADR-0059).

### A linked row's credit is decided on its overseas receipt

An accredited exporter row counts towards the waste balance only if both its date of export and its date received overseas fall within the accreditation. For a row whose `data` has a previous-year row ID, the date of export is exempt from that check: the row counts if its date received overseas falls in the current year's accreditation, on a day the accreditation was live. Every other classification rule applies unchanged.

One of those rules depends on overseas-site approvals staying shared across years. A row is excluded unless its overseas site was approved on or before its date of export, and the check reads the sites of the accreditation being classified: for a linked row, the current year's sites against a previous-year export date. Today every accreditation lists the registration's sites with the same stored approval, so the check gives the right answer. When site approvals become per year, a linked row's site approval must come from the year the load was exported; that is out of scope here.

The exemption keys on the previous-year row ID in `data`, not on `link`, so classification still reads `data` alone.

The previous-year row is not affected. Its classification is that year's reading against that year's accreditation, as before.

### Readers that place rows in periods by date count only the summary log's own year

A linked 2027 row carries its 2026 dates, and the 2026 row it was filled in from carries the same dates. A reader that places rows in periods by date, across years, therefore sees the same load twice, or sees a 2027 summary log reaching into a 2026 period. So **a reader that places rows in periods by date counts a row only in periods of its own summary log's year**; a date in another year places the row in no period. The rule covers every row, linked or not, and dates the operator supplied as well as inherited ones, so it needs no knowledge of links. ADR-0048 already makes it true of reports, which read only their own year's rows.

The readers that place rows by date, and what the rule means for each:

| Reader                                              | Places exporter rows by                                    | Effect of the rule                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monthly reports                                     | Received for export, exported and repatriated dates        | None: a year's report has only that year's periods.                                                                                                                                                                                                                            |
| Credited tonnage                                    | Date received overseas, credited rows only                 | None: a linked row is credited only in the later year, so it is counted once.                                                                                                                                                                                                  |
| Check-page period status and resubmission detection | Received for export, exported and repatriated dates        | Considers only the submitted periods of the summary log's own year. Without it, a linked load received in December 2026 would be shown as a closed-period load, and the December 2026 report as requiring resubmission, though a 2027 summary log cannot change a 2026 report. |
| Tonnage monitoring                                  | Date of export, latest submission of every ledger and year | Counts each ledger's rows only in months of that ledger's year. Without it, a load exported in December 2026 and received overseas in 2027 would be counted in December 2026 from both the 2026 row and the linked 2027 row.                                                   |

A previous-year row that records a later-year date (for example a 2027 export on a 2026 row) is then counted in neither year by these readers unless a linked later-year row supplies it; recording later-year completion data on the previous-year row is out of scope here.

### The context includes the previous year's position

The filled-in reading depends on which previous-year submission the rows were read from, just as the credit depends on overseas-site approval. So it is context. For a template with a table that links years, the context gains the **event number of the previous year's latest commit that restates its row states** in the same stream (today its latest `summary-log-submitted` event), or `null` if the previous year has no submission in it. It is that commit's number, not the stream's latest event, because PRN events on the previous year's stream change nothing a linked row reads.

ADR-0058 hashes the context at validation, and the submit route and the submission worker rebuild it and supersede the log if the hash differs. The check is unchanged, but its input widens: the hash covers the whole context except the table schemas (which follow from the summary log's year and template), not a named subset of it, so the position, and any context field added later, is part of it. A previous-year resubmission between validation and submission changes the position, so the log is superseded as `CONTEXT_CHANGED` and the operator re-uploads and confirms the new reading. A previous year with no submission at validation and one by the time of submission is caught the same way, so an ID that could not be resolved at validation is never committed unresolved once it could be.

Three consequences for the context:

- **One builder.** Validation and submission build the context with the same function, which now reads the previous year's ledger as well as the organisation read model. ADR-0058's "classification context" therefore means everything outside the workbook that the reading depends on, not only what classification reads.
- **Absent, not null, where it does not apply.** Templates without a table that links years omit the key entirely, so their contexts hash exactly as before and no in-flight log is superseded when this is deployed.
- **Every applicable log, linked or not.** The context is per log and independent of the workbook, so a previous-year resubmission supersedes every in-flight later-year log of the registration in the same stream, including logs with no linked rows (see Consequences).

### Previous-year changes reach the later year at its next upload

Once a later-year summary log is submitted, its linked rows keep the values they were filled in with. A later change to a previous-year row reaches the later year's balance and reports only when the operator next uploads the later year's summary log, whose validation fills the row in again from the latest previous-year submission. Recalculating the later year automatically when a previous-year row changes is a separate decision ([PAE-2302](https://eaflood.atlassian.net/browse/PAE-2302)); ADR-0037 already leaves room for a non-submission commit that restates a partition's memberships, and `suppliedFields` keeps that open.

### Worked example

A 2026 accredited exporter summary log, latest submission `sl-2026-12` (event number 14 on the 2026 stream), has row `1500`: 40 tonnes received for export on 20 December 2026, exported on 28 December 2026, no date received overseas. It contributes nothing to the 2026 balance.

The operator's first 2027 summary log, `sl-2027-01`, has row `1000` with previous-year row ID `1500` and only a date received overseas, 6 January 2027, filled in. Validation resolves `1500` against `sl-2026-12`, fills in the tonnage, the export date and the other blank fields, records 14 as the previous year's position in its context, and writes:

```
{
  rowId: 1000, wasteRecordType: "exported", year: 2027,
  data: { PREVIOUS_YEAR_ROW_ID: 1500, TONNAGE_OF_UK_PACKAGING_WASTE_EXPORTED: 40,
          DATE_OF_EXPORT: "2026-12-28", DATE_RECEIVED_BY_OSR: "2027-01-06", … },
  link: { year: 2026, rowId: 1500, rowStateId: "rs-1500-a", suppliedFields: ["DATE_RECEIVED_BY_OSR", …] },
  classification: { outcome: "INCLUDED", reasons: [], transactionAmount: 40 },
  summaryLogIds: ["sl-2027-01"]
}
```

The export date is before the 2027 accreditation, but the row has a previous-year row ID and was received overseas in 2027, so it is included and the 2027 balance rises by 40 tonnes. The 2026 balance is unchanged.

Before submitting `sl-2027-01`, the operator corrects row `1500`'s tonnage to 38 and resubmits 2026 as `sl-2026-12b`, event number 16 (a PRN event took 15). The previous year's position is now 16, so `sl-2027-01`'s context hash no longer matches and its submission is superseded. The operator re-uploads 2027, and validation fills row `1000` in with 38 tonnes from row state `rs-1500-b`. Had the PRN event been the only change, the position would still be 14 and `sl-2027-01` would have committed.

Had the operator submitted `sl-2027-01` first instead, the 2027 balance would have risen by 40 tonnes. Correcting row `1500` to 38 tonnes in February would then leave the 2027 balance at 40 tonnes until the operator next uploads their 2027 summary log, whose validation fills row `1000` in with 38 tonnes, and the balance falls by 2 tonnes when that upload is submitted.

A second load shows the date rule. 2026 row `1600` records 25 tonnes received for export on 20 December 2026, not yet exported. 2027 row `1001` links to it and supplies an export date of 12 January 2027 and a date received overseas of 3 February 2027. The December 2026 report shows the 25 tonnes received, from the 2026 row. The January 2027 report shows them exported, from the 2027 row, and the 2027 balance rises by 25 tonnes. On the 2027 check page the row's December 2026 date places it in no period, so even if the December 2026 report has been submitted the row is an open-period load, and only a submitted January 2027 report would make it closed.

## Considered alternatives

**Resolve the link whenever a row is read.** Store only what the operator supplied, and join to the previous year's row in every reader. Previous-year changes would reach the later year immediately, but every reader (waste balance, reports, exports, the credited-tonnage report) would carry cross-year logic, and a stored row state would no longer be the reading its event committed (ADR-0037). Rejected.

**Fill in after syntax validation.** Syntax validation would run on the supplied cells only, so inherited values would never be re-checked and rounding could not fail a row. Rejected because a cross-field check skips itself unless all its fields are present, so a value supplied on the linked row would never be checked against inherited ones.

**Fill in from the previous year's workbook.** Every submitted workbook is retained (ADR-0037), so validation could read full-precision values from the previous year's latest submitted file, and every cross-field check would run unchanged. Rejected because each later-year validation with links would read and parse a second, possibly large, workbook with the previous year's template, and would fill in raw cells rather than the coerced values the previous year's balance was built from.

**Store full-precision values on row states as well.** Rejected: a second copy beside the two-decimal-place rule, and a backfill for row states already written.

**Carry the previous year's rows forward.** Keep the 2026 summary log open for 2027 completion data and derive a carry-forward set that feeds the 2027 balance. Discounted by the business in favour of explicit links ([PAE-2012](https://eaflood.atlassian.net/browse/PAE-2012)).

**Store only what the operator entered in `data`, with the previous-year values beside it.** `data` would hold the workbook's row verbatim and `link` the previous-year row's values, so which fields were supplied would be implicit and a later recalculation would only swap `link`. Rejected because every reader that needs the load (report aggregation, reclassification) would have to combine the two, and one that forgot would read a partial load.

**Key the credit exemption on `link`.** An unresolved ID would then give no exemption even before validation rejects it. Rejected because classification would depend on more than `data`, and every reclassification from stored row states would need to know about links.

**Do not record which fields were supplied.** The filled-in `data` alone serves every reader today. Rejected because without it, a later recalculation could not tell a supplied value from an inherited one without the workbook, which would close off automatic recalculation.

**Leave the previous year out of the context.** Without automatic recalculation the committed later-year rows can already lag the previous year, so the check protects less here than in ADR-0058. Rejected because it keeps ADR-0058's guarantee that an operator commits the reading they confirmed, at the cost of a re-upload in a narrow window.

**Hash the linked previous-year row states instead.** Precise: only a change to a row the log actually links supersedes it. Rejected because the row states are not context the organisation read model or ledger can rebuild cheaply (submission would re-resolve every link on the submit route), and an ID unresolved at validation would never change the hash once it became resolvable.

**A separate previous-year baseline beside `validatedAgainstSummaryLogId`.** Same detection as the position in the context, but a new field on the summary log and a new supersede reason for what is the same kind of change. Rejected in favour of reusing ADR-0058's context check unchanged.

**Include the position only for logs with linked rows.** Avoids superseding unlinked logs, but submission would need to know whether a log had links without its workbook, from a saved flag or a query of its row states, making the context depend on the workbook. Rejected: the exposure it removes is bounded to the previous year's open months and the gap between validation and submission.

## Consequences

### Positive

- **One exception to year isolation, and only a read.** Ledgers, row states and reports stay per year; the only cross-year access is validation reading the previous year's latest submitted row states.
- **`data` keeps its meaning, and readers never combine sources.** A linked row state holds complete `data`, so the waste balance, reports and exports read it like any other row; only readers that place rows in periods by date gain a rule about the row's year. A load received in December 2026 and exported in January 2027 appears in the December 2026 report from the 2026 row and in the January 2027 report from the linked 2027 row.
- **The operator confirms what is committed.** The check page shows the filled-in reading, and a previous-year resubmission after validation supersedes the log before it commits, through ADR-0058's existing context check.

### Negative

- **The later year can lag the previous year.** A previous-year change after the later year's submission reaches the later year only at its next upload.
- **Later-year validation and submission depend on the previous year's stream.** Building the context reads the previous year's latest submission, at validation, on the submit route and in the submission worker.
- **Any previous-year resubmission supersedes in-flight later-year logs.** Linked or not, a later-year log of the registration that is validated but not yet submitted is superseded and re-uploaded. The exposure ends when the previous year closes at the end of February; until that close is enforced, it lasts as long as the previous year accepts submissions.
- **A blank cell cannot clear a value.** An operator who needs to remove a previous-year value on a linked row has to correct the previous-year row instead.
- **Cross-field checks are slightly looser on linked rows.** A linked row's export tonnage can differ from its recalculation by up to about 0.025 t and still pass, where an unlinked row must match exactly. The allowance is no more than two-decimal-place storage makes unavoidable.
- **Cross-field checks need to know a row is linked.** They read the previous-year row ID from `data`, as the credit exemption does.
- **Unmatched previous-year row IDs are exempt until validation rejects them.** Until the validation rule for an ID that matches no submitted previous-year row lands, such a row is stored unfilled but still carries the ID, so it gets the export-date exemption. A sparse row still fails the required-field check and credits nothing; a row the operator completed in full with a wrong ID is credited on its overseas receipt date alone. The validation rule ([PAE-2097](https://eaflood.atlassian.net/browse/PAE-2097)) closes this.
- **Later-year row states carry earlier-year dates.** A linked row's `data` holds its 2026 dates. Check-page period status and tonnage monitoring change to count only the summary log's own year, and any new reader that places rows in periods by date must do the same.
- **Later-year dates on a previous-year row count in neither year.** A 2027 date recorded on a 2026 row is not placed in a period by the date-placing readers unless a linked 2027 row supplies it.

## Out of scope

- **Recalculating the later year when a previous-year row changes after the later year's submission** ([PAE-2302](https://eaflood.atlassian.net/browse/PAE-2302)).
- **Edge cases of the link itself**: the validation error for an ID that matches no row ([PAE-2097](https://eaflood.atlassian.net/browse/PAE-2097)), two later-year rows linking the same row, a link to the wrong load, a link to a row already credited in the previous year ([PAE-2098](https://eaflood.atlassian.net/browse/PAE-2098)), and a linked load exported while the previous year's accreditation was suspended.
- **Per-year overseas-site approvals for linked rows**: checking a linked row's site against the approval of the year it was exported, once approvals are per year.
- **Columns renamed between years**: the explicit mapping a linked row needs to fill in a renamed column.
- **Refused, stopped and repatriated loads** across the year boundary.
- **Links across streams**, for example a 2027 accredited row linking a 2026 registered-only row.

## Related

- [ADR-0048](./0048-dual-multi-year-summary-logs.md): the year isolation this ADR amends
- [ADR-0058](./0058-validation-writes-summary-log-row-states.md): validation writes row states and hashes the context that submission checks
- [ADR-0037](./0037-summary-log-row-states-with-membership.md): row states, membership and the room for non-submission commits
- [ADR-0059](./0059-waste-records-exports-carry-template-declared-columns.md): why `link` sits beside `data`
- [PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282): the happy path this ADR serves
