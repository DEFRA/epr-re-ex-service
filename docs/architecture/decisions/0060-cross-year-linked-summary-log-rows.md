# 60. Cross-year linked summary-log rows

Date: 2026-11-19

## Status

Proposed. Amends [ADR-0048](./0048-dual-multi-year-summary-logs.md): a later year's validation may read an earlier year's submitted row states. Nothing is written across a year boundary.

| ADR                                                                   | Title                                                 | Relationship                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [0048](0048-dual-multi-year-summary-logs.md)                          | Dual and multi-year summary logs                      | Amends: Part 1's "no carry-over across a year boundary" gains one exception, a read at validation.            |
| [0058](0058-validation-writes-summary-log-row-states.md)              | Validation writes summary-log row states              | Builds on: linked rows are filled in once, at validation, and the context gains the previous year's position. |
| [0037](0037-summary-log-row-states-with-membership.md)                | Summary-log row states with membership                | Extends: `data` keeps its meaning; a linked row state also records where its values came from.                |
| [0059](0059-waste-records-exports-carry-template-declared-columns.md) | Waste-records exports carry template-declared columns | Constrains: the link sits beside `data`, not in it, so it never reaches the exports as an undeclared column.  |

## Context

An accredited exporter can export a load in one year that is received overseas in the next. Under ADR-0048 each year has its own summary log, row states and waste balance, so a load exported in 2026 and received overseas in 2027 counts in neither: it is outside the 2026 accreditation because it was received overseas in 2027, and outside the 2027 accreditation because it was exported in 2026.

