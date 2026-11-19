# 58. Validation writes summary-log row states

Date: 2026-11-17

## Status

Accepted. Extends [ADR-0037](./0037-summary-log-row-states-with-membership.md).

| ADR                                                    | Title                                  | Relationship                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [0037](0037-summary-log-row-states-with-membership.md) | Summary-log row states with membership | Extends: keeps the row-state model, the immutability rules and the commit point; moves the row-state write from submission to validation. |
| [0036](0036-event-sourced-waste-balance-stream.md)     | Event-sourced waste balance stream     | Unchanged: the `summary-log-submitted` event append remains the commit point, with the same payload.                                      |
| [0049](0049-december-waste-prns.md)                    | December-waste PRNs                    | Unchanged: `decemberCreditTotal` is computed by the same calculation, now at validation.                                                  |

## Context

Validation and submission each read the uploaded workbook from S3 and build its rows independently. Validation extracts the file, runs the row pipeline, classifies every row against the registration's context, shows the operator the result on the check page, and then keeps only the summary (`loads`, `loadsByReportingPeriod`). Submission extracts the same file again, rebuilds the rows with its own preparation code, re-reads the accreditation and overseas sites, and classifies again.

Two pipelines that must agree is a standing hazard: anything validation decides about a row (filtering, outcome, coercion, template choice) has to be mirrored in submission, or the rows saved at submission silently differ from what the operator confirmed on the check page.

The context can drift too. Classification reads the accreditation and overseas-site approval state. Submission re-reads both, so if a site is approved or an accreditation changes between the check page and the submit button, the operator commits a reading they never saw.

[ADR-0037](./0037-summary-log-row-states-with-membership.md) makes a single pipeline possible. Row-state documents are immutable, membership arrays only grow, and a row state tagged with a `summaryLogId` that has no `summary-log-submitted` event is inert. Writing row states before the commit is therefore already safe. ADR-0037 places that write at submission only because submission was where rows were built.

## Decision

### Validation writes the row states

When validation ends in an outcome from which the summary log can be submitted (today, `VALIDATED`), it writes the summary log's row states and memberships using exactly the rows, table schemas and classification context it used to build the check page. It does this **before** that status transition, so a log can never be submittable without its row states. The write is ADR-0037's upsert.

An outcome from which the log cannot be submitted (today, `INVALID`) writes nothing: those row states would be inert from the start.

A retry is not a no-op if the context changed in between. The upsert key includes the classification, so a retry that reads a newly approved overseas site would insert a second state for the same row under the same `summaryLogId`, and the log's rows would no longer reproduce its credit. So if any row state already carries the summary log's id, validation fails permanently and the operator re-uploads. One state per row per membership is an invariant for contract tests.

### Context changes supersede the log

The classification stamped on each row state is the one validation computed, against the context as validation read it. A validated log can wait up to a week (its time-to-live) before submission, and the context can change in that time: an overseas site revoked after validation would otherwise be committed as included and credit the balance until the operator's next submission.

So validation saves a hash of the classification context, taken from the context object exactly as it is passed to classification (not the accreditation and overseas-site documents, so unrelated edits do not count as a change), with stable serialisation. Submission reads the context again from the organisation read model, hashes it, and supersedes the log if the hashes differ, through the same path as the rollout. The submit route runs the same check before it queues the submission, so most such logs are turned away there; the worker's check catches a change between queueing and processing. Only the context is hashed: the workbook does not change, and the baseline check already catches a newer submission.

A committed reading therefore always matches both the check page and the context current at the commit, as ADR-0037 requires. A withdrawn accreditation changes the hash too, so submission still refuses a log whose accreditation no longer stands.

### The commit is saved on the summary log

Alongside `loads`, validation saves on the summary log everything submission needs in order to commit without the rows:

- **The context hash**: as above.
- **The event payload**: the ADR-0036 `summary-log-submitted` payload without `summaryLogId`, computed by the same calculation the submission path uses today. It is saved as one object whose schema is the ledger's payload schema, with every field present (a zero rather than an absent field), so a log saved before a new payload field is added fails the schema rather than reading the missing field as zero.
- **Metric counts**: `created`, `updated` and `decemberWasteRowCount`, compared against the registration's latest submitted summary log.

