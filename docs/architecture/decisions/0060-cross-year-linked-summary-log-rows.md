# 60. Cross-year linked summary-log rows

Date: 2026-11-19

## Status

Proposed. Amends [ADR-0048](./0048-dual-multi-year-summary-logs.md): a later year's validation may read an earlier year's submitted row states. Nothing is written across a year boundary.

| ADR                                                                   | Title                                                 | Relationship                                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [0048](0048-dual-multi-year-summary-logs.md)                          | Dual and multi-year summary logs                      | Amends: Part 1's "no carry-over across a year boundary" gains one exception, a read at validation.                           |
| [0058](0058-validation-writes-summary-log-row-states.md)              | Validation writes summary-log row states              | Amends: linked rows are filled in once, at validation, and the context gains the previous year's position and accreditation. |
| [0037](0037-summary-log-row-states-with-membership.md)                | Summary-log row states with membership                | Extends: `data` keeps its meaning; a linked row state also records where its values came from.                               |
| [0059](0059-waste-records-exports-carry-template-declared-columns.md) | Waste-records exports carry template-declared columns | Constrains: the link sits beside `data`, not in it, so it never reaches the exports as an undeclared column.                 |

The [HLD](../discovery/summary-log-cross-year-links-hld.md) gives the overview and the [LLD](../discovery/summary-log-cross-year-links-lld.md) the mechanics, including a worked example.

## Context

### Who is affected

Only exporters. A load can cross the year boundary between the stages an exporter records on one row of its Exported tab:

- **Exported in one year, completed overseas in the next.** For an accredited exporter, a load exported in 2026 and received overseas in 2027 counts in neither year's waste balance: it is outside the 2026 accreditation because it was received overseas in 2027, and outside the 2027 accreditation because it was exported in 2026. For either kind of exporter, a load refused, stopped or repatriated in 2027 has its outcome recorded a year after the row.
- **Received for export in one year, exported in the next** (accredited exporters only; registered-only exporters record receipts on a separate tab). The 2027 row would have to repeat every receipt column already in 2026.

Reprocessors are not affected: they have no Exported tab.

