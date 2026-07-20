# 43. Operator-initiated report resubmission

## Status

Proposed

## Context

[ADR-0039](./0039-report-resubmission-for-closed-periods.md) built resubmission for one trigger only: a later summary log restating loads into an already-submitted period. It explicitly left operator-initiated corrections out of scope. [PAE-1652](https://eaflood.atlassian.net/browse/PAE-1652) fills that gap — an operator viewing their own submitted report should be able to click "Make changes to this report" and start a correction themselves, without uploading a new summary log.

The draft-creation side of ADR-0039 needs no change. `createReportForPeriod` already creates submission N+1 once `resubmissionRequired` is set on submission N, gated by `assertResubmissionAllowed`, which only checks `Boolean(previous?.resubmissionRequired)`. It doesn't care why the flag was set. The open question is entirely on the setting side: how does an operator's own click set that flag safely?

Two things about the existing `resubmissionRequired` don't fit an operator-triggered flow:

- **Its shape assumes a summary-log upload.** `{ uploadedAt, reason, summaryLogId }` presumes a summary log exists; an operator click has neither. [ADR-0042](./0042-stale-reports-on-prn-cancellation.md) hit the same problem with the `stale` field and fixed it by nesting per trigger instead of overloading one flat shape. The same fix applies here: two independent triggers can't safely share one flat field, and a future third trigger shouldn't force another shape change.
- **It's set by a bulk operation keyed on the summary log.** `markSubmittedReportsRequiringResubmission` flags every affected period from one upload, using `summaryLogId` as the idempotency key. An operator's request is a single report with no summary log to key on — closer in shape to `markActiveReportsStaleForPrnCancellation` (single org/reg/period, its own idempotency key) than to the batch operation.

This ADR covers only what PAE-1652 needs to add on top of ADR-0039: the shape of the flag an operator sets, the endpoint that sets it, and what that endpoint validates. It does not revisit ADR-0039's own trigger mechanics or rejected alternatives — see that ADR directly for those.

## Decision

**Nest `resubmissionRequired` by trigger, mirroring ADR-0042's fix to `stale`:**

```
resubmissionRequired: {
  closedPeriodRestated?: { uploadedAt, summaryLogId },
  operatorRequested?: { requestedAt, requestedBy }
}
```

`closedPeriodAdjustments` is not yet enabled in production, so unlike `stale`'s migrate-on-read fix, this needs no legacy-shape normalisation — the flat shape is changed directly, in the same PR that adds the new field.

**New sibling repository method**, not an extended batch method — `markSubmittedReportRequiringResubmissionByOperator(organisationId, registrationId, year, cadence, period, submissionNumber, requestedBy, requestedAt)`, modelled on `markActiveReportsStaleForPrnCancellation`'s single-report shape. The write is scoped to the exact `(…, submissionNumber, status: SUBMITTED, resubmissionRequired.operatorRequested not already set)` document — `submissionNumber` is resolved by the caller (see below), not re-derived inside the write, so the write can't silently target the wrong submission if something changes between check and write.

**New endpoint**, `POST .../reports/{year}/{cadence}/{period}/submissions/{submissionNumber}/request-resubmission`, `organisationWrite`-scoped. `unsubmit` is the closest existing precedent for a controlled write to a submitted report, but it's `adminWrite` — a service maintainer correcting on someone's behalf. This route is the operator acting on their own report, so it follows `post.js`/`patch.js`'s scope instead. Before writing, it validates, in order:

1. The report exists (404 if not).
2. It is currently `SUBMITTED` (409 if not).
3. It is the *latest* submission for its period (`isLatestSubmission`, reused as-is — 409 if a later submission has already superseded it; an operator can't resurrect a stale one).
4. No draft is already in flight for the period (409 if an `in_progress`/`ready_to_submit` report exists at `submissionNumber + 1` — reused period-lookup logic, no new concept).

Both (3) and (4) are existing checks, composed rather than reinvented; only the endpoint and the write are new.

**The write must distinguish "already done" from "no longer eligible", not collapse both into one outcome.** A conditional update matching zero documents is ambiguous on its own — it means either "this was already flagged" (a harmless retry: a double-click that slipped past the frontend's `preventDoubleClick`, or a dropped-response retry) or "something changed since the guard ran" (the report was superseded, unsubmitted, or flagged by a concurrent summary-log upload in the same instant). The repository method returns a discriminated outcome, not a boolean, so the route can return 200 for the first case and 409 for the second — collapsing them would either mask a real conflict as success or bounce a harmless retry as an error.

**`canRequestResubmission` is a backend-derived read flag, not frontend-recomputed.** [ADR-0038](./0038-derive-report-state-in-backend.md) settled that derived status is computed once in the backend and surfaced as a field, not re-derived per frontend. The same two rules that gate the endpoint (latest submission, no active draft) also gate whether the "Make changes to this report" button should show on a submitted report — computing them twice, once server-side as a 409 and once client-side by re-fetching the next submission's detail to check for existence, is the kind of duplicated derivation ADR-0038 exists to avoid. A `canRequestResubmission: boolean` field is added to the periodic-reports/calendar read model for each latest submitted report, computed from the same two rules the endpoint validates, so both consumers share one derivation.


## Related

[PAE-1652](https://eaflood.atlassian.net/browse/PAE-1652), [ADR-0038](./0038-derive-report-state-in-backend.md), [ADR-0039](./0039-report-resubmission-for-closed-periods.md), [ADR-0042](./0042-stale-reports-on-prn-cancellation.md)