The counts stay true at submission because of the existing staleness guard. The baseline (`validatedAgainstSummaryLogId`) is recorded when the upload completes, and submission supersedes a log if a newer log has been submitted since. Other ledger events (the PRN events) do not affect either saved value: the payload carries absolute totals and submission computes the balance delta from the ledger as it stands at the append. If commits other than submissions that restate memberships are introduced (ADR-0037), the staleness check moves to the ledger, comparing the latest membership commit with the one validation saw.

### Submission appends the event and nothing else

Submission no longer reads the workbook and no longer builds rows. It:

1. Loads the summary log and asserts it is `SUBMITTING`.
2. Asserts no report has been submitted since the log was created (unchanged).
3. Supersedes the log if a newer log has been submitted since its baseline, its saved commit is missing or fails its schema, or the classification context's hash no longer matches the saved one.
4. Appends the `summary-log-submitted` event from the saved payload: accredited logs with their credit and audit as today, registered-only logs with a zero-delta event per ADR-0037.
5. Transitions the log to `SUBMITTED` and records metrics from the saved counts.

Every submission now appends an event. An accredited first submission with no rows, which today appends nothing, gets a zero-delta event, as ADR-0037 requires of every submission. The event payload and the handling of slot conflicts are otherwise unchanged.

### Write ordering

This replaces ADR-0037's write ordering, split across the two stages:

| Stage      | Step | Write                                                                | On failure                                                                                     |
| ---------- | ---- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Validation | 1    | Upsert row states and memberships                                    | Balance and row-state reads unchanged; memberships are inert; retry fails, operator re-uploads |
| Validation | 2    | Save the context hash, payload and counts; transition to `VALIDATED` | Log not submittable; memberships from step 1 stay inert                                        |
| Submission | 1    | Append `summary-log-submitted` event (commit)                        | Balance and row-state reads unchanged; memberships stay inert; operator re-submits             |
| Submission | 2    | Transition to `SUBMITTED`                                            | Event is committed; the log's status lags, as it can today                                     |

### Inert memberships are routine

Under ADR-0037, inert memberships arise only from failed submissions. Under this decision they arise from every upload that validates but is never submitted, which is an ordinary operator journey: upload, look at the check page, fix the spreadsheet, upload again. That is expected and harmless provided every row-state read is scoped to ids on the stream.