Under ADR-0048 each year has its own summary log, row states and waste balance, so neither case can be completed today. The business chose to let the operator link the two years explicitly ([PAE-2012](https://eaflood.atlassian.net/browse/PAE-2012)). From 2027 the Exported tab of both exporter templates has a previous-year row ID column (`PREVIOUS_YEAR_ROW_ID`). A 2027 row that names a 2026 row there is a **linked row**: it holds what was missing in 2026, and takes the rest from the 2026 row. The 2027 balance and 2027 reports are informed only by 2027 rows, including the values a linked row takes from its 2026 row ([PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282)). The column is already read from the workbook and stored, but nothing uses it yet.

|                                        | Accredited exporter                                     | Registered-only exporter                   |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| Linking table                          | `RECEIVED_LOADS_FOR_EXPORT`                             | `LOADS_EXPORTED`                           |
| Columns a linked row may supply        | Export and overseas columns                             | Refused, stopped and repatriation columns  |
| Effect of a linked row                 | Credits the 2027 waste balance; appears in 2027 reports | Appears in 2027 reports (no waste balance) |
| Previous-year accreditation in context | Yes, for the credit rule                                | No                                         |
| Previous year closes to corrections    | End of February                                         | 20 March                                   |

### Terms

These come from earlier ADRs:

- **Stream**: the event ledger of one registration's summary logs for one year ([ADR-0036](./0036-event-sourced-waste-balance-stream.md)). An accredited and a registered-only registration have separate streams.
- **Row state**: one stored version of a summary-log row, holding its values (`data`) and its classification ([ADR-0037](./0037-summary-log-row-states-with-membership.md)).
- **Membership**: the summary logs a row state belongs to (`summaryLogIds`). A summary log's rows are the row states with it in their membership.
- **Commit**: the event that makes a summary log's memberships count, today `summary-log-submitted`. Memberships of a log that was never committed are ignored.
- **Context**: everything outside the workbook that the reading of it depends on, such as the accreditation and overseas-site approvals. Validation hashes it, and submission supersedes the log if the hash has changed ([ADR-0058](./0058-validation-writes-summary-log-row-states.md)).

This ADR decides where a linked row takes its 2026 values, what its row state records, how its credit is decided and how the later year stays consistent with the earlier one. ADR-0058 settles the first in principle: validation is the only place rows are built, so that is where a linked row is filled in.

## Decision

### Validation fills in linked rows from the previous year's latest submitted row states

Linking applies only to tables whose schema declares it: the two linking tables above ([PAE-2283](https://eaflood.atlassian.net/browse/PAE-2283)).

Validation resolves each previous-year row ID against the registration's **latest submitted** previous-year summary log in the same stream. Uncommitted previous-year uploads are never read. That commit is read **once** per validation and serves both the fill-in and the context: two reads could straddle a previous-year submission, filling rows from one while the context records the next.

A resolved row is **filled in** before any other validation runs. The table schema declares an **allow list** of the columns a linked row may supply (see the table above): for an accredited exporter, every column from the tonnage exported and date of export through to the date received overseas and the refused, stopped and repatriation columns. The receipt columns always come from the previous-year row. None of the allowed columns is a template formula. An allowed column keeps a supplied value and otherwise takes the previous-year value. Every other column takes the previous-year value, whatever the later-year cell holds. A dropdown left on its placeholder counts as blank on both rows, since some 2026 columns store the placeholder as text. Every later check, the check page and the stored row then see the whole load.

The allow list keeps fill-in independent of the template. A formula the operator never touched, such as a net weight computed as 0 from blank weights, or a dropdown left on its default, is outside the list and cannot override the previous-year value. So fill-in needs no knowledge of the template's formulas or defaults, and a partly filled row cannot produce a partly computed load.

Rules that compare the two years read the previous-year row as stored and the row as entered. Before the previous year's correction deadline, a supplied allowed value that differs from one the previous-year row already holds is rejected ([PAE-2102](https://eaflood.atlassian.net/browse/PAE-2102)); a value in any other column is ignored. Earlier-year dates ([PAE-2101](https://eaflood.atlassian.net/browse/PAE-2101)) and the others in the epic's rules table are decided under their own tickets. Overrides after the deadline ([PAE-2107](https://eaflood.atlassian.net/browse/PAE-2107)) are out of scope: they would correct columns outside the list.

A previous-year row ID that matches no submitted row will be rejected ([PAE-2097](https://eaflood.atlassian.net/browse/PAE-2097)). Until then the row is stored as written and classified like any unlinked row.

### Cross-field checks on linked rows tolerate stored rounding

Some checks recalculate one value from others: the tonnage received for export from the net weight, non-target weight and recyclable proportion, for example. A linked row inherits those values as stored, to two decimal places (ADR-0037), not as the operator typed them, so the recalculation can differ from the stored value by rounding alone. On a linked row, each such check therefore accepts exactly the difference that two-decimal-place storage of its inputs can produce, and no more; the [LLD](../discovery/summary-log-cross-year-links-lld.md#cross-field-rounding-allowance) gives the figures. A real mismatch still fails, and its error says which values came from the previous year, so the operator knows which log to correct. Unlinked rows keep today's comparison.

### `data` holds the complete load; `link` records where it came from

- **`data`** is the filled-in row, the same shape as an unlinked row's. Every summary log restates every load in full (ADR-0037), so `data` has always meant "this load's values as of this submission", and a filled-in row means exactly that. The waste balance, reports, exports and market insights use it unchanged.
- **`link`** records the previous year, row ID and row state the row was filled in from, and `suppliedFields`: the allowed columns the operator supplied. Only row history and a later recalculation use it; recalculation needs `suppliedFields` to fill the row in again without the workbook.

`link` is part of the row state's content, so a change of previous-year row state shows in the row's history. It sits beside `data`, not inside it, because the exports drop any key no template declares (ADR-0059).

### Accredited exporters: credit is checked against the accreditation of each date's year

An accredited exporter row is credited only if its date received overseas falls on a live day of the current year's accreditation, and its date of export falls on a live day of the accreditation of that date's year. So the context carries the previous year's accreditation, or `null`, which excludes a previous-year export date.

The rule applies to every row, linked or not, so classification reads `data` and the context alone. Overseas-site approval is still checked using the current year's sites; per-year approvals are out of scope. The previous-year row's classification is unchanged.

### Readers that place rows in periods by date count only the summary log's own year

A linked 2027 row carries the same 2026 dates as the row it was filled in from, so a reader that places rows by date across years would see the load twice, or a 2027 log reaching into a 2026 period. So such a reader counts a row only in periods of its own summary log's year. The rule covers every row and every date, so it needs no knowledge of links. Reports already behave this way under ADR-0048; check-page period status and tonnage monitoring change.

A previous-year row cannot record a later-year date ([PAE-2100](https://eaflood.atlassian.net/browse/PAE-2100)), so later-year completion data always arrives on a linked row.

### The context includes the previous year's position and accreditation

The filled-in reading depends on which previous-year submission it was read from, so that is context, like overseas-site approval. For a template with a table that links years, the context gains:

- the **previous year's position**: the event number of its latest commit that restates row states, not its latest event, so PRN events do not count
- for an accredited exporter, the **previous year's accreditation**, for the credit rule

ADR-0058's check is unchanged but its input widens: the hash covers the whole context except table schemas, so a previous-year resubmission between validation and submission supersedes the log as `CONTEXT_CHANGED`. Validation and submission build the context with one function. Templates without a linking table omit the new keys, so their hashes are unchanged on deployment. The context is per log, so every in-flight later-year log in the stream is affected, linked or not.

### Previous-year changes reach the later year at its next upload

A submitted later-year log keeps the values its linked rows were filled in with. A later previous-year change reaches the later year when the operator next uploads it. Automatic recalculation is a separate decision ([PAE-2302](https://eaflood.atlassian.net/browse/PAE-2302)); ADR-0037 leaves room for a commit that restates memberships, and `suppliedFields` keeps that open.

## Prerequisites

- **`ROW_ID` generation in the 2027 exporter templates.** Today `ROW_ID` is generated only when columns a linked row usually inherits are filled, so a linked row that supplies only a date received overseas would have no row ID. It must be generated when the previous-year row ID or any data cell is filled. This goes beyond [PAE-2293](https://eaflood.atlassian.net/browse/PAE-2293) and needs agreeing with the template owner before the 2027 templates go out.

## Considered alternatives

**Resolve the link whenever a row is read.** Store only what the operator supplied, and join to the previous year's row in every reader. Previous-year changes would reach the later year immediately, but every reader would carry cross-year logic, and a stored row state would no longer be the reading its event committed (ADR-0037). Rejected.

**Fill in after syntax validation.** Inherited values would never be re-checked and rounding could not fail a row. Rejected because a cross-field check skips itself unless all its fields are present, so a value supplied on the linked row would never be checked against inherited ones.

**Fill in from the previous year's workbook.** Full-precision values, and cross-field checks unchanged. Rejected because each validation with links would parse a second, possibly large, workbook with the previous year's template, and fill in raw cells rather than the coerced values the previous year's balance was built from.

**Store full-precision values on row states as well.** Rejected: a second copy beside the two-decimal-place rule, and a backfill for row states already written.

**Carry the previous year's rows forward.** Keep the 2026 summary log open for 2027 completion data. Discounted by the business in favour of explicit links ([PAE-2012](https://eaflood.atlassian.net/browse/PAE-2012)).

**Store only what the operator entered in `data`, with the previous-year values beside it.** Rejected because every reader that needs the load would have to combine the two, and one that forgot would read a partial load.

**Accept any column, with template formulas blank until their inputs are filled.** Any supplied cell would count, relying on the template to blank untouched formulas and default dropdowns to a placeholder. Rejected because fill-in would then depend on every formula and default in the template being right, and a partly filled row would still produce a formula computed from a mix of supplied and blank inputs.

**Allow only the completion columns.** The date received overseas and the refused, stopped and repatriation columns. Rejected because a load received for export in one year and exported in the next would inherit blank export columns that credit requires, and never be credited.

**Track formula inputs in the table schema.** A formula column would count as supplied only if all its inputs were. Rejected because the domain code would have to mirror the template's formulas, and drift between the two would fail rows silently.

**Exempt the export date on linked rows.** Credit a linked row on its overseas receipt alone. Rejected because it credits a load exported while the previous year's accreditation was suspended or not yet started, and a wrong previous-year row ID would get the exemption until unmatched IDs are rejected.

**Do not record which fields were supplied.** Rejected because a later recalculation could not tell supplied from inherited values without the workbook.

**Leave the previous year out of the context.** Rejected because it keeps ADR-0058's guarantee that an operator commits the reading they confirmed, at the cost of a re-upload in a narrow window.

**Hash the linked previous-year row states instead.** Rejected because submission would re-resolve every link, and an ID unresolved at validation would never change the hash once it became resolvable.

**Include the position only for logs with linked rows.** Rejected because submission would need to know whether a log had links without its workbook, and the exposure it removes is bounded to the previous year's open months.

## Consequences

### Positive

- **One exception to year isolation, and only a read.** Ledgers, row states and reports stay per year.
- **`data` keeps its meaning, and readers never combine sources.** Only readers that place rows by date gain a rule.
- **The operator confirms what is committed.** The check page shows the filled-in reading, and a previous-year resubmission after validation supersedes the log through ADR-0058's existing check.
- **Fill-in is independent of the template's formulas and defaults**, and what a linked row may supply is explicit in its schema.

### Negative

- **The later year can lag the previous year** until its next upload, or until automatic recalculation ([PAE-2302](https://eaflood.atlassian.net/browse/PAE-2302)).
- **The later year depends on the previous year's stream and accreditation**, at validation, on the submit route, in the submission worker, and in the waste-records exports and market insights, which re-run classification when they read rows.
- **Any previous-year resubmission or accreditation change supersedes in-flight later-year logs**, linked or not, until the previous year closes to uploads: the end of February for accredited operators, 20 March for registered-only ones ([PAE-2106](https://eaflood.atlassian.net/browse/PAE-2106)).
- **A blank cell cannot clear a value.** The operator corrects the previous-year row instead.
- **Cross-field checks are looser on linked rows**, by up to about 0.025 t on the tonnage received for export.
- **Later-year row states carry earlier-year dates.** Any new reader that places rows by date must count only its own year.
- **A value outside the allow list is ignored, not rejected.** The check page shows the previous-year value, but the operator gets no error.
- **Fill-in depends on the `ROW_ID` template change** landing before the 2027 templates go out.

## Out of scope

- **Recalculating the later year when a previous-year row changes after the later year's submission** ([PAE-2302](https://eaflood.atlassian.net/browse/PAE-2302)).
- **Overrides on linked rows after the previous year's correction deadline** ([PAE-2107](https://eaflood.atlassian.net/browse/PAE-2107)).
- **Edge cases of the link itself**: an ID that matches no row ([PAE-2097](https://eaflood.atlassian.net/browse/PAE-2097)), two later-year rows linking the same row, a link to the wrong load, and a link to a row already credited ([PAE-2098](https://eaflood.atlassian.net/browse/PAE-2098)).
- **Per-year overseas-site approvals.**
- **Columns renamed between years**, which need an explicit mapping.
- **Rules specific to refused, stopped and repatriated loads** across the year boundary ([PAE-2105](https://eaflood.atlassian.net/browse/PAE-2105)). Their columns are on the allow list; the rules that check them are separate.
- **Links across streams**, for example a 2027 accredited row linking a 2026 registered-only row.

## Related

- [Summary Log Cross-Year Links HLD](../discovery/summary-log-cross-year-links-hld.md) and [LLD](../discovery/summary-log-cross-year-links-lld.md)
- [ADR-0048](./0048-dual-multi-year-summary-logs.md): the year isolation this ADR amends
- [ADR-0058](./0058-validation-writes-summary-log-row-states.md): validation writes row states and hashes the context that submission checks
- [ADR-0037](./0037-summary-log-row-states-with-membership.md): row states, membership and the room for non-submission commits
- [ADR-0059](./0059-waste-records-exports-carry-template-declared-columns.md): why `link` sits beside `data`
- [PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282): the happy path this ADR serves
