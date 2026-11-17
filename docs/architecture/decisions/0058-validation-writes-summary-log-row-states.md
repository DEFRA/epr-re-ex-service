# 58. Validation writes summary-log row states

Date: 2026-11-17

## Status

Proposed

| ADR                                                    | Title                                  | Relationship                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [0037](0037-summary-log-row-states-with-membership.md) | Summary-log row states with membership | Extends: keeps the row-state model, the immutability rules and the commit point; moves the row-state write from submission to validation. |
| [0036](0036-event-sourced-waste-balance-stream.md)     | Event-sourced waste balance stream     | Unchanged: the `summary-log-submitted` event append remains the commit point, with the same payload.                                      |
| [0049](0049-december-waste-prns.md)                    | December-waste PRNs                    | Unchanged: `decemberCreditTotal` is computed by the same calculation, now at validation.                                                  |

## Context

Validation and submission each read the uploaded workbook from S3 and build its rows independently. Validation extracts the file, runs the row pipeline, classifies every row against the registration's context, shows the operator the result on the check page, and then keeps only the summary (`loads`, `loadsByReportingPeriod`). Submission extracts the same file again, rebuilds the rows with its own preparation code, re-reads the accreditation and overseas sites, and classifies again.

Two pipelines that must agree is a standing hazard: anything validation decides about a row (filtering, outcome, coercion, template choice) has to be mirrored in submission, or the rows saved at submission silently differ from what the operator confirmed on the check page. The drift has already started. Submission's row preparation marks every row `INCLUDED` regardless of what validation decided, because nothing carries validation's decision across.

The context can drift too. Classification reads the accreditation and overseas-site approval state. Submission re-reads both, so if a site is approved or an accreditation changes between the check page and the submit button, the operator commits a reading they never saw.

[ADR-0037](./0037-summary-log-row-states-with-membership.md) makes a single pipeline possible. Row-state documents are immutable, membership arrays only grow, and a row state tagged with a `summaryLogId` that has no `summary-log-submitted` event is inert: no row-state read ever queries for it. Writing row states before the commit is therefore already safe. ADR-0037 places that write at submission only because submission was where rows were built.

## Decision

### Validation writes the row states

When validation's outcome is `VALIDATED`, it writes the summary log's row states and memberships using exactly the rows, table schemas and classification context it used to build the check page. It does this **before** transitioning the summary log to `VALIDATED`, so a log can never be submittable without its row states. The write is the same idempotent upsert ADR-0037 defines, keyed by row identity, content and classification, so a queue retry of validation re-applies as a no-op.

An `INVALID` outcome writes nothing. Invalid logs cannot be submitted, so their row states would be inert from the start.

### Validation's reading is what is committed

The classification stamped on each row state is the one validation computed, against the context as validation read it. A change to accreditation or overseas-site approval between validation and submission does not alter what this submission commits; it takes effect at the operator's next submission, when that upload's validation re-reads the context. This is ADR-0037's rule that "context changes commit nothing by themselves", applied to the window between validation and submission. It also means the operator commits exactly what the check page showed them.

### Totals and counts are saved on the summary log

Alongside `loads`, validation saves on the summary log everything submission needs in order to commit without the rows:

- **`creditTotal` and `decemberCreditTotal`**: the event payload, computed by the same calculation the submission path uses today.
- **Metric counts**: `created`, `updated` and `decemberWasteRowCount`, compared against the registration's latest submitted summary log.

The counts stay true at submission because of the existing staleness guard. Validation records the baseline it compared against (`validatedAgainstSummaryLogId`), and a log whose baseline is no longer the latest submitted log is superseded before submission is queued.

### Submission appends the event and nothing else

Submission no longer reads the workbook and no longer builds rows. It:

1. Loads the summary log and asserts it is `SUBMITTING`.
2. Asserts no report has been submitted since the log was created (unchanged).
3. Appends the `summary-log-submitted` event from the saved totals: the accredited case with its credit and audit as today, the registered-only case with a zero-delta event, and no event for an accredited log with no rows.
4. Transitions the log to `SUBMITTED` and records metrics from the saved counts.

The commit point, the event payload and the handling of slot conflicts are unchanged.

### Write ordering

ADR-0037's write ordering splits across the two stages:

| Stage      | Step | Write                                             | On failure                                                                         |
| ---------- | ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Validation | 1    | Upsert row states and memberships (idempotent)    | Balance and row-state reads unchanged; partial memberships are inert; retry safe   |
| Validation | 2    | Save totals and counts; transition to `VALIDATED` | Log not submittable; memberships from step 1 stay inert                            |
| Submission | 1    | Append `summary-log-submitted` event (commit)     | Balance and row-state reads unchanged; memberships stay inert; operator re-submits |
| Submission | 2    | Transition to `SUBMITTED`                         | Event is committed; the log's status lags, as it can today                         |

