# 51. Carry forward cross-year exporter loads into the next accreditation year

Date: 2026-09-30

## Status

Proposed, and contingent on the business accepting four departures from its 28 September 2026 notes (see
"Where this departs from the 28 September notes"). If they are not accepted, this ADR does not apply.

Depends on [ADR-0048](./0048-dual-multi-year-summary-logs.md) as implemented by PAE-2002 and PAE-2004, and
amends one sentence of its Part 1 (see "Amendment to ADR-0048"). Adds an event kind to
[ADR-0036](./0036-event-sourced-waste-balance-stream.md) and a sweep in the pattern of
[ADR-0047](./0047-reconcile-stale-prn-projections.md).

## Context

### A load outlives the year it started in

An exporter's load is received, exported, and then received by the overseas reprocessing site (OSR). Those
three dates can fall in different calendar years. The accreditation, the waste balance and the reports are
all annual; the load is not.

For an accredited exporter the dates do different jobs:

- the **waste balance** is driven by `DATE_RECEIVED_BY_OSR`, the date para 27 of Schedule 8 to SI 2024/1332
  keys the exporter's evidence on;
- the **report** places receipt on `DATE_RECEIVED_FOR_EXPORT`, export on `DATE_OF_EXPORT`, and repatriation on
  `DATE_THE_REFUSED_STOPPED_WASTE_REPATRIATED`.

