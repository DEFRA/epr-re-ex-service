# 47. Reconcile stale PRN projections

Date: 2026-08-27

## Status

Proposed.

Revises one narrow decision in [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — that "no separate reconciliation job is required" for the PRN status projection (see its _Reading PRN state_ and _Partial failure and recovery_ sections). The rest of ADR-0036 stands: the event stream remains the source of truth, the balance is still a single indexed read, and reads through the fold helper remain correct.

## Context

Under [ADR-0036](./0036-event-sourced-waste-balance-stream.md) a PRN's status is a projection of the event stream. The PRN document carries an event-number watermark (`lastAppliedEventNumber`) — the `number` of the latest stream event already folded into it. The read helper reconstructs live state by loading the document and folding any events for that `payload.prnId` with `number > lastAppliedEventNumber` (usually zero events). The commit boundary is the event append; the document projection is a second, best-effort write that follows it.

ADR-0036 concluded that no reconciliation job was needed, on the strength of one claim:

> A subsequent successful write for the same PRN advances the watermark and the tail shrinks back to empty; no separate reconciliation job is required.

That self-heal is **conditional on a subsequent write**. It holds for PRNs that keep transitioning, but not for PRNs that reach a **dormant** state and then receive no further writes — `AWAITING_CANCELLATION` reached by rejection, `ACCEPTED`, and other terminal or near-terminal states. If the projection write is dropped at the transition _into_ a dormant state (a CAS version conflict, a watermark-regression guard, or a transient persist failure after the event has already appended), nothing subsequently advances the watermark. The document is then **permanently** behind its watermark, not "temporarily stale". ADR-0036's framing does not cover this case.

Two things make the permanent drift observable and harmful:

- **Reads that bypass the fold helper see it directly.** ADR-0036 already flags this as a consequence: "consumers that bypass the read helper would see a stale view." The admin list and CSV-download endpoints read the raw projection for report-style presentation and do not fold; so do any out-of-band consumers (direct database queries, exports, analytics, support tooling, a future service).
- **It has been observed in production.** A rejected PRN — which should read `AWAITING_CANCELLATION` — presents as `AWAITING_ACCEPTANCE` on the admin PRN-activity view, because the rejection's projection write was dropped and no later write has healed it.

So there is a class of projection drift that never self-heals, and today nothing converges the persisted document back to the ledger.

## Decision

Introduce a **reconciler** that converges stale PRN projections: for each PRN whose document is behind its watermark, re-fold the event tail and persist the result. This is the reconciliation job ADR-0036 chose to avoid, adopted now for the dormant-PRN gap it did not anticipate.

### Mechanism — a per-deploy startup sweep

Run the reconciler as a startup sweep, guarded by a `mongo-locks` distributed lock so exactly one pod per deploy executes it. This mirrors two existing, proven patterns in `epr-backend`: `run-organisation-validation-sweep.js` (a lock-guarded startup scan that reports anomalies) and `run-duplicate-accreditation-link-migration.js` (a lock-guarded sweep that runs dry by default and repairs only behind a feature flag).

Behaviour:

1. Acquire the reconciler's distributed lock. If another pod holds it, skip.
2. Scan PRN documents. For each, run the existing catch-up query — events for that `payload.prnId` with `number > lastAppliedEventNumber`.
3. **Dry-run by default.** Emit, per drifting PRN, its identity, current projected status, watermark, and the number of the earliest unapplied event; emit a per-run summary (scanned, drifting).
4. **Repair behind a feature flag.** When enabled, fold the tail and persist the corrected projection through the normal write path. Emit per-run counts of repaired and still-drifting PRNs.

### Repair safety

Persistence reuses the standard write path's optimistic-concurrency and monotonicity guards — the `expectedVersion` CAS and the watermark-not-regressing predicate. A reconciler write that races a live write loses the CAS and is simply retried on the next sweep; a fold that would move the watermark backwards is refused. The reconciler is therefore idempotent and adds **no new concurrency surface**, keeping faith with ADR-0036's "detection over absorption" rule: the reconciler never absorbs a conflict silently, it re-attempts on the next run.

### Observability

The dry-run output is, by construction, a drift diagnostic — it answers "which PRN documents are currently behind their ledger, and by how much" without a separate tool. Running dry first quantifies the problem in each environment before any repair is enabled.

### Cadence bound

Staleness is bounded by the deploy interval: each deploy re-converges the estimate. On the current deploy cadence this is expected to be sufficient. If it proves too slack — drift persisting materially longer than acceptable between deploys — the escalation path is a scheduled reconcile driven off the existing SQS command consumer (see _Considered alternatives_), which this ADR names but does not adopt.

## Considered alternatives

**Make all read paths fold (ADR-0036's sanctioned remedy).** Route the report-style admin reads through the fold helper so they never present a stale value. Rejected as a _sufficient_ fix, and unattractive for these surfaces specifically:

- It corrects what reads _through the application_ see, but leaves the **stored** document permanently wrong — so every out-of-band consumer still sees stale, and every new read path must remember to fold.
- For the bulk list and download endpoints it converts today's single indexed `find` into a **1 + N** read: one catch-up point-query per PRN on the page, because the catch-up helper is keyed on a single `payload.prnId` and there is no batch variant. Partition-batching (one query per `(registrationId, accreditationId)`, folding in memory) mitigates but does not remove the fan-out — the global admin list spans many accreditations and per-PRN watermarks differ.

Reconciling the stored projection keeps the report reads cheap _and_ correct. Folding the single-PRN read path stays cheap — one point-query — and remains the right approach there; it is the report-style fan-out this ADR avoids. (Making the admin read paths fold is complementary, not mutually exclusive, and can be done independently — see _Out of scope_.)

**Scheduled reconcile via the SQS command consumer.** An external scheduler enqueues a reconcile command on a fixed interval; the existing consumer handles it. Gives true steady-state cadence independent of deploys, and reuses proven queue infrastructure. Deferred rather than rejected: it requires external scheduler wiring that the per-deploy sweep does not, which is more than the initial step warrants. Named here as the escalation path if the deploy-bounded cadence proves insufficient.

**Capture-on-failure work queue.** Record a PRN's identity whenever a projection write is dropped, and have the reconciler process only the recorded set, with a periodic full scan as a backstop for the process-crash case (event appended, no chance to record). Rejected as the initial step: it is the most moving parts, the record-on-failure write can itself fail, and it still needs the backstop scan — so it builds two mechanisms to do what one sweep does.

**On-read persist (the fold helper writes back when it heals).** Have the read helper persist the folded result as a side effect. Rejected: it only fires on the read paths that already fold — the very paths that already return correct data — so it never reaches the dormant PRNs that nothing reads through the helper. It does not close the gap.

**Two-phase commit across the event append and the projection write.** Already rejected by ADR-0036 and restated here: it is a heavyweight mechanism for a projection the system deliberately treats as eventually consistent. The reconciler converges the projection without coupling it to the append.

## Consequences

### Positive

- **Bounds projection staleness in time.** Dormant-PRN drift is no longer permanent; each deploy re-converges.
- **The stored document becomes eventually correct.** Out-of-band consumers (direct queries, exports, analytics, support tooling, future services) are safe without needing fold discipline.
- **Report reads stay dumb and cheap.** The bulk list and download endpoints keep their single indexed `find`; correctness comes from a background sweep, not per-request fan-out.
- **Drift observability for free.** The dry-run mode is the diagnostic; no separate detection tooling is needed.
- **Reuses proven infrastructure.** Startup sweep, `mongo-locks` distributed lock, and feature-flag gating are all established patterns; no new runtime infrastructure is introduced.
- **Idempotent and race-safe.** Repair rides the existing CAS and watermark-not-regressing guards; no new concurrency surface.

### Negative

- **Reverses ADR-0036's "no reconciliation job" position** for the dormant-PRN case. This ADR owns that reversal and scopes it narrowly.
- **A full PRN scan per deploy.** Bounded, and with precedent (the organisation-validation sweep scans all organisations at startup). If cost becomes material the scan can be scoped — for example to candidate statuses or a recently-updated window.
- **Cadence is tied to deploys**, not steady state. Long gaps between deploys widen the staleness window; the escalation path is noted above.
- **One feature flag to manage** — to add for the repair rollout and to retire once repair is trusted.

## Out of scope

- **Making the admin list and download read paths fold.** Complementary, ADR-aligned (it is what ADR-0036 already implies), and needs no ADR of its own. Tracked as separate follow-up work.
- **True cron cadence via the SQS consumer.** Only if the deploy-bounded cadence proves insufficient.
- **Reconciliation of any projection other than PRN status.**

## Related

- [ADR-0036](./0036-event-sourced-waste-balance-stream.md) — the event-sourced stream and the projection-with-watermark read model whose "no reconciliation job required" decision this ADR revises.
- Production symptom: a rejected PRN presenting as `AWAITING_ACCEPTANCE` on the admin PRN-activity view.