### Inert memberships are routine

Under ADR-0037, inert memberships arise only from failed submissions. Under this decision they arise from every upload that validates but is never submitted, which is an ordinary operator journey: upload, look at the check page, fix the spreadsheet, upload again. That is expected and harmless, because row-state reads only ever query for ids on the stream.

#### Worked example

A registration's latest submission is `sl-2026-04`, with rows `EX-001` and `EX-002`. The operator uploads `sl-2026-05a`: `EX-001` unchanged, `EX-002` with a corrected tonnage. Validation writes:

- `EX-001`: content and reading unchanged, so `$addToSet "sl-2026-05a"` onto the existing April document.
- `EX-002`: changed, so a new state document with membership `["sl-2026-05a"]`. The April document is untouched.

The operator spots a typo on the check page and abandons `sl-2026-05a`. They upload `sl-2026-05b` with the typo fixed in `EX-002`, and submit it. Validation of `sl-2026-05b` writes:

- `EX-001`: `$addToSet "sl-2026-05b"`, so its membership is now `["sl-2026-04", "sl-2026-05a", "sl-2026-05b"]`.
- `EX-002`: another new state document, with membership `["sl-2026-05b"]`.

Submission appends the event naming `sl-2026-05b`. The latest submitted log's row state is `find({ summaryLogIds: "sl-2026-05b" })`, which returns `EX-001` and the newest `EX-002`. The abandoned upload has left one `EX-002` document and one entry on `EX-001`'s membership array, and neither is read by anything: no event names `sl-2026-05a`. The credited tonnage, the CSV export and the balance are as if the abandoned upload never happened.

### Rollout

A summary log validated before this change has no saved totals. If one reaches submission after deployment, it is superseded rather than submitted, and the operator re-uploads. There is no fallback that reads the workbook at submission: keeping one would preserve the second pipeline this decision removes.

## Considered alternatives

**Keep reading the workbook at submission and mirror validation's decisions (status quo).** Every row-level decision validation makes needs a matching change in submission, and nothing fails when one is missed. The rows simply differ from what the operator confirmed, as the hardcoded `INCLUDED` outcome already shows. Rejected because it makes the hazard permanent.

**Stage rows at validation in a separate collection and promote them at submission.** This keeps unsubmitted rows out of the row-state collection, but adds a second store, a copy on the commit path and a clean-up job for abandoned staging. ADR-0037's inert memberships already make uncommitted writes invisible, so staging adds machinery for an isolation the model already provides.

**Re-run validation at submission.** Submission would call the validation pipeline rather than its own, which removes the duplicated code. It still reads the workbook twice and still re-reads the context, so the committed reading can still differ from the check page. Rejected because it removes the duplicated code without fixing the second reading.

**Store the rows on the summary-log document.** A large summary log's rows run to tens of megabytes, which Mongo's 16MB document limit rules out, for the same reason ADR-0037 rejects inlining rows in the event payload.

## Consequences

### Positive

- **One row pipeline.** Rows are built, coerced and classified once. A change to how validation treats a row reaches the saved rows with no mirroring in submission.
- **The operator commits what they confirmed.** The check page and the committed row states share one reading of the workbook and one reading of the context.
- **Submission no longer reads the file.** It loses the extractor and organisation-read dependencies, does no S3 read or xlsx parse, and becomes an event append and a status change.

### Negative

- **Inert data grows faster.** Every validated-but-unsubmitted upload leaves memberships and, for changed rows, documents. ADR-0037 already notes that a sweep belongs to operational hygiene; this makes that sweep more likely to be needed.
- **Validation does more work.** The row-state bulk write moves onto the validation path, lengthening validation by roughly what it shortens submission.
- **Context changes wait one more cycle.** An overseas site approved after validation counts from the operator's next submission, not this one. This matches ADR-0037's rule, but an operator who submits immediately after an approval may expect otherwise.
- **In-flight logs are lost at deployment.** Logs validated but not yet submitted when the change ships are superseded, and their operators must re-upload.

## Related

- [ADR-0037](./0037-summary-log-row-states-with-membership.md): the row-state model this ADR extends
- [ADR-0036](./0036-event-sourced-waste-balance-stream.md): the stream whose commit point is unchanged
- [ADR-0049](./0049-december-waste-prns.md): `decemberCreditTotal`, now computed at validation
