# 38. Derive report status and state in the backend

Date: 2026-06-25

## Status

Accepted (2026-07-03). Implemented by [PAE-1649](https://eaflood.atlassian.net/browse/PAE-1649) and [PAE-1650](https://eaflood.atlassian.net/browse/PAE-1650) in `epr-backend`. One aspect was revised during implementation, in agreement with the engineers: resubmission is surfaced as a first-class `requires_resubmission` value of `periodStatus`, not modelled structurally with `isResubmission` / `current` booleans as originally proposed. This document describes the contract as shipped.

Amends the derivation stance of [ADR-0028](./0028-reporting-api-and-due-rules.md) (which leaves "due" implicit for the frontend to infer) and supersedes the frontend-derived precedence in the closed-period-adjustments ADR (renumbered to 0039; this ADR takes the lower number because the derivation principle is the foundation that the closed-period work builds on). Neither of those ADRs' **storage** decisions change: there is still no persisted `due` or `overdue` state, and `resubmissionRequired` remains the single stored flag.

## Context

The frontend has accumulated a growing amount of report-state derivation that is genuine domain logic, not presentation:

1. **Due and overdue.** `epr-frontend`'s `deriveSubmissionStatus(endDate, report)` returns `DUE` once a period has ended with no stored report, and [PAE-1331](https://eaflood.atlassian.net/browse/PAE-1331) (DEFRA/epr-frontend#881) extends it to `OVERDUE` once the current date is past the due date. This is a temporal compliance rule computed client-side.
2. **Requires resubmission and resubmitted.** The closed-period-adjustments ADR makes these frontend-derived presentation labels, composed from `(currentStatus, submissionNumber)` plus the stored `resubmissionRequired` flag, with a frontend precedence rule (active draft wins, else latest-submitted flag set means "requires resubmission" plus a create CTA, else "submitted").

There is already more than one client of this data: `epr-frontend` (operator) and `epr-re-ex-admin-frontend` (regulator), with further consumers behind the same calendar and reporting endpoints (the public register and the report-submissions feed). Each client that re-derives these rules is a place the rules can drift. The admin overview, the public register, and the report-submissions feed each independently hit the same problem that the calendar's merge step (`mergeReportingPeriods`) collapses a period to its current submission and discards previous submissions.

The trigger for this ADR was a question on PAE-1331: should an `OVERDUE` status be persisted in the backend (so it can be queried) or derived? That widened into a broader observation that the reporting solution embeds a number of rules in the frontend that are really backend domain state, and a decision to shift them to backend-derived fields so every client shares one source of truth.

## Decision

### Principle

The backend owns derived **domain** state; the frontend owns **presentation**.

- **Derived domain state** is anything computed from regulatory rules, time, or aggregation: lifecycle status (due, overdue), compliance deadlines, resubmission state, and computed totals. These become first-class API fields.
- **Presentation** is tag colour, copy and translation, layout, table shaping, route and URL selection, and which of several real items to surface. These stay per-client.

The test for whether a rule belongs in the backend is whether it is **dangerous to duplicate**: a non-trivial rule that several clients would otherwise each re-implement (the deadline calculation, the restatement-detection that drives a resubmission) belongs in the backend. A trivial, safe predicate (is `submissionNumber > 1`) can stay in the client as presentation.

### Derive on read, do not persist

The backend computes these fields per request from the waste records, the stored report, and the dates. Nothing new is persisted, consistent with ADR-0028 (no `due` status) and the closed-period ADR (no persisted resubmission labels). This avoids background jobs to flip `DUE` to `OVERDUE` at a deadline and avoids the staleness those introduce.

If a concrete querying driver appears (for example "list every overdue operator" for a compliance dashboard), the escape hatch is a materialised, queryable projection refreshed on a schedule. That is deliberately deferred until there is a real need, not built now.

### Contract: additive and submission-grained

The existing `report` object stays frozen as `{ id, status, submissionNumber, submittedAt, submittedBy } | null` with today's meanings, so no client that switches on the stored status or checks `report === null` breaks.

The calendar response from `GET /v1/organisations/{organisationId}/registrations/{registrationId}/reports/calendar` is an object of the shape `{ cadence, reportingPeriods }`. The `reportingPeriods` array becomes **submission-grained**: items are keyed on `(year, period, submissionNumber)`, so a single period can carry more than one item. Each item gains one additive sibling field:

- **`periodStatus`** — a single-axis lifecycle enum: `due | overdue | in_progress | ready_to_submit | submitted | requires_resubmission`. The backend does the date arithmetic (`due` once the period has ended, `overdue` once past the due date) and the resubmission expansion described below.

There are no `isResubmission`, `current` or `superseded` fields. Superseded submissions do not appear in the calendar at all: the backend emits only the items a client should show, so there is nothing for clients to filter. Previous submissions remain available on the report detail view.

```jsonc
// period 1 in resubmission, correction draft in flight: two items for the period.
// Each item also carries startDate, endDate and dueDate (omitted for brevity).
{
  "cadence": "quarterly",
  "reportingPeriods": [
    {
      "year": 2026,
      "period": 1,
      "submissionNumber": 1,
      "periodStatus": "submitted",
      "report": {
        "id": "uuid",
        "status": "submitted",
        "submissionNumber": 1,
        "submittedAt": "...",
        "submittedBy": { "id": "uuid", "name": "..." }
      }
    },

    {
      "year": 2026,
      "period": 1,
      "submissionNumber": 2,
      "periodStatus": "requires_resubmission",
      "report": {
        "id": "uuid",
        "status": "in_progress",
        "submissionNumber": 2,
        "submittedAt": null,
        "submittedBy": null
      }
    }
  ]
}
```

Before the operator starts the correction draft, the second item is a pre-draft skeleton with `report: null`.

### Resubmission is a first-class period status

When detection sets `resubmissionRequired` on a submitted report, the backend expands the period into two items. The flagged report stays visible as `periodStatus: submitted` at its own submission number. A second item at `submissionNumber + 1` carries `periodStatus: requires_resubmission`: its `report` is `null` until the operator starts the correction draft, then carries that draft for the whole of the draft's life. The `periodStatus` stays `requires_resubmission` throughout, so every client keeps the period in its resubmission state and picks the call to action from `report` (`null` means start, `in_progress` means continue, `ready_to_submit` means review and submit). Distinguishing a resubmission from a first draft needs no extra boolean: the status itself says it. The `requires_resubmission` item bypasses the date arithmetic and never becomes `overdue`.

The stored `resubmissionRequired` flag is immutable and never cleared. The calendar derives on read from the **latest submitted** report's flag: once the correction is itself submitted it becomes the latest submitted report (unflagged), so the period collapses back to a single `submitted` item. The stale flag on the now-superseded submission is an ignored historical artefact, which avoids any write-back on submit and any two-document consistency problem.

The frontend's existing active / submitted table partition keeps working unchanged: the `requires_resubmission` item sorts into the active table, the flagged original into the submitted table. Hiding superseded submissions is not a client concern at all, because the backend never emits them.

An earlier revision of this ADR modelled resubmission structurally (a `due` skeleton plus `isResubmission` and `current` booleans) to keep the enum single-axis. Implementation showed the explicit status is simpler: it is one additional enum value rather than a combinatorial explosion, and it removes two boolean fields every client would otherwise have to interpret.

### Scope

- **Lifted now:** `periodStatus` (due, overdue and requires-resubmission resolution) and submission-grained calendar items.
- **Candidate, documented but not built:** the frontend's `getTotalTonnageSentOn` arithmetic over three tonnage fields could become a backend aggregate field under this same principle.
- **Stays in the frontend:** tag colour and translation (`format-submission-status`), table-row shaping (`build-table-rows`), value formatters, and action-path and URL selection (`getInProgressActionPath`, which resolves to routes).

## Consequences

- **Clients key on `(year, period, submissionNumber)`.** The calendar may now return more than one item per period. Any client that assumed one item per period must adapt. This is the one behavioural change clients cannot ignore; everything else is additive.
- **The closed-period ADR's frontend precedence is superseded.** The "active draft wins, else requires resubmission, else submitted" rule moves into the backend as the submission-grained items plus `periodStatus`. The resubmission **mechanics** in that ADR (the `resubmissionRequired` flag, lazy creation of the correction draft, the route-guard relaxation) are unchanged and are what the `requires_resubmission` item is emitted from. That ADR is sequenced behind this one.
- **The admin overview, public register, and report-submissions feed converge.** Each currently hand-rolls "show the latest submitted, not the unconditional current". The backend's latest-submitted selection and the submission-grained contract give them one consistent shape to build on.
- **No background jobs and no drift.** Due and overdue are always correct as of the request, with no clock-driven state transitions to persist.
- **The escape hatch is documented, not closed.** If querying these states across the dataset becomes a real requirement, a materialised projection can be added without revisiting this principle.
