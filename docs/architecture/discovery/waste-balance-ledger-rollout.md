# Waste Balance Ledger — Rollout and Cutover Strategy

## Status

Proposed — sign-off required before the rollout and cutover bead is scoped.

## Context

[ADR 0031](../decisions/0031-waste-balance-transaction-ledger.md) moves waste balance transactions from an embedded `transactions[]` array on each waste-balance document into a separate append-only ledger collection. Each transaction carries its own running totals (`closingAmount`, `closingAvailableAmount`) so the current balance is a single indexed read on the highest-numbered transaction per accreditation.

Two separable decisions remain before the flag can start flipping on:

1. **Environment rollout order** — which environments, in what order, and what signals gate promotion between them.
2. **Per-accreditation data cutover** — how an accreditation moves from "balance derived from v1 document" to "balance derived from v2 ledger" without losing its current balance.

A `FEATURE_FLAG_WASTE_BALANCE_LEDGER` convict entry and cross-environment `false` default are already in flight (epr-backend#1115 and cdp-app-config#3287). Shadow dual-write is excluded by the ADR — single-write with dual-read fallback is the only mechanism on the table.

## Part A — Environment rollout

### Recommended order

`dev → test → ext-test → perf-test → prod`

Standard Defra order for the first four environments. The question is where `perf-test` slots in relative to prod. The recommendation is **before**, because:

- The ledger changes the write path from one atomic document update (v1: `$set` + `$push $each` on the waste-balance doc) to N independent optimistic appends across the ledger collection. A 200-row summary log becomes 200 indexed-read + 200-insert round-trips, each potentially retrying on unique-index conflict.
- The read path drops from "load a potentially large embedded document" to "one indexed read on the latest ledger row". This is strictly cheaper, but it is worth measuring under representative load before it reaches the customer-facing environment.
- Dev, test, and ext-test do not produce the load profile that exposes write amplification or retry churn. Perf-test does. Catching a pathological interaction in perf-test is an order of magnitude cheaper than catching it in prod.
- `infra-dev` and `management` are not customer-facing and are not in the promotion path; they do not need the flag set.

### Promotion gates

Each step requires signals to clear before the next flag-flip PR lands in `cdp-app-config/main/services/epr-backend/<env>/epr-backend.env`.

| Environment | Soak                                                                                                                                                             | Required signals                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev         | 3–5 working days                                                                                                                                                 | No unhandled exceptions in logs referencing ledger writes or reads. `wasteBalance.ledger.write{outcome=exhausted} = 0`. Journey tests green.                                                                                                                                                                                           |
| test        | 3–5 working days                                                                                                                                                 | Same as dev, plus end-to-end journey tests covering summary-log submission and PRN lifecycle green against v2.                                                                                                                                                                                                                         |
| ext-test    | 5 working days                                                                                                                                                   | Same as test, plus at least one external reprocessor has a v2 transaction written through normal operation (observable via `wasteBalance.ledger.write` trending up).                                                                                                                                                                   |
| perf-test   | One full perf run covering both summary-log submission **and** the PRN lifecycle (creation, issuance, acceptance, cancellation) at peak scale, plus 48-hour soak | Write-path p99 latency within the agreed SLO envelope for each `sourceKind`. Read-path p99 unchanged or improved against the v1 baseline captured pre-flip. `wasteBalance.ledger.write{outcome=exhausted} = 0` across the full run. No unexpected query-planner regressions visible in MongoDB Atlas explain plans on the new indexes. |
| prod        | Ongoing monitoring                                                                                                                                               | Flag flip lands in a low-traffic window; first 72 hours are tightly monitored per the alert rules in §Observability.                                                                                                                                                                                                                   |

"Signals clear" means the reviewer of the next flag-flip PR can point at the dashboards and alerting history for the previous environment and show that the gates above are met. This is a human judgement; dashboards and metric names below are the inputs.

### Rollback protocol

Flag flip `true → false` is safe at any point while v1 still exists (until the epic's final bead retires it):

- The dual-read helper stops reading the ledger and reverts to reading `amount` / `availableAmount` from the waste-balance document.
- The v1 write path has remained in place throughout the epic — summary-log submissions and PRN lifecycle events go back to updating the embedded array.
- Ledger transactions written during the flag-ON window are durable but inert — they are not read and they are not deleted. If the flag is later flipped back on, they pick up where they left off.

The **side-effect worth naming**: during the flag-ON window the v1 `amount` / `availableAmount` fields are not updated, because the v2 write path replaces the v1 write path rather than running both. So a rollback after any v2 writes have happened reverts reads to the pre-flip v1 balance. Data is not lost (the ledger keeps every transaction), but recent state is not reflected in read paths until either (a) the flag flips back on, or (b) the operator re-uploads under v1 and rebuilds v1 from current waste-records state.

In practice: short rollbacks (minutes to hours) before many accreditations have written v2 transactions have essentially no customer-visible impact. Longer rollbacks after broad v2 adoption need a communications step and the operator-re-upload path as recovery. The flag-flip itself is not zero-downtime-fast — `cdp-app-config` changes trigger a redeploy of the service, so the rollback latency is 5–10 minutes, not seconds.

**Operational rule: do not wipe the ledger between a rollback and a re-flip.** Seed transactions and any real v2 transactions written during the flag-ON window are the correct opening state for any subsequent re-flip. A "clean slate" instinct here is actively dangerous: re-running the backfill after a wipe would re-seed from v1 balances that may now lag the real ledger contributions during the brief v2 window, and the accreditations that did write v2 would lose their opening context. If a re-flip is desired, leave the ledger exactly as-is — seeds still point at the correct v1 baseline, partial-v2 entries chain off them, and normal operation resumes.

## Part B — Per-accreditation cutover

### Recommendation

**Bulk seed-only backfill, run against each environment while the flag is still OFF, before the flag flips on in that environment.**

For each accreditation with a non-zero v1 balance or any v1 transactions, write one or two **cutover-seed** ledger transactions carrying the v1 closing totals forward as the ledger's opening state. From the flag flip onward, every new write appends to an already-correctly-totalled ledger.

### Why seed-only, not full-fidelity backfill

Full-fidelity backfill — one ledger transaction per historical v1 embedded transaction — would be the textbook answer. It is rejected because v1 transaction entities carry the naked `rowId` plus waste-record version ids (`currentVersionId`, `previousVersionIds[]`), but no direct `wasteRecordId` or `summaryLogId`. An accreditation's historical v1 transactions cannot be deterministically mapped back to waste records without a join that is ambiguous for any accreditation where the same `rowId` appears across multiple summary logs — which is the normal case for monthly uploads of the same supplier row.

The version-id fields could narrow the join via the waste-records collection's version history, but the complexity of that migration is disproportionate to the value. A seed-only backfill achieves the same correctness for current balance with a one-line-per-accreditation script.

### Why not bare on-next-write (the ADR's literal wording)

The ADR says "reads fall back to v1 until each accreditation has been transitioned to the ledger". The simplest reading is: first v2 write creates the first ledger entry, reads flip to v2 from that point. This fails:

| Scenario                                                                       | v1 balance                            | First post-flip event                                       | v2 ledger closing   | v2 reads | Correct balance | Result    |
| ------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------- | ------------------- | -------- | --------------- | --------- |
| Accreditation A, full re-upload of every summary log that built the v1 balance | 500 (from five rows × 100, one log)   | Five identical-target rows, reconciliation delta = 100 each | 500                 | 500      | 500             | ✓ by luck |
| Accreditation B, new summary log with new rows                                 | 500 (built up over prior months/logs) | Three new rows × 100, reconciliation delta = 100 each       | 300                 | 300      | 800             | ✗         |
| Accreditation C, PRN operation                                                 | 500                                   | Issuance emits pending-debit of 50                          | opens 0, closes -50 | -50      | 450             | ✗         |

Scenario A only passes because the operator happens to re-upload every single row that contributed to v1 — a coincidence, not a property of bare-on-next-write. If the v1 balance was built over several months' uploads and the operator re-uploads only the current month, the ledger closes well short of 500 and the read is wrong, exactly like scenario B. Bare-on-next-write is 0 of 3 as a cutover mechanism; scenario A is there to show the near-miss, not a partial success.

The write path computes `delta` per row against the ledger's own history (per ADR §Per-row delta reconciliation) or, for PRN operations, uses the delta directly. In both cases the ledger's opening totals default to zero for a newly-transitioned accreditation, so the closing totals reflect only what happened post-transition — they ignore the v1 history the dual-read fallback would have surfaced.

The reconciliation invariant's "re-upload is the recovery path" framing in the ADR is about **partial-submission recovery mid-write**, not about cutover. Cutover is a different problem and needs a different mechanism.

### Seed shape

One seed transaction per accreditation where `amount = availableAmount` on v1:

```
{
  accreditationId, organisationId, registrationId,
  number: 1,
  type: 'credit',
  amount: v1.amount,
  openingAmount: 0, closingAmount: v1.amount,
  openingAvailableAmount: 0, closingAvailableAmount: v1.amount,
  source: {
    kind: 'cutover-seed',
    cutoverSeed: { carriedFromV1At: <iso-ts>, v1BalanceId: <mongo-oid> }
  },
  createdAt: <iso-ts>, createdBy: 'system:cutover'
}
```

Two seed transactions where `availableAmount < amount` (pending PRN debits present on v1):

1. A `credit` transaction as above, closing at `(amount, amount)`.
2. A `pending_debit` at `number: 2`, opening `(amount, amount)`, closing `(amount, availableAmount)`. `source.kind = 'cutover-seed'`.

The `cutover-seed` source kind is added as a fourth variant alongside `summary-log-row`, `prn-operation`, and `manual-adjustment`. It is distinct from `manual-adjustment` because there is no admin actor — a reason-for-audit query that looks for `manual-adjustment` should not pick these up, and the operations team needs a stable predicate to count "how many accreditations have been seeded" as cutover progresses.

### Sequencing with the PAE-1364 recovery uploads

The seven PAE-1364-affected accreditations are being asked to re-upload under the workaround in [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091). That brings their v1 `amount` / `availableAmount` to a correct state. The cutover order is:

1. PAE-1364 recovery re-uploads complete (already in flight).
2. Flag-gated write and read paths deploy everywhere, flag OFF (the epic's `.10`, `.11`, `.12` beads).
3. Backfill runs against dev → test → ext-test → perf-test → prod, each immediately before that environment's flag flip. The backfill script is idempotent: running it twice produces no additional seeds because a seed is only written when the ledger is empty for that accreditation.
4. Flag flips in the same environment order, following the promotion gates.

Running the backfill once per environment (rather than once globally against prod-only) is deliberate: each environment gets a correctness check before its flag flips, and `perf-test` in particular gets a realistically-populated ledger to measure against.

### Backfill concurrency with live v1 traffic

While the flag is OFF, no read or write path touches the ledger, but the backfill script reads `amount` / `availableAmount` off each v1 waste-balance document — and those values can still mutate from live summary-log submissions and PRN operations while the script runs. Options, in preferred order:

1. **Schedule the backfill in a low-traffic window per environment.** The script's wall-clock is proportional to accreditation count; even for prod, minutes rather than hours. Non-prod environments tolerate an announced freeze; prod schedules its backfill alongside the flag flip in the same low-traffic window already agreed for other database migrations.
2. **Read the v1 document's current shape plus its implicit version and seed idempotently.** Re-reading and rewriting a seed if the captured `amount` disagrees with the document is feasible — the seed is at `number=1`, so correcting a drift is a delete-and-reinsert on the first ledger row. Messy but recoverable.

Option 1 is simpler and cheaper. `.14` picks between them with knowledge of the actual accreditation count and the agreed maintenance window.

Under the per-row reconciliation invariant, a seed whose captured value is slightly stale does not break subsequent writes — new summary-log submissions reconcile row-by-row against ledger history that is wasteRecordId-scoped, independent of the seed's closing totals. The seed's accuracy only matters for read correctness at the moment of the flip. Any drift that lands in the window between "backfill captured value" and "flag flipped on" surfaces as a small balance discrepancy on first read, which is detectable via the cutover-integrity dashboard panel.

### Accepted residual risk

Post-cutover, if an operator re-uploads a summary log that was originally submitted **pre-cutover**, the reconciliation invariant inflates the ledger because the row has no prior ledger history (the seed doesn't count for row-keyed reconciliation). Concretely: a row with `targetAmount = 100` that contributed 100 to v1 pre-cutover produces a fresh +100 ledger transaction on re-upload post-cutover. The seed already carries the original 100, so the ledger closing becomes 600 instead of 500.

This is acceptable because:

- PAE-1364 recovery (the known pre-cutover re-upload driver) completes before cutover per the sequence above.
- Regular operator behaviour is to re-upload within the current reporting month, not to revise historic summary logs. Post-cutover re-uploads of pre-cutover data are rare.
- The inflation is detectable: an accreditation whose ledger closing exceeds its summed waste-records target is a red flag. A dashboard panel for this ratio (§Observability) catches it.
- Correction exists: the operations team can post a `manual-adjustment` debit to restore correctness when a case is reported. This is the same escape hatch the ADR already reserves for any out-of-band balance correction.

If this residual risk is judged unacceptable, the alternative is full-fidelity backfill with the ambiguity handling costs above. The recommendation is to accept the risk and keep the backfill script simple.

## Observability

`epr-backend` emits custom metrics via AWS Embedded Metric Format (`aws-embedded-metrics`) using the helpers in `src/common/helpers/metrics.js`. Metrics land in CloudWatch under the service's namespace and are visualised in the CDP Grafana dashboards (CDP [custom metrics](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/custom-metrics.md) and [monitoring](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/monitoring.md) guides). Metric names use dotted CamelCase and dimension values are lowercased; the existing `summaryLog.statusTransition`, `summaryLog.validation.duration`, and `summaryLog.rows.outcome` set the convention. There is no existing `wasteBalance.*` metric namespace yet — this proposal introduces one.

The spike settles **what signals are needed and at what threshold**. Exact metric names, dimension keys, and stat-aggregation choices (sum vs average vs p99) are confirmed in `.14` against the `summaryLog.*` precedents; the shape below is indicative.

### Signals

| Signal                                  | Proposed metric                          | Dimensions                                                                                                              | Purpose                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger write throughput and retry shape | `wasteBalance.ledger.write`              | `sourceKind` (`summary-log-row` / `prn-operation` / `manual-adjustment`), `outcome` (`success` / `retry` / `exhausted`) | Per-source-kind counts; retry and exhausted outcomes expose contention behaviour under load.                                                            |
| Ledger write latency                    | `wasteBalance.ledger.write.duration`     | `sourceKind`                                                                                                            | Duration in ms. Grafana surfaces avg/p95/p99 via CloudWatch stats.                                                                                      |
| Ledger read distribution                | `wasteBalance.ledger.read`               | `primitive`, `outcome` (`ledgerHit` / `v1Fallback` / `error`)                                                           | `v1Fallback` count trends to zero as cutover completes per environment.                                                                                 |
| Ledger read latency                     | `wasteBalance.ledger.read.duration`      | `primitive` (`getCurrentBalance`, `getCreditedAmountByWasteRecordId`, …)                                                | Duration in ms per primitive. Baseline captured pre-flip; post-flip should be equal or better.                                                          |
| Cutover progress                        | `wasteBalance.cutover.seed`              | `seedShape` (`single` / `split`)                                                                                        | Incremented by the backfill script per seed written. Paired with a known total accreditation count gives % progress.                                    |
| Ledger inflation guard                  | `wasteBalance.ledger.inflationSuspected` | —                                                                                                                       | Emitted when a read surfaces a closing amount materially different from the sum of its waste-records targets (heuristic — see §Accepted residual risk). |

### Dashboards

The service already has a platform-provisioned dashboard per CDP convention. For the rollout, add a custom dashboard in `Playground/epr-backend-monitoring` per the CDP monitoring guide, then request promotion after dev bakes in:

1. **Rollout progress.** `wasteBalance.ledger.read` split by `outcome`, per environment. `v1Fallback` fraction trending to zero is the cutover-complete signal.
2. **Write health.** `wasteBalance.ledger.write.duration` p99 per `sourceKind`; `wasteBalance.ledger.write` with `outcome=retry` rate and `outcome=exhausted` rate. Exhausted panel has a "should always be zero" annotation.
3. **Cutover integrity.** `wasteBalance.ledger.inflationSuspected` rate alongside `wasteBalance.cutover.seed` cumulative totals per environment.

Dashboards are created in the `Playground/` folder first (dev only — non-Terraform-managed), and promoted to `CDP_Tenants/epr-backend/` via #cdp-support. The promotion needs to happen before the flag flips in test or higher — otherwise we're watching a lagging view.

### Alerts

Alerts are created as Grafana advanced alerts in the `epr-backend-advanced-alerts` evaluation group (dev playground first, promoted per the CDP monitoring guide).

- `wasteBalance.ledger.write` with `outcome=exhausted` rate > 0 sustained 5 min → page. Steady-state should be zero; any surfaced `LedgerContentionError` indicates a bug or pathological load.
- `wasteBalance.ledger.write.duration` p99 > 2× the pre-flip baseline, sustained 10 min → warn.
- `wasteBalance.ledger.read.duration` p99 > 2× the pre-flip baseline, sustained 10 min → warn.
- `wasteBalance.ledger.read` with `outcome=error` rate > 0.1/s sustained 5 min → page.
- `wasteBalance.ledger.inflationSuspected` rate > 0 over 24h → warn. Not a page — the heuristic will false-positive occasionally and corrections are manual.

The platform-default alerts (CPU, memory, HTTP-status, response time) continue to apply. This rollout adds the ledger-specific set on top of that default floor.

Pre-flip baselines: capture read-path p99 per primitive from the `epr-backend` default dashboard for the 7 days before each environment's flag-flip PR lands. Two-weeks-pre is too far; same-week-pre catches any contemporaneous regressions.

## Consequences

- The cutover-seed `source.kind` is a new fourth variant in the ledger schema. Joi validation for the ledger document needs to accept it alongside `summary-log-row`, `prn-operation`, and `manual-adjustment`. Writers other than the backfill script do not emit this kind.
- The backfill script is operationally non-trivial to run against prod: it touches every accreditation's waste-balance document once. Running it while the flag is OFF means no live read or write path touches the ledger during the run, which keeps it simple.
- Observability instrumentation is additive to the existing waste-balance routes and repository layer; adding it should not require API changes.
- The accepted residual risk around post-cutover re-uploads of pre-cutover summary logs is monitor-and-correct rather than prevent-by-design. This is worth revisiting if the operations team reports any such case in the first six months post-cutover.

## Open questions for `.14` scoping

These do not block sign-off of this recommendation; they are the first questions the implementing bead needs to answer.

- Exact metric names and dimension keys against the `summaryLog.*` precedents in `src/common/helpers/metrics/`.
- Backfill script location (standalone script in `epr-backend/scripts/`, MongoDB migration, or one-shot admin endpoint). Constraint: it must run under the same network and credentials path as the service in each environment.
- Whether the backfill window is announced as a brief freeze (preferred) or reconciled idempotently (§Backfill concurrency). Decision depends on the agreed operational window for the prod flag flip.
- Rollout sub-beads: whether to break `.14` into one bead per environment plus one for the backfill script, or whether a single bead with per-environment checkboxes is sufficient.
- Whether `perf-test` gets its own bead or is folded into the prod bead's pre-flip step.

## ADR 0031 consistency follow-up

ADR 0031's Decision section says "reads fall back to it [the v1 collection] until each accreditation has been transitioned to the ledger". As §Part B of this doc shows, bare-on-next-write cannot deliver "transitioned" correctly. Once this recommendation is signed off, ADR 0031 should be amended (as an update-in-place or a superseding ADR, whichever the team prefers) to reference seed-only backfill as the transition mechanism and to describe `cutover-seed` as a source kind. Otherwise the ADR stays inconsistent with its own operationalisation.

## Related

- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md)
- [ADR 0027 — Modular monolith structure](../decisions/0027-modular-monolith-structure.md)
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [CDP custom metrics guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/custom-metrics.md)
- [CDP monitoring guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/monitoring.md)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the ledger cutover enables retiring