One read is not yet scoped: the admin CSV export builds its columns from every row state in the year, so an extra column in an abandoned upload would appear in the export. Scoping it to submitted summary logs ([PAE-2291](https://eaflood.atlassian.net/browse/PAE-2291)) is a precondition of this decision.

#### Worked example

A registration's latest submission is `sl-2026-04`, with rows `EX-001` and `EX-002`. The operator uploads `sl-2026-05a`: `EX-001` unchanged, `EX-002` with a corrected tonnage. Validation writes:

- `EX-001`: content and reading unchanged, so `$addToSet "sl-2026-05a"` onto the existing April document.
- `EX-002`: changed, so a new state document with membership `["sl-2026-05a"]`. The April document is untouched.

The operator spots a typo on the check page and abandons `sl-2026-05a`. They upload `sl-2026-05b` with the typo fixed in `EX-002`, and submit it. Validation of `sl-2026-05b` writes:

- `EX-001`: `$addToSet "sl-2026-05b"`, so its membership is now `["sl-2026-04", "sl-2026-05a", "sl-2026-05b"]`.
- `EX-002`: another new state document, with membership `["sl-2026-05b"]`.

Submission appends the event naming `sl-2026-05b`. The latest submitted log's row state is `find({ summaryLogIds: "sl-2026-05b" })`, which returns `EX-001` and the newest `EX-002`. The abandoned upload has left one `EX-002` document and one entry on `EX-001`'s membership array, and neither is read by anything: no event names `sl-2026-05a`. The credited tonnage, the CSV export and the balance are as if the abandoned upload never happened.

### Rollout

A summary log validated before this change has no saved payload. Both the submit route (before queueing) and the submission worker (for logs already submitting or queued at deployment) supersede a log whose saved payload or context hash is missing or fails its schema, and the route answers with its existing conflict response. The frontend shows that as its upload-conflict page, which tells the operator to upload the summary log again; its introduction describes a newer upload, which is not the cause here, and is left unchanged given the week-long exposure. Exposure is bounded by the week a validated log lives. There is no fallback that reads the workbook at submission: keeping one would preserve the second pipeline this decision removes.

## Considered alternatives

**Keep reading the workbook at submission and mirror validation's decisions (status quo).** Every row-level decision validation makes needs a matching change in submission, and nothing fails when one is missed: the rows simply differ from what the operator confirmed. Rejected because it makes the hazard permanent.

**Stage rows at validation in a separate collection and promote them at submission.** This keeps unsubmitted rows out of the row-state collection, but adds a second store, a copy on the commit path and a clean-up job for abandoned staging. ADR-0037's inert memberships already make uncommitted writes invisible, so staging adds machinery for an isolation the model already provides.

**Re-run validation at submission.** Submission would call the validation pipeline rather than its own, which removes the duplicated code. It still reads the workbook twice and still re-reads the context, so the committed reading can still differ from the check page. Rejected because it removes the duplicated code without fixing the second reading.

**On retry, remove the log's id from every row state and rewrite.** The id is uncommitted and the log is still validating, so removing it is invisible to every read, and a transient failure would no longer force a re-upload. It needs ADR-0037's rule narrowed to "memberships of committed ids only grow". Rejected because the commands queue delivers at least once and a slow validation can outlast the visibility timeout, so two attempts can overlap: one can remove the other's ids just before the other transitions to `VALIDATED`, leaving the log submittable with partial rows. Making that safe needs a fence (each attempt claims the log by version, then checks before the transition that it still owns the log and that the tagged row states are exactly its own), which is real complexity to avoid a re-upload after a narrow transient failure. Failing permanently errs the safe way: the worst case is a re-upload, never a wrong commit.

**Commit validation's reading regardless of later context changes.** Simpler: submission would not read the organisation read model at all. Rejected because a site revoked between validation and submission would be committed as included and credit the balance, and PRNs could be issued against that credit, until the operator's next submission.

**Store the rows on the summary-log document.** A large summary log's rows run to tens of megabytes, which Mongo's 16MB document limit rules out, for the same reason ADR-0037 rejects inlining rows in the event payload.

## Consequences

### Positive

- **One row pipeline.** Rows are built, coerced and classified once. A change to how validation treats a row reaches the saved rows with no mirroring in submission.
- **The operator commits what they confirmed.** The check page and the committed row states share one reading of the workbook and one reading of the context.
- **Submission no longer reads the file.** It loses the extractor, does no S3 read or xlsx parse, and becomes a context check, an event append and a status change.

### Negative

- **Inert data grows faster.** Every validated-but-unsubmitted upload leaves memberships and, for changed rows, documents. ADR-0037 already notes that a sweep belongs to operational hygiene; this makes that sweep more likely to be needed.
- **Validation does more work.** The row-state bulk write moves onto the validation path, lengthening validation by roughly what it shortens submission.
- **Any context change forces a re-upload.** A change between validation and submission supersedes the log, even one that would not have changed any row's classification.
- **A retry after the row write fails permanently.** Any failure between writing row states and the transition to `VALIDATED` sends the operator back to re-upload, whether or not the context changed.
- **In-flight logs are lost at deployment.** Logs validated but not yet submitted when the change ships are superseded, and their operators must re-upload.

## Out of scope

- **Cross-year links.** A later year's rows that take values from an earlier year's rows, and an earlier-year submission that has to reach a later year's balance, are decided separately under [PAE-2282](https://eaflood.atlassian.net/browse/PAE-2282). This ADR covers single-year submission only: its staleness check is per year, so an earlier-year resubmission does not supersede a later-year log already validated against the earlier values.

## Related

- [ADR-0037](./0037-summary-log-row-states-with-membership.md): the row-state model this ADR extends
- [ADR-0036](./0036-event-sourced-waste-balance-stream.md): the stream whose commit point is unchanged
- [ADR-0049](./0049-december-waste-prns.md): `decemberCreditTotal`, now computed at validation