The business chose to resolve this by letting the operator link the two years explicitly ([PAE-2012](https://eaflood.atlassian.net/browse/PAE-2012)). From 2027 the accredited exporter's received-loads table has a previous-year row ID column (`PREVIOUS_YEAR_ROW_ID`). A 2027 row that names a 2026 row there is a **linked row**. It is not a re-upload of the 2026 row: it holds whatever completion data was missing in 2026, and takes the rest from the 2026 row. The 2027 waste balance and 2027 reports are informed only by 2027 rows, including the values a linked row takes from its 2026 row ([PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282)).

The column is stored today, but nothing reads it. Three things therefore have to be decided: where and when a linked row takes its 2026 values, what a linked row state records, and how a linked row's credit is decided. ADR-0058 settles the first in principle: validation is the only place rows are built, so that is where a linked row is filled in.

## Decision

### Validation fills in linked rows from the earlier year's submitted row states

When a summary log is validated, each row with a previous-year row ID is resolved against the **latest submitted** summary log of the same registration and stream in the previous year: the latest `summary-log-submitted` event on that year's stream, then the row state with that `rowId` and `wasteRecordType` in its membership (ADR-0037's read). An in-flight or abandoned previous-year upload is never read, because its memberships are inert.

A resolved row is **filled in** before any other validation runs: every field the operator left blank takes the previous-year row's value, and every field the operator supplied keeps the supplied value. Syntax, business validation and classification then see the filled-in row, so a linked row is checked as a whole load and the check page shows the filled-in reading. A blank cell always means "take the previous-year value"; an operator cannot clear a previous-year value on the linked row.

A previous-year row ID that matches no submitted previous-year row will be rejected by validation. Until that rule lands, such a row is not filled in and is stored as the operator wrote it (see Consequences).

### `data` is the complete load; `link` records where it came from

Every summary log restates every load in full (ADR-0037), so a row state's `data` has always meant "this load's values as of this submission". A linked row's filled-in values mean exactly that, so they are stored in `data`. Every reader of row states (the waste balance, reports, exports, the credited-tonnage report) reads a linked row like any other: no reader combines two sources, looks across years or needs to know a row was linked.

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

`link` has two users: row history, and a later recalculation (`suppliedFields`). It is part of the row state's content, so it is part of the upsert key and is immutable like the rest of the document. A linked row whose filled-in `data` is unchanged but whose previous-year row state has changed gets a new state document, and the change is visible in its history.

`link` sits beside `data`, not inside it: `data` holds the template's columns (ADR-0037), and a key no template declares would be dropped from the waste-records exports with a warning (ADR-0059).

`suppliedFields` is not needed to fill in a row at validation, because the workbook is in hand there. It is recorded so that a later recalculation can fill a linked row in again from changed previous-year values without reading the workbook, which ADR-0058 removed from submission.

### A linked row's credit is decided on its overseas receipt

An accredited exporter row counts towards the waste balance only if both its date of export and its date received overseas fall within the accreditation. For a row whose `data` has a previous-year row ID, the date of export is exempt from that check: the row counts if its date received overseas falls in the current year's accreditation, on a day the accreditation was live. Every other classification rule applies unchanged.

The exemption keys on the previous-year row ID in `data`, not on `link`, so classification still reads `data` alone, and any reclassification from stored row states reaches the same answer as validation without knowing about links.

The previous-year row is not affected. Its classification is that year's reading against that year's accreditation, as before.

### The context includes the previous year's position

The filled-in reading depends on which previous-year submission the rows were read from, just as the credit depends on overseas-site approval. So it is context. For a template that carries a previous-year row ID column, the context gains the **number of the previous year's latest `summary-log-submitted` event** on that registration's stream, or `null` if the previous year has no submission. It is the latest submission's number, not the stream's latest event, because PRN events on the previous year's stream change nothing a linked row reads.

ADR-0058 hashes the context at validation, and the submit route and the submission worker rebuild it and supersede the log if the hash differs. Nothing about that check changes: a previous-year resubmission between validation and submission changes the position, so the log is superseded as `CONTEXT_CHANGED` and the operator re-uploads and confirms the new reading. A previous year with no submission at validation and one by the time of submission is caught the same way, so an ID that could not be resolved at validation is never committed unresolved once it could be.

Three consequences for the context:

- **One builder.** Validation and submission build the context with the same function, which now reads the previous year's ledger as well as the organisation read model. ADR-0058's "classification context" therefore means everything outside the workbook that the reading depends on, not only what classification reads.
- **Absent, not null, where it does not apply.** Templates without the column omit the key entirely, so their contexts hash exactly as before and no in-flight log is superseded when this is deployed.
- **Every applicable log, linked or not.** The context is per log and independent of the workbook, so a previous-year resubmission supersedes every in-flight later-year log of the registration, including logs with no linked rows. That exposure exists only while the previous year can still be submitted (until the end of February), and only between a log's validation and its submission.

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
  classification: { outcome: "INCLUDED", reasons: [], amount: 40 },
  summaryLogIds: ["sl-2027-01"]
}
```

The export date is before the 2027 accreditation, but the row has a previous-year row ID and was received overseas in 2027, so it is included and the 2027 balance rises by 40 tonnes. The 2026 balance is unchanged.

Before submitting `sl-2027-01`, the operator corrects row `1500`'s tonnage to 38 and resubmits 2026 as `sl-2026-12b`, event number 16 (a PRN event took 15). The previous year's position is now 16, so `sl-2027-01`'s context hash no longer matches and its submission is superseded. The operator re-uploads 2027, and validation fills row `1000` in with 38 tonnes from row state `rs-1500-b`. Had the PRN event been the only change, the position would still be 14 and `sl-2027-01` would have committed.

## Considered alternatives

**Resolve the link whenever a row is read.** Store only what the operator supplied, and join to the previous year's row in every reader. Previous-year changes would reach the later year immediately, but every reader (waste balance, reports, exports, the credited-tonnage report) would carry cross-year logic, and a stored row state would no longer be the reading its event committed (ADR-0037). Rejected.

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
- **Readers do not change, and `data` keeps its meaning.** A linked row state holds complete `data`, so the waste balance, reports and exports read it like any other row. A load received in December 2026 and exported in January 2027 appears in the December 2026 report from the 2026 row and in the January 2027 report from the linked 2027 row.
- **The operator confirms what is committed.** The check page shows the filled-in reading, and a previous-year resubmission after validation supersedes the log before it commits, through ADR-0058's existing context check.

### Negative

- **The later year can lag the previous year.** A previous-year change after the later year's submission reaches the later year only at its next upload.
- **Later-year validation and submission depend on the previous year's stream.** Building the context reads the previous year's latest submission, at validation, on the submit route and in the submission worker.
- **Any previous-year resubmission supersedes in-flight later-year logs.** Linked or not, a later-year log of the registration that is validated but not yet submitted is superseded and re-uploaded. The exposure ends when the previous year closes at the end of February; until that close is enforced, it lasts as long as the previous year accepts submissions.
- **A blank cell cannot clear a value.** An operator who needs to remove a previous-year value on a linked row has to correct the previous-year row instead.
- **Unmatched previous-year row IDs are exempt until validation rejects them.** Until the validation rule for an ID that matches no submitted previous-year row lands, such a row is stored unfilled but still carries the ID, so it gets the export-date exemption. A sparse row still fails the required-field check and credits nothing; a row the operator completed in full with a wrong ID is credited on its overseas receipt date alone. The validation rule closes this.
- **Later-year row states carry earlier-year dates.** A linked row's `data` holds its 2026 dates, so anything reading a 2027 row state must not assume all of its dates fall in 2027.

## Out of scope

- **Recalculating the later year when a previous-year row changes after the later year's submission** ([PAE-2302](https://eaflood.atlassian.net/browse/PAE-2302)).
- **Edge cases of the link itself**: the validation error for an ID that matches no row (its interim effect is under Consequences), two later-year rows linking the same row, a link to the wrong load, a link to a row already credited in the previous year, and a linked load exported while the previous year's accreditation was suspended.
- **Refused, stopped and repatriated loads** across the year boundary.
- **Registered-only exporters** ([PAE-2283](https://eaflood.atlassian.net/browse/PAE-2283)), whose template carries the same column; the filling-in rule is expected to carry over, but has no balance to credit.
- **Links across streams**, for example a 2027 accredited row linking a 2026 registered-only row.

## Related

- [ADR-0048](./0048-dual-multi-year-summary-logs.md): the year isolation this ADR amends
- [ADR-0058](./0058-validation-writes-summary-log-row-states.md): validation writes row states and hashes the context that submission checks
- [ADR-0037](./0037-summary-log-row-states-with-membership.md): row states, membership and the room for non-submission commits
- [ADR-0059](./0059-waste-records-exports-carry-template-declared-columns.md): why `link` sits beside `data`
- [PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282): the happy path this ADR serves
