# 38. Derive report status and state in the backend

Date: 2026-06-25

## Status

Proposed.

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

The existing `report` object stays frozen as `{ status, id, ... } | null` with today's meanings, so no client that switches on the stored status or checks `report === null` breaks.

The `GET /reports/calendar` list becomes **submission-grained**: items are keyed on `(year, period, submissionNumber)`, so a single period can carry more than one item. Each item gains additive sibling fields:

- **`periodStatus`** — a single-axis lifecycle enum: `due | overdue | in_progress | ready_to_submit | submitted`. The backend does the date arithmetic (`due` once the period has ended, `overdue` once past the due date).
- **`isResubmission`** — `true` for submission 2 and later, so the frontend renders resubmission copy rather than first-draft copy.
- **`current`** (or its inverse `superseded`) — a boolean letting the frontend hide superseded submissions with a simple check rather than recomputing the latest submission itself. This leans on the `current` / `previousSubmissions` read view the closed-period ADR already defines.

```jsonc
// period 1 in resubmission: two items
{ "year": 2026, "period": 1, "submissionNumber": 1,
  "periodStatus": "submitted", "isResubmission": false, "current": false,
  "report": { "status": "submitted", "id": "uuid", "submittedAt": "...", "submittedBy": { "name": "..." } } },

{ "year": 2026, "period": 1, "submissionNumber": 2,
  "periodStatus": "due", "isResubmission": true, "current": true,
  "report": null }
```

### Resubmission is modelled structurally, not as a status

When detection sets `resubmissionRequired` on a submitted report, the backend emits an additional skeleton item for `submissionNumber + 1` (`periodStatus: due`, `isResubmission: true`), the same way it already emits skeleton items for started periods that have no draft. The original report stays `periodStatus: submitted`.

This keeps `periodStatus` a clean single axis and avoids a combinatorial enum that would otherwise need to encode resubmission context across every lifecycle state. The frontend's existing active / submitted table partition keeps working unchanged: the resubmission skeleton sorts into the active table because it is `due`, the original into the submitted table because it is `submitted`. There is no `requires_resubmission` enum value.

Once submission 2 is itself submitted, submission 1 is hidden and only the latest submitted report shows. That is a presentation rule and stays in the frontend, made trivial by the `current` / `superseded` marker.

### Scope

- **Lifted now:** `periodStatus` (due and overdue resolution), submission-grained calendar items, `isResubmission`, and `current` / `superseded`.
- **Candidate, documented but not built:** the frontend's `getTotalTonnageSentOn` arithmetic over three tonnage fields could become a backend aggregate field under this same principle.
- **Stays in the frontend:** tag colour and translation (`format-submission-status`), table-row shaping (`build-table-rows`), value formatters, action-path and URL selection (`getInProgressActionPath`, which resolves to routes), and the filtering of superseded submissions.

## Consequences

- **Clients key on `(year, period, submissionNumber)`.** The calendar may now return more than one item per period. Any client that assumed one item per period must adapt. This is the one behavioural change clients cannot ignore; everything else is additive.
- **The closed-period ADR's frontend precedence is superseded.** The "active draft wins, else requires resubmission, else submitted" rule moves into the backend as the submission-grained items plus `periodStatus`. The resubmission **mechanics** in that ADR (the `resubmissionRequired` flag, lazy creation of the correction draft, the route-guard relaxation) are unchanged and are what the resubmission skeleton item is emitted from. That ADR is sequenced behind this one.
- **The admin overview, public register, and report-submissions feed converge.** Each currently hand-rolls "show the latest submitted, not the unconditional current". The `current` / `superseded` marker and the submission-grained contract give them one consistent shape to build on.
- **No background jobs and no drift.** Due and overdue are always correct as of the request, with no clock-driven state transitions to persist.
- **The escape hatch is documented, not closed.** If querying these states across the dataset becomes a real requirement, a materialised projection can be added without revisiting this principle.
