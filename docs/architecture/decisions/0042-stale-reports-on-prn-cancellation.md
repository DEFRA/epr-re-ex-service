# 42. Stale reports on PRN/PERN cancellation

Date: 2026-07-13

## Status

Proposed

## Context

A report's `issuedTonnage` is computed once, at generation time, from PRNs/PERNs issued within the period. If a PRN later moves to `awaiting_cancellation` (via the producer's `reject` call) or `cancelled`, the stored `issuedTonnage` overstates reality — the same problem [PAE-1240](https://eaflood.atlassian.net/browse/PAE-1240) already solved for re-uploaded summary logs: `markActiveReportsStale` flags active reports with a `stale` field, `assertNotStale` blocks PATCH/submit with `409`, and the frontend shows the "Your summary log has changed" interstitial. [PAE-1698](https://eaflood.atlassian.net/browse/PAE-1698) wants the same experience, triggered by PRN cancellation instead.

Three facts shape the decision:

- **PRN status changes are synchronous REST calls today, not events.** `reject.js` is an externally-authenticated call handled inline, with no reports-module dependency.
- **Reports don't reference the PRNs they depend on** — only the aggregated `issuedTonnage` number. So detection has to be period-based (any active report whose period overlaps the PRN's `issued.at`), which is exactly what `stale-issued-tonnage.js` (PAE-1665) already computes, today as a read-only, log-only startup diagnostic that reaches nobody.
- **`stale` is shaped around a summary-log upload** (`summaryLogId` drives idempotency, `uploadedAt` presumes an upload). [ADR-0039](./0039-report-resubmission-for-closed-periods.md) already rejected overloading `stale` for a structurally different trigger (`resubmissionRequired`), for the same reason. A report can now go stale for two independent, possibly simultaneous reasons, which a single reused field can't express.

## Decision

**Trigger inline, synchronously, on the PRN reject/cancel transition** — no new event channel. The transition handler calls a new reports-repository operation in the same request, the same way `onSummaryLogUploaded` runs inline today.

**Routing this through SQS, considered and rejected.** The idea: have the PRN module publish a "PRN cancelled" message — either onto the existing internal `epr_backend_commands` queue as a new command type, or onto a new dedicated queue — for the reports module to consume asynchronously, decoupling the two modules the way `epr-backend`'s own summary-log processing already decouples upload from validation. Both variants add the same cost for no real gain here: PRN and reports already live in one deployable and already call each other's repositories directly (`stale-issued-tonnage.js` does today), so there's no process or deployment boundary for a queue to decouple. Going through a queue also trades today's single synchronous write for eventual consistency — redelivery, ordering, a DLQ to watch — and that lag matters concretely: the operator's next page load needs the flag to already be set, which only a synchronous write guarantees. If direct repository coupling between the two modules later becomes a real problem, an application-layer port is the cheaper fix — a future option, not needed now.

**New sibling repository method**, `markActiveReportsStaleForPrnCancellation(organisationId, registrationId, periods, prnNumber, occurredAt)` — not an extended `markActiveReportsStale` signature, mirroring how ADR-0039 added `resubmissionRequired` as a sibling rather than widening an existing method. `periods` reuses the existing `PeriodRef[]` shape (`{ year, cadence, period }`); filter and idempotency mirror `markActiveReportsStale` (active reports only, skip if already flagged for this `prnNumber`). Submitted reports are untouched — resubmission-on-cancellation is out of scope, a follow-on ticket.

**`stale` becomes a container for two independent triggers**, not a single reused field, keyed by named field rather than a `reason` string — presence of the field *is* the reason code, so two triggers can each write with a single targeted `$set` (`'stale.summaryLogChanged'` / `'stale.prnCancelled'`) with no risk of clobbering the other, unlike today's whole-field overwrite:

```
stale: {
  summaryLogChanged?: { uploadedAt, summaryLogId },
  prnCancelled?: { occurredAt, prnNumber }
}
```

Both can be set at once. `assertNotStale` derives a `staleReasons(stale)` array from which fields are present (`['summary_log_changed']`, `['prn_cancelled']`, or both) and throws with `err.output.payload.code` set to that array. Nothing in Hapi validates this today — there's no existing `response.status[409]` schema in this codebase to extend, and it wouldn't apply here anyway: Boom payloads are built in `onPreResponse`, after route-level response validation already ran, so a route schema can't see them (`external-api-error-formatter.js` hits the same limitation). The right enforcement point is a small Joi schema asserted inside `assertNotStale` itself, at construction time — worth adding alongside this change so `payload.code`'s new array shape is contract-tested rather than left implicit, the way the rest of `stale`'s shape already is via `markActiveReportsStale.contract.js`.

**Frontend renders one of three pages, keyed on the combination, not a single winning reason.** The supplied designs show distinct copy for summary-log-only, PRN-only, and both-at-once ("A newer version of your summary log has been uploaded and a [PRN/PERN] has been cancelled..."), so the frontend can't just pick a winner between the two reasons — it has to route on the whole array.

**Frontend needs two small, explicit changes — not a silent "just works".** `fetch-report-backend.js`'s `payload.code === SUMMARY_LOG_CHANGED` strict-equality check must become array-aware (`.includes(...)`), and `reports/index.js`'s `INVALIDATION_ERROR_ROUTES[reason]` single-key lookup must be replaced with a lookup keyed on the sorted array (or an equivalent combination key) so each of the three combinations resolves to its own route.

**Existing `stale` documents are migrated on read, not backfilled.** Old flat documents (`{ uploadedAt, reason, summaryLogId }`) are normalised to `{ summaryLogChanged: { uploadedAt, summaryLogId } }` by one function at the repository read boundary; new writes only ever produce the new shape. No bulk migration is needed because `stale` only applies to active drafts, which are short-lived by construction (deleted-and-recreated or submitted within the same session) — old-shape documents age out on their own within the rollout window.


## Out of scope

- **PRN cancellation after report submission.** This ADR covers active drafts only. A cancellation affecting an already-submitted report is a resubmission question (the `resubmissionRequired` path ADR-0039 built), not a staleness question — a separate, follow-on ticket.

## Related

[PAE-1698](https://eaflood.atlassian.net/browse/PAE-1698), [PAE-1240](https://eaflood.atlassian.net/browse/PAE-1240), [PAE-1665](https://eaflood.atlassian.net/browse/PAE-1665), [ADR-0024](./0024-create-prn-api-strategy.md), [ADR-0027](./0027-modular-monolith-structure.md), [ADR-0038](./0038-derive-report-state-in-backend.md), [ADR-0039](./0039-report-resubmission-for-closed-periods.md)
