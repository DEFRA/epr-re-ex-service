# 37. Per-submission row snapshots committed by the stream

Date: 2026-06-12

## Status

Proposed. Amends [ADR-0036](./0036-event-sourced-waste-balance-stream.md): the event-sourced stream and its commit semantics stand; this ADR extends the `summary-log-submitted` payload with a snapshot reference and sets the target of retiring the row-level companion design (sparse version chains and the canonicity walk) once committed-state reads have moved to snapshots. The change lands additively — the existing waste-records write path is untouched until the final stage.

## Context

An investigation into a reported tonnage discrepancy in the admin waste-records CSV export ([PAE-1560](https://eaflood.atlassian.net/browse/PAE-1560)) established that the waste-record document's `data` field cannot be trusted as "the row's contents as of the last submission". It is the last *written* contents:

1. **Failed submissions still write `data`.** Row writes precede the status transition to SUBMITTED and are never rolled back; a failed submission cannot be retried, so the completing write never comes.
2. **A narrow ordering race can regress `data`.** Submission exclusivity is the SUBMITTING status, not the worker — a worker that outlives the 20-minute TTL can overwrite a newer submission's rows with older values.
3. **`data` keys are raw spreadsheet header strings, replaced wholesale.** A template revision that renames a header splits one logical field across two keys collection-wide.
4. **The sparse `versions` array cannot reconstruct state on its own.** Update versions store diffs whose meaning depends on what was last *written* (committed or orphan), and strict-equality comparison against object-typed cells records phantom changes.
5. **Values are uncoerced ExcelJS output.** A tonnage may be a number, a numeric string, or an object, depending on how the operator's spreadsheet was built.

[ADR-0036](./0036-event-sourced-waste-balance-stream.md) already made the event append the commit point for the *balance*, and acknowledged that uncommitted row versions persist as orphans — handling them with the canonicity walk: a per-row, in-order fold of sparse diffs, stopping at the latest version whose `summaryLogId` is on the stream. The walk is correct but subtle, and it leaves every read that needs committed row state — exports, FOI extracts, per-row audit — performing per-row reconstruction against a collection whose materialised `data` field is explicitly *not* canonical.

Two domain invariants make a simpler shape available:

- **Cumulative restatement.** Every summary log restates all loads to date.
- **Row monotonicity.** Validation rejects any submission that drops a previously-submitted row (the same premise ADR-0036's canonicity walk relies on).

Together these mean **the latest committed workbook is the registration's complete committed row state**. No fold, no walk, no merge across submissions — the answer to "values as of the last submission" is a single artefact, if that artefact exists.

The sparse versions are an optimisation to avoid restating unchanged rows. It saves little — unchanged rows already get no version; the diff machinery only engages for the rare corrected row — and it costs reconstructability and auditability. Meanwhile the storage that full restatement actually needs is cheap: every submitted workbook is already retained indefinitely in S3 (the summary-log document holds its URI), so a parsed snapshot is a second, smaller copy of something already stored.

## Decision

### Per-submission snapshot artefact

At submission time, after extraction and validation, persist a **snapshot**: the parsed rows of the entire workbook, written as a gzipped artefact to S3, keyed by `summaryLogId`. The snapshot is immutable and the write is idempotent — a retry overwrites byte-identical content.

Rows in the snapshot are **canonicalised**:

- Headers that map to a table-schema field are stored under the canonical field name. Unknown headers are carried through as-is — table schemas deliberately accept unknown columns so templates can grow without a coordinated release, and the snapshot must not drop them.
- Values are coerced per the table schema (dates, numbers) at write time. The raw operator-typed original remains available in the retained workbook; the snapshot is the clean, query-ready form.
- Each row carries its identity: table, waste-record type, and row ID.

### Commit point and payload

The `summary-log-submitted` event payload gains a snapshot reference:

```
{ summaryLogId, creditTotal, snapshot: { uri, contentHash, rowCount } }
```

The commit point is unchanged from ADR-0036: **the event append**. No event, no submission. A snapshot written by a submission whose event never lands is an unreachable orphan in S3 — harmless, and eligible for lifecycle expiry. This kills failure modes 1 and 2 above structurally: there is no shared mutable state for a failed or late writer to corrupt; it can only produce orphan artefacts that no committed pointer references.

### Every submission appends an event

Today the live path only appends `summary-log-submitted` events for accredited registrations. Registered-only submissions must also append events, on the `(registrationId, null)` partition the stream schema already admits. Their balance effect stays as ADR-0036 left it (a product decision; zero under the current choice) — their purpose here is commit marking and snapshot reference, which every submission needs regardless of balance.

### Additive first, simplify later

The change rolls out in three stages, each independently shippable:

**Stage 1 — additive.** The submission path gains the snapshot write and the broadened event coverage; everything else is exactly as today. Row versions and `data` are written as ADR-0036 describes, the canonicity walk remains in force, and every existing consumer is untouched. The only observable change is that snapshots accumulate in S3 and every submission appears on the stream with a snapshot reference.

**Stage 2 — reads cut over.** Committed-state reads — the admin CSV export, FOI extracts, per-row audit — move from the waste-records collection to stream + snapshot. Each consumer migrates on its own schedule; the old read path keeps working throughout.

**Stage 3 — waste-records simplifies.** With no committed-state read left on the collection, the waste-record document is demoted from system of record to **rebuildable projection**:

- `data` is defined as the latest *committed* snapshot's row, projected for queries. The projection write moves after the event append and is idempotent; a missed projection write is repaired by rebuild or by the next submission, and no committed-state read depends on it.
- The sparse `versions` array and the canonicity walk retire. Per-row audit — "what did submission S say for row R" — is a lookup in S's snapshot; per-row history is a diff of consecutive snapshots on the stream. Removal timing for the existing version data is owned by the rollout design, not this ADR.
- `creditTotal` computation simplifies: the submission's own canonicalised rows are the complete row state (cumulative restatement), so the walk's one remaining write-time consumer disappears.

Stages 1 and 2 carry no migration risk — they add artefacts and move readers. Only stage 3 changes write-side behaviour, and by then the collection it simplifies has no committed-state consumers left.

### Write ordering

Stage 1 inserts the snapshot write before the event append; row-version writes continue exactly as ADR-0036 orders them. The target ordering, reached at stage 3:

| Step | Write | On failure |
| ---- | ----- | ---------- |
| 1 | Snapshot to S3 (idempotent, keyed by `summaryLogId`) | Balance and committed state unchanged; retry safe |
| 2 | Append `summary-log-submitted` event (commit) | Balance and committed state unchanged; snapshot is an unreachable orphan; operator re-submits |
| 3 | Project rows into waste-records | Committed state unaffected (it lives in step 1+2); projection repaired by rebuild or next submission |

This ultimately replaces ADR-0036's summary-log row of its write-ordering table, where row-version writes preceded the event and relied on the canonicity walk to be invisible until committed.

### Reads

Any read that needs committed row state — the admin CSV export, FOI extracts, per-row audit — resolves it from the stream: latest `summary-log-submitted` event for the partition, then its snapshot. Point-in-time reads ("the estate as of date T") resolve the latest event at or before T per registration; cumulative restatement means the snapshot is the whole answer, never a fold. Queries that only need *current* rows in bulk may continue to use the waste-records projection, accepting projection freshness semantics.

## Considered alternatives

**Keep ADR-0036's sparse versions and canonicity walk (status quo).** Correct for the balance, which never reads the chain at rest. Rejected as the row-state mechanism because every committed-state read pays per-row reconstruction subtlety, the materialised `data` field remains non-canonical, and failure modes 3–5 (header drift, phantom diffs, uncoerced values) are untouched.

**Full snapshots in the waste-record document's versions array.** Replace sparse diffs with full row copies per version. Rejected: document growth is unbounded (every record × every submission × full row), existing delta versions cannot be reconstructed into snapshots, and the cross-record header drift survives because each record still carries whatever its operator's template produced.

**Re-extract the workbook from S3 at read time, no new persistence.** The submitted files are retained, so "latest submitted file per registration → parse → emit" is always available. Rejected as the steady state: it puts xlsx parsing on the export request path (minutes across the estate, against ~14 seconds today) and re-runs coercion on every read. It remains the right primitive for backfilling snapshots for historical submissions.

**Inline the rows in the event payload.** Rejected — the same reasoning as ADR-0036's rejection of per-event row manifests, sharpened: a large submission's rows run to tens of megabytes, which Mongo's 16MB document limit rules out and which would bloat the stream's hot partition scans. Note this ADR does *not* reverse that rejection: ADR-0036 priced carrying row data **in stream documents**; the snapshot lives out of band in S3, where the cost profile is a different question with a different answer.

**Content-addressed row storage (git-style structural sharing).** Each submission stores a manifest of `rowId → contentHash`; unchanged rows share blobs across submissions, giving near-perfect dedup of the restatement redundancy. Rejected as unjustified machinery: restatement makes naive snapshots quadratic-ish per registration (a weekly uploader ending the year at 10,000 rows stores roughly 260,000 row copies), but restated rows compress extremely well and S3 economics make the difference immaterial — tens of gigabytes across the estate in the worst case, against the operational cost of a two-level fetch and hash maintenance. Revisit only if the measured numbers surprise.

## Consequences

### Positive

- **Additive rollout.** Stages 1 and 2 add artefacts and move readers without touching the existing write path; nothing breaks for consumers that haven't migrated, and the write-side simplification happens only once nothing depends on what it removes.
- **"Values as of the last submission" becomes a first-class read** — one event lookup plus one artefact fetch, with the ledger as the sole authority on what was last submitted. All five failure modes from the PAE-1560 investigation die at once rather than being patched individually.
- **The canonicity walk and sparse version chains retire.** The subtlest part of ADR-0036's row-level design is no longer load-bearing.
- **Export columns stabilise.** Canonical field names and coerced values mean a column in the export is one logical field with one type, so a single-column sum means one thing.
- **Waste-records becomes disposable.** A projection rebuildable from stream + snapshots, with the same recovery story as the PRN document projection.
- **Registered-only submissions join the ledger**, closing the coverage gap where the stream is blind to a whole class of submissions.

### Negative

- **Storage grows with restatement.** Each submission stores its full row set; per-registration totals are quadratic-ish in submission frequency. Mitigated by gzip (restated rows are highly compressible) and by living in S3 rather than MongoDB; the retained workbooks already establish the precedent.
- **Submission gains an S3 write** on the critical path before the commit point.
- **Committed-state reads gain an S3 fetch per registration.** The export becomes a fan-out over per-registration artefacts rather than one collection scan — embarrassingly parallel, but more moving parts.
- **Canonicalisation becomes load-bearing at write time.** A header-mapping or coercion bug bakes into immutable snapshots; fixes require regenerating affected snapshots from the retained workbooks (always possible, never automatic).
- **Two artefacts per submission in S3** (workbook + snapshot) to keep in lifecycle-policy alignment.

## Out of scope

- **Migration and cutover** — owned by the rollout design alongside the ADR-0036 cutover. Feasibility note: because every submitted workbook is retained, snapshots for historical submissions are reproducible at any time; backfill is the export-time re-extraction alternative run once.
- **Retirement of existing `versions` data** in waste-records — timing and mechanism belong to the rollout.
- **Cutting other consumers** (reporting aggregation, tonnage monitoring) over to snapshots — they continue reading the projection until separately migrated.
- **Date-range validation on summary-log date fields** — a separate defect surfaced by the same investigation, tracked separately.

## Related

- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — the event-sourced stream this ADR amends
- [ADR-0031](./0031-waste-balance-transaction-ledger.md) — the per-row ledger ADR-0036 superseded
- [Waste balance ledger rollout](../discovery/waste-balance-ledger-rollout.md) — cutover design this ADR's migration work joins
- [PAE-1560](https://eaflood.atlassian.net/browse/PAE-1560) — the export investigation that motivated this ADR
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — parent ledger ticket
