# 38. Report resubmission for closed periods

Date: 2026-06-23

## Status

Accepted.

## Context

A reporting period is "closed" the moment a report for it has been submitted. There is no separate calendar flag: closure is derived from submission state. `buildSubmittedPeriods` already treats a period as closed when its current report is `submitted` or when it has any `previousSubmissions`.

Two domain facts collide to create the problem this ADR addresses:

1. **Cumulative restatement.** Every summary log restates all loads to date (see [ADR-0037](./0037-committed-row-states-with-summary-log-membership.md)). A summary log uploaded in, say, May can therefore contain loads dated into February, a period whose report was already submitted in March.
2. **Closure is irreversible through the normal flow.** The report lifecycle is strictly linear and terminal at `submitted`: `in_progress -> ready_to_submit -> submitted`, with no forward edge out of `submitted` (`report-transitions.js`). Reports are frozen once submitted: PATCH is blocked, DELETE is blocked.

So when a later summary log restates loads into an already-submitted period, the submitted report no longer reflects the operator's own data, and there is currently no route to correct it. Today this is doubly blocked: the route schema pins `submissionNumber` to `valid(1)` (`reports/routes/shared.js`), and the API enforces effectively one report per period.

The operator needs to be able to file a **further submission** for a closed period: a second report that sits alongside the original and runs the same submission flow. The question this ADR settles is how much new modelling that requires. The tempting answers, new report statuses or a period-level state machine, turn out to be unnecessary, because the schema was already built anticipating this:

- Reports are keyed by `(organisationId, registrationId, year, cadence, period, submissionNumber)`, and `submissionNumber` defaults to 1.
- The periodic-report read view already groups a period's reports into `current` (highest `submissionNumber`) plus `previousSubmissions[]`.
- The partial unique index `reports_one_active_draft_per_period` forbids two _active_ drafts per period but excludes `submitted` reports, so a fresh draft can legally coexist with a submitted one.
- `classifyByPeriodStatus` already detects and labels loads that fall in a closed period (`closedPeriodLoads`).

The only things actively preventing a second submission are the `valid(1)` route guard and the absence of any trigger to start the correction.

## Decision

Model a resubmission as **another report for the same period at the next `submissionNumber`, running the existing unchanged lifecycle.** Add no new report status and no period-level state machine. Add exactly one stored field (a flag, not a lifecycle state) to drive the operator prompt, and create the correction draft lazily when the operator acts.

### State model: reuse the simple flow

Submission 2 is an ordinary report document with `submissionNumber = 2`, moving through the same `in_progress -> ready_to_submit -> submitted` flow, gated by the same completeness check. `report-status.js` and `report-transitions.js` are untouched.