The business rules agreed on 28 September 2026 (Confluence,
[How to record and handle loads that cross the year boundary](https://eaflood.atlassian.net/wiki/spaces/MWR/pages/6605047784))
say:

- operators use a separate summary log (SL) for each calendar year;
- a load received and exported in 2026 but received overseas in 2027 appears in the 2026 reports for receipt
  and export, and affects the **2027** waste balance;
- a load received in 2026 but exported and received overseas in 2027 appears in the 2026 report for receipt,
  the 2027 report for export, and affects the **2027** waste balance;
- a load or tonnage affects only one calendar year's balance, never both;
- before an exported load enters a balance, the operator must have been accredited, and the overseas site
  approved, on both the date of export and the date received overseas;
- a refused or stopped load never enters a balance.

### ADR-0048 isolates the years, so the tonnage is lost

ADR-0048 scopes every SL, row-state, row-history and ledger stream to `{organisationId, registrationId, year,
accreditationId}`, with "no carry-over of rows, balance or continuity obligations across a year boundary".
PAE-2004 implements that and classifies each row against the accreditation for its own SL's year.

The exporter classification (`table-schemas/exporter/received-loads-for-export.js`) calls
`isAccreditedAtDates([DATE_OF_EXPORT, DATE_RECEIVED_BY_OSR], accreditation)`, which requires both dates inside
**one** accreditation. So once PAE-2004 lands, a 2026 row with a 2027 OSR date is
`OUTSIDE_ACCREDITATION_PERIOD` in 2026. That is correct: it is not 2026 tonnage, and it is not double counted.
But nothing reads that row in 2027, so the tonnage is never credited anywhere.

Year isolation is right. It needs exactly one deliberate, visible way across.

### Where this departs from the 28 September notes

This ADR adopts idea 2 from the Confluence page's ideas table (29 September 2026), **allow updates to the 2026 SL
in 2027**. The other ideas and their trade-offs are on that page. Idea 2 departs from four of the 28 September
notes:

| 28 September note                                                                  | What this ADR does instead                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| "The 2026 SL must not include any rows dated 2027"                                 | A 2026 row can carry 2027 dates in its continuation fields           |
| The 2026 log must not be used "to record events that happened in 2027"             | The continuation fields exist to record exactly those events         |
| "Changes to 2026 waste records must be prevented after … the end of February 2027" | Continuation fields on cross-year rows stay editable until 2027 ends |
| "2027 SL can include any rows dated 2026"                                          | The 2027 SL rejects accredited exporter rows received in 2026        |

The departures follow from the rules themselves. A load received in November 2026 must appear in the November
2026 report, so the operator has already recorded it in the 2026 SL long before it is exported or reaches the
overseas site. When those later events happen there are two choices: complete that row in the 2026 SL, which
needs 2027 dates in it, or record the load a second time in the 2027 SL, which risks counting it twice. The
28 September notes cannot all hold alongside "the load must affect the 2027 waste balance". The ideas table
itself records that idea 2 "partially conflicts with the business requirement that each year must have a
separate file".

## Decision

**The 2026 SL remains the only home for a load received in 2026. In 2027 the operator completes the row there.
A carry-forward set attached to the 2027 accredited stream feeds those rows into the 2027 waste balance and
reports.** The carry-forward set is the single, explicit way data crosses the year separation ADR-0048
establishes.

2026 and 2027 are used throughout as the concrete source and target years; the rules apply to any adjacent pair.

### 1. Where the row lives

A 2026-received accredited exporter load is recorded once, in the 2026 SL. In 2027 the operator may update its
**continuation fields** only:

- `DATE_OF_EXPORT` (only on a row whose `DATE_RECEIVED_FOR_EXPORT` is in 2026);
- `DATE_RECEIVED_BY_OSR`;
- refused or stopped;
- `DATE_THE_REFUSED_STOPPED_WASTE_REPATRIATED`.

`WERE_PRN_OR_PERN_ISSUED_ON_THIS_WASTE` is not a continuation field. A PERN raised in the service draws on the
pooled balance through its own ledger events and is not bound to a row
([ADR-0049](./0049-december-waste-prns.md)), so a 2027 PERN against carried tonnage is already debited from the
2027 balance. Marking the row as well would exclude its credit and deduct the same tonnage twice. The column
applies to a carried row exactly as it does today: a row marked Yes in the source year credits nothing.

Row identity, row continuity and the SL itself stay exactly as ADR-0048 defines them. The 2026 SL is not moved,
merged or copied into 2027.

### 2. The carry-forward set

The carry-forward set is **derived, not stored**. It is read from the source stream's latest submitted row
states ([ADR-0037](./0037-summary-log-row-states-with-membership.md)), which are persisted for every submission
and year-scoped under ADR-0048, and filtered by the membership rule below. There is no new collection.
`deriveCarryForwardSet(targetStream)` is the one function every reader uses.

A row is a member when it is on an accredited exporter's source-year SL, was received in the source year, and
**any** of its continuation dates (`DATE_OF_EXPORT`, `DATE_RECEIVED_BY_OSR`,
`DATE_THE_REFUSED_STOPPED_WASTE_REPATRIATED`) falls within the target accreditation.

Membership is deliberately wider than credit. The set feeds both the balance and the reports, and a row can have
a target-year report event without earning target-year credit: a load refused overseas, or one exported but not
yet received. Whether a member earns credit is decided by the classifier (section 4), not by membership.

The set has two readers: 2027 report generation (section 5) and `reconcileCarryForward(targetStream)`, which
brings the 2027 balance into line with it (section 4). At upload, validation derives the set from the uploaded
file's rows instead, for the check-page preview (section 7). What was carried, and when, is recorded by the
`carry-forward-updated` events and the service's audit logs.

#### Worked example: five loads received in November 2026

The exporter holds a 2026 and a 2027 accreditation, and the overseas site is approved on every relevant date.
Every row lives in the 2026 SL.

| Load | Exported | At the overseas site          | In the set?                | Credit                    | Report events                                       |
| ---- | -------- | ----------------------------- | -------------------------- | ------------------------- | --------------------------------------------------- |
| A    | Dec 2026 | Received Jan 2027             | Yes (OSR date)             | 2027, general pool        | Receipt Nov 2026, export Dec 2026                   |
| B    | Jan 2027 | Received Mar 2027             | Yes (export and OSR dates) | 2027                      | Receipt Nov 2026, export Jan 2027                   |
| C    | Dec 2026 | Refused, repatriated Mar 2027 | Yes (repatriation date)    | None (`WASTE_REFUSED`)    | Receipt Nov 2026, export Dec 2026, refusal Mar 2027 |
| D    | Jan 2027 | Not yet received              | Yes (export date)          | None yet (OSR date blank) | Receipt Nov 2026, export Jan 2027                   |
| E    | Nov 2026 | Received Dec 2026             | No                         | 2026, December pool       | Receipt and export Nov 2026                         |

- **A** is the core case. The 2026 classifier marks it `OUTSIDE_ACCREDITATION_PERIOD` because its dates span two
  accreditations, so it is credited once, in 2027. It is general-pool tonnage: ADR-0049 keys December on the OSR
  date, which is in January.
- **B** has both balance dates inside 2027, so if it were entered in the 2027 SL that SL would credit it too.
  The prior-year receipt rule (section 6) keeps it out, and its January 2027 export reaches the January 2027
  report only through the set.
- **C** and **D** credit nothing in 2027 but have 2027 report events: the refusal, reported in the month it
  happens, and the export. They are in the set for the reports' sake. D's credit follows once its OSR date is
  added.
- **E** completes in 2026. It never enters the set and is credited in 2026 exactly as today.

Report events dated 2026 come from the 2026 SL through the 2026 reports; those dated 2027 come from the set
through the 2027 reports (section 5).

### 3. Triggers

Reports derive the set when they are generated, so they need no trigger. The balance does: it moves only when a
`carry-forward-updated` event is appended. `reconcileCarryForward` runs on:

1. **source-year SL submit**, the usual case: the operator has just added a 2027 OSR date. It runs in the
   submit job after the source stream's own ledger event and before the SL is marked `SUBMITTED`, so a failed
   job is retried whole;
2. **target-year SL submit**, so the first 2027 submission picks up rows already waiting;
3. **a startup sweep on each deploy**, in the ADR-0047 pattern: `mongo-locks` guarded, dry-run by default,
   repair behind a feature flag. It is limited to accredited exporters with a post-year-end date on a source row
   and an accreditation for the target year.

The sweep is the safety net for "accredited for 2027 but no 2027 SL yet" and for a trigger that failed after
the source submission committed. Latency is bounded by the deploy interval. If that proves too slow, the next
step is the SQS-scheduled reconcile ADR-0047 names.

### 4. Waste balance

A new ADR-0036 event kind on the target stream:

| `kind`                  | `payload`                                                              | Effect on `closingBalance`                     |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `carry-forward-updated` | `{ sourceSummaryLogId, carryForwardCreditTotal, decemberCreditTotal }` | total and December fields += delta (see below) |

`sourceSummaryLogId` is the source-year SL the set was built from, whichever trigger wrote the event. It is the
cause of the event, as `summaryLogId` is on `summary-log-submitted`: the carried rows as they stood can be
recovered from it with ADR-0036's row-version canonicity walk.

It follows the `summary-log-submitted` rule: read the previous `carry-forward-updated` event on this stream
(absent is 0) and move the balance by `current − previous`, for both the total and the December portion. The
two kinds keep separate "previous" chains, so a 2026 resubmission can move the 2027 balance without a 2027
SL submission, and a 2027 SL submission never re-counts carried tonnage.

`carryForwardCreditTotal` is computed by the same resolver as `creditTotal` (`credited-tonnage.js`), with one
difference: a carried row is checked against **two** accreditations. The export date must fall within the
accreditation for its own year, the OSR date within the target accreditation, and the overseas site must be
approved on both dates (the per-year approval check is PAE-1884). A row can therefore sit in the set and credit
nothing, which keeps the reason visible for audit.

`decemberCreditTotal` follows ADR-0049 unchanged: December is December of the **target** accreditation year,
bucketed on `DATE_RECEIVED_BY_OSR`. A load exported in December 2026 and received overseas in January 2027 is
2027 general-pool tonnage, not December waste. The field is carried for consistency and will almost always be 0.

`reconcileCarryForward` appends an event only when it would change something, and never from a superseded
source:

- **No duplicate appends.** If the latest `carry-forward-updated` event already has this `sourceSummaryLogId`
  and the same totals, it appends nothing. A retried submit job therefore appends at most once. (The
  `summary-log-submitted` append does not have this property today.)
- **No appends from a superseded source.** Just before appending, it checks that `sourceSummaryLogId` is still
  the source stream's latest submitted SL. If a newer source submission has landed in the meantime, the job
  fails and is retried, and the retry derives the set again from the newer source. The ledger's unique slot
  index already stops two appends colliding; this check stops a slow reconcile appending totals from an older
  2026 SL after a newer one.

#### Worked example: the 2027 stream

The 2027 accredited stream of the exporter in section 2's example, with A at 50 t, B at 70 t and D at 30 t.
`decemberCreditTotal` is 0 throughout: none of these loads reaches the overseas site in December.

| #   | Trigger                                                    | `kind`                  | `payload`             | closingBalance (amount / availableAmount) | Notes                                       |
| --- | ---------------------------------------------------------- | ----------------------- | --------------------- | ----------------------------------------- | ------------------------------------------- |
| 1   | 15 Jan: 2026 SL resubmitted, A's OSR date added            | `carry-forward-updated` | `{ SL-26-3, 50, 0 }`  | 50 / 50                                   | No previous carry-forward event; delta = 50 |
| 2   | 3 Feb: first 2027 SL submitted                             | `summary-log-submitted` | `{ SL-27-1, 200 }`    | 250 / 250                                 | No previous SL event; delta = 200           |
| 3   | 10 Feb: PERN raised                                        | `prn-created`           | `{ PRN-1, 100 }`      | 250 / 150                                 | Ringfence on availableAmount                |
| 4   | 20 Feb: 2026 SL corrects A's tonnage to 40 t               | `carry-forward-updated` | `{ SL-26-4, 40, 0 }`  | 240 / 140                                 | Against #1; delta = −10                     |
| 5   | 20 Mar: 2026 SL resubmitted, B's OSR date added            | `carry-forward-updated` | `{ SL-26-5, 110, 0 }` | 310 / 210                                 | Against #4, not #2; delta = 70              |
| 6   | 25 Mar: 2026 SL records C's refusal and March repatriation | `carry-forward-updated` | `{ SL-26-6, 110, 0 }` | 310 / 210                                 | Against #5; delta = 0                       |
| 7   | 15 Apr: 2027 SL resubmitted                                | `summary-log-submitted` | `{ SL-27-2, 260 }`    | 370 / 270                                 | Against #2, not #6; delta = 60              |
| 8   | June: 2026 SL resubmitted, D's OSR date added              | `carry-forward-updated` | `{ SL-26-7, 140, 0 }` | 400 / 300                                 | Against #6; delta = 30                      |

- **#1** lands before any 2027 SL exists. B and D are already in the set, with January 2027 export dates, but
  credit nothing until their OSR dates are added. Had the 2027 accreditation not yet been approved, the sweep
  would write this event on the first deploy after approval. The same 2026 submission writes to the 2026 stream
  as usual, where A credits nothing because it is `OUTSIDE_ACCREDITATION_PERIOD`.
- **#2** credits only the 2027 SL's own rows. Its reconcile appends nothing, because the latest
  `carry-forward-updated` event (#1) already has the current source SL, SL-26-3, and the same totals. The
  prior-year receipt rule keeps A and B out of the 2027 SL.
- **#3** draws on the pooled balance without reference to where the tonnage came from.
- **#4** is a correction to a non-continuation field, so it is only possible before the post-deadline lock.
- **#5** and **#8** change only continuation fields on cross-year rows, so the post-deadline lock allows them.
  They show a 2026 SL moving the 2027 balance without a 2027 submission.
- **#6** moves nothing: C is refused, so it earns no credit. It is still appended, because it comes from a new
  source SL, and it marks the March 2027 report stale so that the refusal appears there (section 5).
- **#7** shows a 2027 submission leaving carried tonnage alone.

The closing amount of 400 is the 2027 SL's 260 plus the carried 140; the available 300 is that less the 100 t
PERN.

### 5. Reports

2027 report generation reads the 2027 SL's rows plus the set, derived at generation time from the 2026 row
states. `readSubmissionRowStates` already loads one input and `filterRecordsByDateField` places rows by date in
memory, so the existing date filter puts a
carried row's export and repatriation, when dated 2027, in the right 2027 period. Receipt dates are in 2026, so
they never land in a 2027 period, and a carried row's 2026-dated events stay in the 2026 reports only.

A `carry-forward-updated` event is the signal that the set may have changed. `reconcileCarryForward` appends
one for every new source SL, even when the totals are unchanged (a refusal or an export date can change the
reports without changing the credit), and active 2027 reports go stale when it does. Submitted reports follow the resubmission comparison from
PAE-1983 (regenerate, compare with the frozen report, flag only on a difference), which also covers the
Confluence concern that a 2026 OSR-only edit must not flag closed 2026 periods. No carry-forward-specific
resubmission logic is added.

### 6. Validation

**Source-year SL** (the 2026 SL):

- **Continuation-fields-only rule.** In an accredited exporter SL, a 2027 date is accepted only in a
  continuation field, and only on a row received in 2026.
- **No later-year dates.** Reprocessor and registered-only SLs reject any 2027 date. Their later-year events
  (sent on, reprocessed) go in the 2027 SL.
- **Post-deadline lock.** After the annual deadline (per-year configuration, end of February) only
  continuation fields on cross-year rows can change. This extends `row-continuity`. Those fields stay editable
  until the target accreditation's year ends.

**Target-year SL** (the 2027 SL):

- **Prior-year receipt rule.** Reject accredited exporter rows whose `DATE_RECEIVED_FOR_EXPORT` is before the
  2027 accreditation starts. Without this, a load "received 2026, exported and received overseas 2027" has both
  balance dates inside the 2027 window, so it would be credited from the 2027 SL **and** carried from the 2026
  SL.

### 7. Frontend

The 2026 check page shows "N loads count towards 2027 (X tonnes)", derived at validation from the uploaded file's rows and stored on the SL alongside `loads`. N and X
count only the members that earn credit, not the whole set. The 2027 waste balance shows a "carried in from
2026" line.

### Scope

Accredited exporters only. For reprocessors, sent-on waste is recorded independently of the received load
(28 September notes), so every later-year event goes in the later-year SL and nothing needs carrying.
Registered-only operators have no waste balance.

A source row whose target year has no accreditation is not carried: there is no target stream to credit.

### Amendment to ADR-0048

ADR-0048 Part 1 says each year has "no carry-over of rows, balance or continuity obligations across a year
boundary". This ADR keeps the part about continuity obligations and SL identity: a new year's SL still starts
fresh, and nothing crosses between SLs. It adds one exception for **balance and report inputs**: the
carry-forward set is the only route by which a prior-year row affects a later year's balance or reports.

## What changes for operators

Every option on the [Confluence page](https://eaflood.atlassian.net/wiki/spaces/MWR/pages/6605047784) changes
how operators use their summary logs; none of them leaves today's "one file per year, closed at the deadline"
untouched. This is what idea 2 asks of an accredited exporter, so it can be compared with the others.

- **Two summary logs in use at once.** From 1 January 2027 the operator keeps the 2026 SL open alongside the
  2027 one. They go back to the 2026 file to complete loads received in 2026 (the export date, the date received
  overseas, and any refusal or repatriation) and resubmit it each time. This can go on for the whole of 2027.
- **Loads received in 2026 never go in the 2027 SL.** The 2027 SL rejects them, even if exported in 2027. This
  replaces the 28 September guidance that the 2027 SL can include 2026-dated rows.
- **Tonnage reaches the 2027 balance only when the 2026 SL is resubmitted.** The load then shows as "carried in
  from 2026" on the 2027 balance, and cannot back a PERN before that. The 2026 check page says how many loads,
  and how many tonnes, will count towards 2027 before the operator submits.
- **A 2026 resubmission can reopen 2027 reports.** If it changes what a 2027 report would contain, that report
  goes stale or, if already submitted, needs resubmitting. Operators may be asked to resubmit a 2027 report
  because of an edit to their 2026 file.
- **The 2026 SL mostly locks at the end of February 2027.** After that, only the continuation fields on
  cross-year loads can change. A 2026 load not recorded by then cannot be added through the service.
- **Reprocessors and registered-only operators** cannot put 2027 dates in their 2026 SL. Their 2027 events go
  in the 2027 SL, as today.
- **They need a way to reach the 2026 SL from 1 January 2027** (open question 4), and **guidance** on all of
  the above.

## Alternatives considered

The alternatives to idea 2 itself (manual updates, copying rows into the 2027 SL, referencing 2026 row IDs, a
web form, a virtual 2027 SL) are compared on the
[Confluence page](https://eaflood.atlassian.net/wiki/spaces/MWR/pages/6605047784). The alternatives below are
ways of implementing idea 2.

- **Route each effect to the year its date falls in, from one submission.** A 2026 SL submission would write
  to both the 2026 and 2027 ledgers and make both years' reports stale. Rejected: cross-year logic spreads into
  every reader that PAE-2004 has just isolated, and a 2027 balance change becomes hard to explain because nothing
  on the 2027 stream says where it came from.
- **A year-agnostic event store.** One stream per registration spanning years, with year as a projection.
  Rejected: a rewrite that contradicts ADR-0036, ADR-0037 and ADR-0048.
- **Store the set in a new `carry-forward-rows` collection**, rebuilt on each trigger. Rejected: everything it
  would hold is derivable from row states that are already persisted for every submission, and the audit logs
  and `carry-forward-updated` events already record what was carried and when. A stored copy would add a
  repository, its indexes and a guard against a stale rebuild overwriting a newer one, for no new information.
- **Key the set on `accreditationId` alone**, so it could ship before ADR-0048. Rejected once PAE-2002 and
  PAE-2004 were in flight: the set is derived per target stream, keyed like every other stream.
- **Trigger on 2027 accreditation approval.** Rejected in favour of SL submit plus the sweep: every change to
  the set comes from an SL submission, which already writes to the ledger and marks reports stale. It also avoids
  coupling to the admin approval workflow, and the sweep corrects anything a trigger missed.
- **Fold carried credit into the 2027 `summary-log-submitted` `creditTotal`.** Rejected: a 2026 resubmission
  must move the 2027 balance without waiting for a 2027 SL submission.
- **Remove duplicates between the 2027 SL and the set, rather than the prior-year receipt rule.** Rejected:
  a row in one SL shares no identifier with a row in another, so matching would be fuzzy. Silently ignoring
  the 2027 rows was also rejected, because the operator gets no feedback.

## Consequences

### Positive

- The tonnage lands in exactly one year's balance, the one the business rules name.
- One explicit, auditable crossing point. Each stream still reads only its own inputs, and the 2027 balance
  explains itself: "carried in from 2026".
- The source row is entered once, and the 2026 SL remains the complete statutory record for that load.
- Builds on existing machinery: the ADR-0036 delta rule, the ADR-0049 resolver, the ADR-0047 sweep and the
  PAE-1983 comparison.

### Negative

- Operators work with two summary logs at once for most of 2027, and a change to one year's file can affect the
  other year's reports (see "What changes for operators").
- A new event kind, a sweep and four validation rules, all to handle a small number of rows
  each year.
- The 2026 SL stays open for continuation fields for a full further year, so "the 2026 SL is closed" is no
  longer a single date.
- With the prior-year receipt rule and the post-deadline lock together, a 2026 load not recorded before the
  deadline cannot be added through the service at all (open question 2).
- A trigger failure is only corrected at the next deploy until a scheduled reconcile exists.
- The resolver must support a two-accreditation check for carried rows alongside the single-accreditation
  check it uses today.

### Dependencies

- PAE-2002: SL year and stream routes and identity.
- PAE-2004: year scoping of row state, row history and the ledger, and classification against the SL's own
  year's accreditation.
- PAE-1983: resubmission only when the report data changes.
- PAE-1884: overseas-site approval per accreditation year, on both dates.
- PAE-1691 and PAE-1998: a way for the operator to reach the prior-year SL by 1 January 2027.
- Report staleness and `assertNoReportSubmittedSinceCreation` scoped by year and stream, which PAE-2004 leaves
  out (tracked separately).

### Rollout

The carry-forward set, triggers, sweep, ledger event, report inputs, the post-deadline lock and the frontend
ship behind one feature flag ([ADR-0045](./0045-feature-flag-mechanism-across-epr-services.md)). The other three
validation rules do not. All of it is needed by 1 January 2027, except the post-deadline lock, which is needed
by the end of February 2027.

## Out of scope

- Accredited exporter reports never showing repatriated or refused tonnage (the field mapping in
  `fields-by-operator-category.js`). A related, pre-existing gap, tracked separately.
- A status change between years in either direction (accredited to registered-only, or the reverse), beyond the
  rule that nothing is carried without a target accreditation.

## Open questions

1. **Business: the four departures.** Does the business accept the departures from its 28 September notes set
   out in "Where this departs from the 28 September notes"? This ADR stands or falls on the answer; the
   remaining questions only matter if it is yes.
2. **Business: late 2026 loads.** A 2026 load not recorded before the deadline cannot be added through the service. Is a
   support or regulator process acceptable for these?
3. **Business: December.** Confirm the ADR-0049 reading: a load exported in December 2026 and received overseas
   in January 2027 is 2027 general-pool tonnage, not December waste.
4. **Rob: prior-year entry point.** A prior-year SL entry point by 1 January 2027 without waiting for PAE-1691, for example an
   extra "2026 summary log" link on Select material.
5. **Rob: the 2026 link after February.** After February, show the 2026 link only to exporters with incomplete cross-year rows.
6. **Business: the PRN/PERN issued column.** What does `WERE_PRN_OR_PERN_ISSUED_ON_THIS_WASTE` mean for an
   accredited operator, now that PERNs are raised in the service against a pooled balance? This ADR assumes it
   records notes issued outside the service, and so never needs changing in the target year.

## Related

- [ADR-0048](./0048-dual-multi-year-summary-logs.md): the year and stream scoping this ADR amends.
- [ADR-0036](./0036-event-sourced-waste-balance-stream.md): the event stream and delta rule the new event kind
  follows.
- [ADR-0047](./0047-reconcile-stale-prn-projections.md): the startup sweep pattern.
- [ADR-0049](./0049-december-waste-prns.md): December pool, and the resolver that buckets on the OSR date.
- [ADR-0039](./0039-report-resubmission-for-closed-periods.md) and
  [ADR-0043](./0043-operator-initiated-report-resubmission.md): report resubmission.
- Confluence: [How to record and handle loads that cross the year boundary](https://eaflood.atlassian.net/wiki/spaces/MWR/pages/6605047784),
  including the ideas table and the alternatives to idea 2.
- Jira: [PAE-2012](https://eaflood.atlassian.net/browse/PAE-2012) (epic),
  [PAE-1690](https://eaflood.atlassian.net/browse/PAE-1690)
