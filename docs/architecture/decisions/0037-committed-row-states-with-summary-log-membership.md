# 37. Committed row states with summary-log membership

Date: 2026-06-12

## Status

Proposed. Amends [ADR-0036](./0036-event-sourced-waste-balance-stream.md): the event-sourced stream and its commit semantics stand; this ADR adds a deduplicated collection of committed row states, addressed by the `summaryLogId` each `summary-log-submitted` event already carries, and sets the target of retiring the row-level companion design (sparse version chains and the canonicity walk) once committed-state reads have moved to it. The change lands additively — the existing waste-records write path is untouched until the final stage.

## Context

An investigation into a reported tonnage discrepancy in the admin waste-records CSV export ([PAE-1560](https://eaflood.atlassian.net/browse/PAE-1560)) established that the waste-record document's `data` field cannot be trusted as "the row's contents as of the last submission". It is the last _written_ contents:

1. **Failed submissions still write `data`.** Row writes precede the status transition to SUBMITTED and are never rolled back; a failed submission cannot be retried, so the completing write never comes.
2. **A narrow ordering race can regress `data`.** Submission exclusivity is the SUBMITTING status, not the worker — a worker that outlives the 20-minute TTL can overwrite a newer submission's rows with older values.
3. **`data` is replaced wholesale, keyed by the template's hidden header names.** The headers are the template-to-backend interface, decoupled from the labels operators see; renaming one without migrating stored documents splits a logical field across two keys collection-wide.
4. **The sparse `versions` array cannot reconstruct state on its own.** Update versions store diffs whose meaning depends on what was last _written_ (committed or orphan), and strict-equality comparison against object-typed cells records phantom changes.
5. **Values are uncoerced ExcelJS output, even in fields the backend defines.** A tonnage may be a number, a numeric string, or an object, depending on how the operator's spreadsheet was built. That is the right treatment for the verbatim columns the backend deliberately leaves undefined — but for the fields it validates and aggregates, it pushes coercion onto every reader.

[ADR-0036](./0036-event-sourced-waste-balance-stream.md) already made the event append the commit point for the _balance_, and acknowledged that uncommitted row versions persist as orphans — handling them with the canonicity walk: a per-row, in-order fold of sparse diffs, stopping at the latest version whose `summaryLogId` is on the stream. The walk is correct but subtle, and it leaves every read that needs committed row state — exports, FOI extracts, per-row audit — performing per-row reconstruction against a collection whose materialised `data` field is explicitly _not_ canonical.

Two domain invariants make a simpler shape available:

- **Cumulative restatement.** Every summary log restates all loads to date.
- **Row monotonicity.** Validation rejects any submission that drops a previously-submitted row (the same premise ADR-0036's canonicity walk relies on).

Together these mean **each committed submission carries the registration's complete row state as of that submission**. No fold, no walk, no merge across submissions — the answer to "values as of the last submission" is whatever the latest committed submission said, whole.

Restatement also means most rows are restated _unchanged_, submission after submission. The existing sparse versions are an optimisation aimed at exactly that redundancy, but they pay for it in reconstructability: diffs only mean something relative to what was last written. The shape this ADR chooses keeps the deduplication while staying directly readable.

One further shaping consideration: operator-facing access to individual rows — drilling into a row and its history — is under consideration as a possibility. The committed-state mechanism should serve per-row reads as readily as whole-submission ones, without separate machinery.

## Decision

### Committed row-state documents

A new collection holds **one document per distinct state of each row**: the row content, the row's identity, and a `summaryLogIds` array listing every submission for which this state is the row's content.

```
{ orgId, registrationId, wasteRecordType, rowId, data: { …coerced row… }, summaryLogIds: [ … ] }
```

Row state is keyed by the template's headers, exactly as extracted — the same keys the waste-record `data` field carries today. The headers are hidden in the template, decoupled from the labels operators see: they are already the canonical field names, the interface between the template and the backend, and this ADR introduces no mapping onto another key set. As today, the backend defines only the columns it needs for validation or downstream meaning (waste balance, reporting), and every other column is recorded verbatim — table schemas deliberately accept unknown columns so templates can grow without a coordinated release, and those columns are shared with regulators when they investigate — so the row state must not drop them.

What this ADR adds is coercion of stored values: schema-defined fields are **coerced** per the existing table schemas (dates, numbers) at write time, where today's `data` stores raw ExcelJS output; verbatim columns are stored as extracted. The raw operator-typed original remains available in the retained workbook; the row state is the query-ready form, and coerced values are what make the unchanged/changed comparison below semantic rather than byte-level for every field the backend understands.

Coercing at write also pins interpretation to the commit point. The event's `creditTotal` is derived from the coerced values, so the row state and the stream record the same reading of the workbook and stay consistent however coercion rules later evolve. Coercing at read would let a committed submission's meaning drift away from the balance the stream already recorded; under the ledger, a reinterpretation that matters is a new event, not a silent change to what a committed submission said.

At submission time, after extraction and validation and before the event append, each row of the workbook is compared against the state tagged with the partition's **latest committed** `summaryLogId` — never against the last write:

- **Unchanged** → `$addToSet` the new `summaryLogId` onto the existing state document.
- **Changed or new** → insert a new state document whose membership array starts with the new `summaryLogId`.

Every write is an idempotent upsert keyed by row identity and content, so a retry re-applies as a no-op. State documents are never mutated once written — `data` is immutable and membership arrays only gain entries.

Deduplication falls out of the shape: document count grows with _distinct states_ (rows plus corrections), not rows × submissions. The restatement redundancy costs an array entry and a multikey index entry per row per submission, both small.

### Commit point and addressing

The `summary-log-submitted` event payload is unchanged from ADR-0036:

```
{ summaryLogId, creditTotal }
```

Membership is the address: the complete row state for committed submission S is `find({ summaryLogIds: S })`, served by a multikey index on the array.

The commit point is unchanged from ADR-0036: **the event append**. No event, no submission — and no reachable row state: memberships and documents tagged only with an uncommitted `summaryLogId` are inert, because committed reads only ever query for ids that are on the stream. This kills failure modes 1 and 2 above structurally: a failed or stale writer cannot mutate any existing state — it can only add inert memberships or insert inert documents — and because the change comparison anchors to the committed head, its leftovers cannot poison the next submission's writes either.

### Every submission appends an event

Today the live path only appends `summary-log-submitted` events for accredited registrations. Registered-only submissions must also append events, on the `(registrationId, null)` partition the stream schema already admits. Their balance effect stays as ADR-0036 left it (a product decision; zero under the current choice) — their purpose here is commit marking, which every submission needs regardless of balance: the event is what makes the submission's row states reachable.

### Additive first, simplify later

The change rolls out in three stages, each independently shippable:

**Stage 1 — additive.** The submission path gains the row-state writes and the broadened event coverage; everything else is exactly as today. Waste-record `data` and versions are written as ADR-0036 describes, the canonicity walk remains in force, and every existing consumer is untouched. The only observable change is that row states accumulate and every submission appears on the stream.

**Stage 2 — reads cut over.** Committed-state reads — the admin CSV export, FOI extracts, per-row audit — move from the waste-records collection to stream + membership query. So does the check-page period-status projection (`loadsByReportingPeriod`): today its added/adjusted/unchanged classification reads the `versions` array and its adjusted baseline reads last-written `data`, so it depends on both structures stage 3 retires — and that baseline carries failure modes 1, 2 and 4, showing phantom adjustments after a failed or raced earlier write. Its migration is a fix as much as a port: anchoring to the committed head is the same comparison the write algorithm already performs, and the committed head state supplies the old period and amount. Each consumer migrates on its own schedule; the old read path keeps working throughout.

**Stage 3 — waste-records retires.** With committed-state reads served directly by the row-state collection — current rows are simply the membership of the latest committed submission — there is no projection left to maintain. The waste-record `data` field, the sparse `versions` array, and the canonicity walk retire; remaining consumers (reporting aggregation, tonnage monitoring) migrate to the row-state collection on their own schedule. Removal timing for the existing data is owned by the rollout design, not this ADR. `creditTotal` computation simplifies too: the submission's own coerced rows are the complete row state (cumulative restatement), so the walk's one remaining write-time consumer disappears.

Stages 1 and 2 carry no migration risk — they add documents and move readers. Only stage 3 changes write-side behaviour, and by then the collection it retires has no committed-state consumers left.

### Write ordering

Stage 1 inserts the row-state writes before the event append; waste-record writes continue exactly as ADR-0036 orders them until stage 3 removes them. The target ordering:

| Step | Write                                                                          | On failure                                                                                             |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1    | Upsert row states and memberships (idempotent, anchored to the committed head) | Balance and committed state unchanged; partial application is invisible to committed reads; retry safe |
| 2    | Append `summary-log-submitted` event (commit)                                  | Balance and committed state unchanged; new memberships stay inert; operator re-submits                 |

This ultimately replaces ADR-0036's summary-log row of its write-ordering table, where row-version writes preceded the event and relied on the canonicity walk to be invisible until committed.

### Reads

Any read that needs committed row state resolves it from the stream: latest `summary-log-submitted` event for the partition, then `find({ summaryLogIds: S })`. Bulk reads across the estate — the admin CSV export, FOI extracts — resolve the latest committed id per partition in one grouped stream query, then fetch all rows in one `$in` query over the membership index. Point-in-time reads ("the estate as of date T") resolve the latest event at or before T per registration; cumulative restatement means that submission's membership is the whole answer, never a fold.

Row-level reads need no separate machinery: a row's current committed value is its state tagged with the partition's latest committed id, and its history is its state documents ordered by the stream order of their memberships — which serves the operator-facing row drill-down under consideration directly from the same collection.

## Considered alternatives

**Keep ADR-0036's sparse versions and canonicity walk (status quo).** Correct for the balance, which never reads the chain at rest. Rejected as the row-state mechanism because every committed-state read pays per-row reconstruction subtlety, the materialised `data` field remains non-canonical, and failure modes 4 and 5 (phantom diffs, uncoerced values) are untouched.

**Full snapshots in the waste-record document's versions array.** Replace sparse diffs with full row copies per version. Rejected: document growth is unbounded (every record × every submission × full row), existing delta versions cannot be reconstructed into snapshots, and the stored values remain uncoerced ExcelJS output.

**Per-submission snapshot artefacts in S3.** Gzip the parsed rows of the whole workbook, keyed by `summaryLogId` — immutable by construction, a single put on the commit path. Rejected: it adds a second storage system to the committed path, every read pays a fetch-gunzip-parse, bulk reads fan out per registration, and row-level access needs a separate projection — machinery the membership collection replaces with one multikey index. Its structural immutability is defence in depth (the event gate carries the commit semantics either way), traded here for one queryable store.

**One document per row per submission.** Keyed `(summaryLogId, rowId)` — the same addressability as membership documents with none of the deduplication: rows × submissions full row copies, where restatement means the overwhelming majority duplicate the state before them. The membership array stores each distinct state once and pays an array entry for each restatement.

**Validity intervals instead of membership arrays.** Each state document carries `validFrom`/`validTo` positions in the partition's stream order: constant-size documents and zero writes for unchanged rows. Rejected: closing `validTo` on the previous state is a destructive write to shared state — exactly the class of hazard this ADR removes — and "an open interval covers submission S" is implicit reasoning where membership is an explicit, point-queryable fact. The simpler shape is easier to hold in your head and to test.

**Re-extract the workbook from S3 at read time, no new persistence.** The submitted files are retained, so "latest submitted file per registration → parse → emit" is always available. Rejected as the steady state: it puts xlsx parsing on the export request path (minutes across the estate, against ~14 seconds today) and re-runs coercion on every read. It remains the right primitive for backfilling row states for historical submissions.

**Inline the rows in the event payload.** Rejected — the same reasoning as ADR-0036's rejection of per-event row manifests, sharpened: a large submission's rows run to tens of megabytes, which Mongo's 16MB document limit rules out and which would bloat the stream's hot partition scans. The row-state collection lives out of band; the stream stays small.

## Consequences

### Positive

- **Additive rollout.** Stages 1 and 2 add documents and move readers without touching the existing write path; nothing breaks for consumers that haven't migrated, and the write-side retirement happens only once nothing depends on what it removes.
- **"Values as of the last submission" becomes a first-class read** — one event lookup plus one indexed query, with the ledger as the sole authority on what was last submitted. Failure modes 1, 2, 4 and 5 from the PAE-1560 investigation die at once rather than being patched individually; header naming stays the template-interface concern it is today.
- **Row-level access comes for free.** Current value, point-in-time value, and full history of any row are all queries on the same collection — the operator-facing row view under consideration needs no separate read model.
- **The canonicity walk and sparse version chains retire.** The subtlest part of ADR-0036's row-level design is no longer load-bearing.
- **Export values stabilise.** Coerced values mean a column in the export holds one type, so a single-column sum means one thing.
- **Committed row state lives where the rest of the data lives** — directly queryable, with no projection to keep fresh.
- **Registered-only submissions join the ledger**, closing the coverage gap where the stream is blind to a whole class of submissions.

### Negative

- **Correctness is disciplinary, not structural.** The invariants — state documents never mutate, membership arrays only grow, comparison anchors to the committed head, every write is an idempotent upsert — live in write-path code. A bug can violate them in place; they need contract-test enforcement.
- **The commit path keeps a many-document bulk write** (one operation per row) ahead of the event append — the same cost the submission path pays today.
- **Membership arrays and the multikey index grow without bound** — one entry per row per submission, small individually, accumulating for as long as a registration keeps submitting. Compaction is available if measured growth ever surprises.
- **Coercion becomes load-bearing at write time.** A coercion bug bakes into stored states. Rebuilding affected documents from the retained workbooks is always possible, never automatic — and where the corrected values differ in fields the stream has already aggregated, the correction itself belongs on the stream rather than in a silent rewrite of committed history.
- **Inert garbage accumulates.** Failed submissions leave unreachable documents and memberships; harmless to every committed read, but a sweep belongs to operational hygiene.

## Out of scope

- **Migration and cutover** — owned by the rollout design alongside the ADR-0036 cutover. Feasibility note: because every submitted workbook is retained, row states for historical submissions are reproducible at any time; backfill is the read-time re-extraction alternative run once, in stream order.
- **Retirement of existing `versions` data** in waste-records — timing and mechanism belong to the rollout.
- **The operator-facing row view itself** — a product possibility this ADR keeps cheap, not a commitment it makes.
- **Date-range validation on summary-log date fields** — a separate defect surfaced by the same investigation, tracked separately.

## Related

- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — the event-sourced stream this ADR amends
- [ADR-0031](./0031-waste-balance-transaction-ledger.md) — the per-row ledger ADR-0036 superseded
- [Waste balance ledger rollout](../discovery/waste-balance-ledger-rollout.md) — cutover design this ADR's migration work joins
- [PAE-1560](https://eaflood.atlassian.net/browse/PAE-1560) — the export investigation that motivated this ADR
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — parent ledger ticket
