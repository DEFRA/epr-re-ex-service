# 29. Compute on write for loadsByWasteRecordType

Date: 2026-03-24

## Status

Proposed

## Context

The summary log GET response includes an aggregate `loads` count showing the total number of loads across all waste record tables. We are adding a new `loadsByWasteRecordType` field that breaks this down per waste record type (received, exported, sentOn, processed), giving users a more detailed view of their submission.

The question is where to compute this breakdown:

1. **Compute on write** — calculate `loadsByWasteRecordType` during validation and persist it on the summary log document alongside the existing `loads` field
2. **Compute on read** — derive `loadsByWasteRecordType` on the fly in the GET endpoint by querying or aggregating waste records at request time

The existing `loads` field is already computed at validation time and stored on the summary log document. The GET endpoint currently serves the summary log as a straightforward read with no business logic or aggregation.

### Document size considerations

Each waste record type can have up to 12 material categories, and each category tracks an array of row identifiers (capped at 100). In the worst case — four waste record tables, all 12 categories populated, 100 row IDs each — the `loadsByWasteRecordType` field would add roughly 48 KB to the document. Current summary log documents are approximately 1.3 KB before validation. Even with the new field, documents remain in the tens of kilobytes — well within MongoDB's 16 MiB BSON document limit.

## Decision

Compute `loadsByWasteRecordType` at validation time and persist it on the summary log document.

The validation pipeline already computes the aggregate `loads` count by iterating over waste records. Computing the per-type breakdown is a natural extension of this existing logic — the data is already in hand during validation, so the marginal cost of breaking it down by type is negligible.

The GET endpoint continues to serve the summary log document directly, with no additional queries or computation.

## Consequences

### Positive

- **Follows the established pattern** — the aggregate `loads` field is already computed on write and persisted, so `loadsByWasteRecordType` is consistent with the existing approach
- **Simple GET endpoint** — the endpoint remains a read-and-serve operation with no business logic, keeping it fast and easy to reason about
- **No repeated computation** — the breakdown is calculated once at validation time rather than on every GET request
- **Negligible storage overhead** — the additional field adds at most tens of kilobytes to documents that are already well under MongoDB's size limits

### Negative

- **Stale data if logic changes** — if the load counting rules change, previously validated summary logs will retain their original `loadsByWasteRecordType` values. This is the same trade-off that already exists for the aggregate `loads` field.
- **Slight increase in document size** — each summary log document grows by a small amount, though this is immaterial in practice

## Related

- [ADR 20: Summary Log Validation Output Formats](0020-summary-log-validation-output-formats.md) — defines the summary log document structure that this field extends