Everything needed to distinguish a correction is derivable from `(currentStatus, submissionNumber)` plus the flag below. Where that derivation runs, in each frontend or surfaced ready-made from this service, is left open (see [Consequences](#consequences)); either way the same inputs produce the same labels. The two-list "Action required" / "Submitted" presentation, including a period appearing in _both_ lists mid-correction, falls straight out of the existing `current` / `previousSubmissions` split:

| Derived label         | Derivation                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| Ready to submit       | `currentStatus = ready_to_submit`                                          |
| Requires resubmission | latest submitted report carries the resubmission flag, no active draft yet |
| Submitted             | latest submitted report, `submissionNumber = 1`                            |
| Resubmitted           | latest submitted report, `submissionNumber > 1`                            |

"Requires resubmission" and "Resubmitted" are therefore **presentation labels, not stored states.** When submission 2 is submitted, it becomes the period's latest submitted report and the same `submissionNumber > 1` rule re-derives its label as "Resubmitted". No data is rewritten; the labels simply re-derive. This holds regardless of whether the derivation runs in the frontend or in this service.

### The `resubmissionRequired` flag, kept separate from `stale`

Detection memoises its result as one new field on the submitted report:

```
resubmissionRequired: { uploadedAt, summaryLogId, reason }
```

This deliberately mirrors the shape of the existing `stale` field (`{ uploadedAt, reason, summaryLogId }`) and keeps a `reason` discriminator for symmetry, but it is a **separate field with separate semantics.** It is not an overload of `stale`, because the two point in opposite directions on every axis:

| Axis        | `stale` (existing)                                      | `resubmissionRequired` (new)                    |
| ----------- | ------------------------------------------------------- | ----------------------------------------------- |
| Applies to  | active drafts only (`in_progress`, `ready_to_submit`)   | `submitted` reports only                        |
| Intent      | **blocks** an action ("do not submit out-of-date data") | **invites** an action ("file a new submission") |
| Enforced by | `assertNotStale` gates PATCH and submit                 | surfaced in the read view, drives a CTA         |
| Resolution  | refresh the _same_ report                               | create a _new_ report (submission 2)            |
| Lifecycle   | never cleared (gate ignores submitted)                  | naturally superseded, never explicitly cleared  |

Reusing `stale` would require inverting its core invariant (`markActiveReportsStale` would have to touch submitted reports, contradicting its name and its contract test "does not touch submitted reports") and loading status-dependent meaning onto a single field so that `assertNotStale` sometimes blocks and sometimes prompts. They are two faces of one detection (a summary log changed the data), so they share a trigger and a provenance shape, but they remain distinct fields.

### Detection sets the flag; it does not auto-create a draft

In `onSummaryLogUploaded`, alongside `markActiveReportsStale`, add a sibling repository operation `markSubmittedReportsRequiringResubmission`. Using `classifyByPeriodStatus`'s `closedPeriodLoads`, it finds the closed periods that received loads from this summary log and sets `resubmissionRequired` on each such period's **latest submitted report.**

Idempotency mirrors `stale`: skip a report whose `resubmissionRequired.summaryLogId` already equals this summary log's id, or whose `source.summaryLogId` equals it (the report was itself produced from this log). Setting a flag is naturally idempotent, which avoids the "do not spawn submission 3" guarding that an auto-create approach would need against the one-active-draft index.

The flag is set on, and only ever read on, the **latest submitted report.** No explicit clearing is needed: once submission 2 is submitted it becomes the latest submitted report and carries no flag, so the action disappears; the flag left on submission 1 becomes an ignored historical artefact on a `previousSubmissions` entry.

### Lazy create on the operator's action

The "create draft" call reuses the existing `POST .../reports/{...}` path (`createReportForPeriod`). Its guards already fit: `assertPeriodEnded` passes (the period is closed, so it has ended), and `assertNoExistingReport` is keyed by `submissionNumber`. The **backend assigns** `submissionNumber = latest + 1` rather than trusting the client, so concurrent attempts cannot collide on a client-chosen number. Submission 2 is built by full re-aggregation of the period (consistent with cumulative restatement: the latest submission is the complete restated truth for the period, and downstream reads it via the `current` pointer).

Because the draft is operator-initiated at this point, `created.by` and `submitted.by` are both the real operator. No system actor is needed; that question only arose under the rejected auto-create alternative.

The route guard `submissionNumber: Joi...valid(1)` in `reports/routes/shared.js` is relaxed to `min(1)` so that GET / PATCH / status / DELETE can address submission 2.

### Reading: precedence for a period's action status

A period's "action required" status is derived in this precedence order:

1. An active draft exists (`in_progress` or `ready_to_submit` at `submissionNumber > latest submitted`): show the draft's status.
2. Else the latest submitted report carries `resubmissionRequired`: show "Requires resubmission" plus the create CTA.
3. Else: the period is simply submitted, no action.

Rule 1 winning over rule 2 is what prevents "Requires resubmission" and an in-flight draft showing simultaneously.

### Controlled mutation of submitted reports

Setting the flag is the first write to an otherwise-frozen submitted report. It is performed by the dedicated `markSubmittedReportsRequiringResubmission` operation only, in the same spirit as `unsubmit` and `markActiveReportsStale`, never through the patch route (which stays blocked for submitted reports).

## Considered alternatives

**A new report status (for example `correction_in_progress`).** Rejected. The difference between an original and a correction is already carried by `submissionNumber > 1`; a status would be redundant with it and would fork the transition table for no behavioural change, since the flow is genuinely identical.

**A period-level state machine (`OPEN -> SUBMITTED -> REOPENED -> RESUBMITTED`) layered above reports.** Rejected. It stores state that is fully derivable from the report list, introducing a dual source of truth that can drift, and a second state machine to keep consistent with the first. It also conflicts with the current design where period closure is computed from submissions (`buildSubmittedPeriods`), not stored.

**Auto-create the submission-2 draft on detection.** Rejected in favour of the flag. Auto-create produces orphan `in_progress` drafts for operators who never act, needs careful idempotency against the one-active-draft index to avoid spawning further drafts on repeat uploads, snapshots the aggregation at detection time rather than at the latest point, and forces a system actor onto `created.by`. The flag avoids all four: detection is a trivially idempotent field write, the draft exists only once the operator commits, aggregation happens on demand, and the actor is the operator.

**Overload the existing `stale` field for submitted reports.** Rejected. See the table above: opposite scope, opposite intent, different resolution and lifecycle. Overloading would invert `stale`'s active-only invariant and its contract test, and make `assertNotStale` status-dependent.

**Submission 2 as a delta (only the late loads) rather than a full restatement.** Rejected. It would force downstream to sum submissions to recover a period total, against the grain of cumulative restatement and the existing `current`-is-truth read model.

**Derive "requires resubmission" on every read instead of storing a flag.** Rejected. It is computable in principle (compare current loads against the submitted snapshot) but expensive and fuzzy to recompute on every list render. `classifyByPeriodStatus` already computes the answer at upload time, so memoising it as a flag is the natural fit.

## Consequences

### Positive

- **No new lifecycle states.** The report state machine, transition guard, and completeness gate are untouched; a correction reuses the exact flow operators already know.
- **Minimal stored state.** One flag, shaped like its existing sibling, drives the whole operator-facing prompt.
- **Trivially idempotent detection.** Re-uploading the same summary log re-flags nothing.
- **The latest submission is the period's truth** via the existing `current` pointer. This needs no new plumbing at the document-read level, though the period projections built on `mergeReportingPeriods` do need work (see [Impact on reports and consumers](#impact-on-reports-and-consumers)).
- **The operator is the actor** for both creation and submission of the correction; no system identity is introduced.

### Negative

- **Submitted reports are no longer strictly immutable.** A dedicated, narrowly-scoped operation can set the resubmission flag on them. This is controlled mutation analogous to `markActiveReportsStale`, but it does loosen the "submitted reports are frozen" invariant.
- **Two similarly-shaped fields (`stale`, `resubmissionRequired`) coexist** on report documents. Their distinct meaning has to be understood; the symmetry that aids consistency could invite future conflation if not documented (this ADR is that documentation).
- **Where label derivation lives is an open decision.** "Requires resubmission" and "Resubmitted" are computed from `(currentStatus, submissionNumber)` and the flag, but whether that computation runs in each frontend or is surfaced ready-made from this service is not settled here. Deriving in the frontend is the cheapest path to release and fits the existing operator reports list, which already derives a `Due` status the backend never sends and splits periods into "Action required" and "Submitted"; the cost is that the rules then live in both the operator and CMA frontends and must be kept in step with this service. Surfacing the labels from the backend keeps a single source of truth at the cost of additional API surface. The underlying state machine is identical either way.

## Impact on reports and consumers

The report document model is unchanged, so consumers that read a single report by id, or that already read the `current` / `previousSubmissions` split, are unaffected. The period projections built on `mergeReportingPeriods` are not: that helper sets `report: slot.current` for a period _regardless of the current report's status_ (`merge-reporting-periods.js`), so an in-flight submission 2 draft masks the last submitted report.

During a correction the system is briefly inconsistent: `buildSubmittedPeriods` still counts the period as submitted (it checks `current.status === submitted` _or_ any `previousSubmissions`, `submitted-periods.js`), while the `mergeReportingPeriods` projections below report it as unsubmitted, because they read only `current`.

Three reports generated from `epr-backend` inherit this. The fixes are not part of this ADR's backend work and each needs its own ticket.

### Admin registration overview (tracked: PAE-1657)

The regulator's registration-overview screen (`epr-re-ex-admin-frontend`) sources only `GET .../reports/calendar`, which collapses each period to `current` and discards `previousSubmissions`. With more than one submission per period this:

- flips the period from a submitted tag to `in_progress` the moment submission 2 is started, with submission 1 disappearing and no trace or explanation,
- leaves previous submissions unreachable (no submissions list; the report view renders one submission with no submission-number label or navigation),
- never shows the submission number on the unsubmit confirm and result pages.

**Remedial action.** Include a lightweight `submissions[]` summary in the per-period calendar payload, render prior submissions as reachable rows labelled by submission number, and label the number on the report and unsubmit screens (visibility and reachability only). Depends on the `shared.js` `submissionNumber` `valid(1) -> min(1)` relaxation in this ADR's backend work, so per-submission links resolve. Tracked as [PAE-1657](https://eaflood.atlassian.net/browse/PAE-1657).

### Regulator report-submissions feed (tracked: PAE-1659)

`GET /v1/organisations/reports/submissions` (`report-submissions.js`) produces a flat, regulator-facing export with one row per period (regulator, full tonnage breakdown, submitter contacts, submitted date and submitter). Each row is built from `mergeReportingPeriods`, so:

- **Mid-correction regression.** While submission 2 is an `in_progress` draft, `current` is that draft, so the row's tonnage fields and `submittedDate` / `submittedBy` go blank: the period regresses from "submitted with figures" to an empty in-progress row for the duration of the correction.
- **Silent supersession.** Once submission 2 is submitted the row reflects submission 2's figures only; submission 1 is dropped from the export, and there is no submission-number or resubmission column, so a regulator consuming the feed cannot tell a period was resubmitted or recover the original figures.

### Public register (tracked: PAE-1660)

The public register CSV embeds a submitted date per period, sourced from `generateReportCompliance` (`report-compliance.js`), which is likewise built on `mergeReportingPeriods` and reads `current.submittedAt`. While submission 2 is in progress the period's date column blanks (the draft has no `submittedAt`), so the public register transiently shows a previously-submitted period as not submitted, resolving to submission 2's date once submitted. As a public-facing artefact, this transient regression matters more than its private equivalents.

**Remedial action (feed and public register).** A single backend change addresses both: in these projections select the latest _submitted_ report (or expose the latest submitted separately from the latest draft) rather than the unconditional `current`, so an in-flight draft never masks the last submitted figures; then decide whether superseded submissions warrant their own rows or a submission-number column. Tracked as [PAE-1659](https://eaflood.atlassian.net/browse/PAE-1659) (feed) and [PAE-1660](https://eaflood.atlassian.net/browse/PAE-1660) (public register).

### Not affected

`waste-records-export.csv`, `tonnage-monitoring`, `prn-tonnage` (it aggregates the `packaging-recycling-notes` collection) and the summary-log-uploads report do not read submitted report documents.

## Out of scope

- **Label derivation and screens.** The presentation rules, and the choice of where they run (see [Consequences](#consequences)), are owned by the frontend work ([PAE-1649](https://eaflood.atlassian.net/browse/PAE-1649), [PAE-1650](https://eaflood.atlassian.net/browse/PAE-1650), [PAE-1541](https://eaflood.atlassian.net/browse/PAE-1541) and related) and not settled here.
- **Operator-initiated corrections with no late records detected.** This ADR's trigger is detection-driven only.
- **Notifying the operator** that a resubmission is required (email, dashboard alerts).
- **Resubmission of registered-only periods** beyond what the shared flow already covers.

## Related

- [ADR-0028](./0028-reporting-api-and-due-rules.md) - the reporting API, report lifecycle, and due rules this builds on
- [ADR-0037](./0037-committed-row-states-with-summary-log-membership.md) - cumulative restatement, the property that lets a later summary log restate loads into a closed period
- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) - the event-sourced stream that records each summary-log submission
- [PAE-1649](https://eaflood.atlassian.net/browse/PAE-1649) - operator sees reports that require resubmission on the Reports landing page, the most direct consumer of this ADR's label derivation
- [PAE-1650](https://eaflood.atlassian.net/browse/PAE-1650) - operator creates a draft for a report that requires resubmission, the lazy-create CTA this ADR describes
- [PAE-1541](https://eaflood.atlassian.net/browse/PAE-1541) - the CMA check-page resubmission banner that depends on this functionality
- [PAE-1657](https://eaflood.atlassian.net/browse/PAE-1657) - admin registration overview made multi-submission aware (see [Impact on reports and consumers](#impact-on-reports-and-consumers))
- [PAE-1659](https://eaflood.atlassian.net/browse/PAE-1659) - regulator report-submissions feed made multi-submission aware
- [PAE-1660](https://eaflood.atlassian.net/browse/PAE-1660) - public register submitted dates made multi-submission aware
