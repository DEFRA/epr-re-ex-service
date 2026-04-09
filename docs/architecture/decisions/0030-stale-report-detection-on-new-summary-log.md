# 30. Stale report detection on new summary log upload

Date: 2026-04-08

## Status

Proposed

## Context

When a new summary log is uploaded whilst a report is `in_progress` or `ready_to_submit`, the report's aggregated waste data no longer reflects the latest records. The system must detect this mismatch, block further progression of the stale report, and allow the user to delete it and start again.

Each report already stores `source.summaryLogId` and `source.lastUploadedAt`. Waste record versions each reference the summary log they came from (`summaryLog.id`). A MongoDB partial unique index prevents more than one active draft per reporting period.

Two detection strategies were considered:

1. **Snapshot comparison** — at creation time, persist the set of `wasteRecordIds` that contributed to the report alongside `source.summaryLogId`. On subsequent access, compare this snapshot against the current active summary log: new IDs, missing IDs, or any ID whose `summaryLog.id` has changed since the snapshot all indicate staleness.
2. **Re-aggregation** — re-run the full aggregation pipeline on access and compare the result to the stored report. Flag the report stale if the output differs.

Option 2 was rejected: there is no agreed specification for which differences are material, and a full re-aggregation on every GET request is expensive.

## Decision

Use **snapshot comparison** (Option 1).

Store `source.wasteRecordIds: string[]` on the report document at creation time. On access (GET, PATCH, or status-change routes), lazily compare the snapshot against the current active summary log for the period. Any discrepancy — added, removed, or re-sourced waste record IDs — marks the report as `stale`.

Add `stale` to `REPORT_STATUS`. Transitions `in_progress → stale` and `ready_to_submit → stale` are permitted; `submitted` reports are never marked stale. Marking a report stale releases the partial unique index, allowing a new draft to be created after the stale report is deleted.

## Consequences

### Positive

- **Fast lookups** — staleness is determined by targeted ID comparisons rather than a full re-aggregation pipeline
- **Deterministic** — the snapshot is immutable at creation time, so the same report always produces the same staleness verdict for a given summary log state
- **Unblocks the user** — transitioning to `stale` releases the unique-draft constraint, so the user can delete and restart without manual intervention

### Negative

- **Lazy detection only** — a report is not marked stale until it is accessed; a future enhancement could mark reports stale eagerly during the summary log upload sync
