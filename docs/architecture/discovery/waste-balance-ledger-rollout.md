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
- `infra-dev`, `infra-test`, and `management` are not customer-facing and are not in the promotion path; they do not need the flag set.

### Promotion gates

Each step requires signals to clear before the next flag-flip PR lands in `cdp-app-config/main/services/epr-backend/<env>/epr-backend.env`.

| Environment | Soak                                                                       | Required signals                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev         | 3–5 working days                                                           | No unhandled exceptions in logs referencing ledger writes or reads. `waste_balance_ledger_contention_exhausted_total = 0`. Journey tests green.                                                                                                                                                                     |
| test        | 3–5 working days                                                           | Same as dev, plus end-to-end journey tests covering summary-log submission and PRN lifecycle green against v2.                                                                                                                                                                                                      |
| ext-test    | 5 working days                                                             | Same as test, plus at least one external reprocessor has a v2 transaction written through normal operation (observable via `waste_balance_ledger_writes_total` trending up).                                                                                                                                        |
| perf-test   | One full perf run (summary-log submission at peak scale) plus 48-hour soak | Write-path p99 latency within the agreed SLO envelope. Read-path p99 unchanged or improved against the v1 baseline captured pre-flip. `waste_balance_ledger_contention_exhausted_total = 0` across the full run. No unexpected query-planner regressions visible in MongoDB Atlas explain plans on the new indexes. |
| prod        | Ongoing monitoring                                                         | Flag flip lands in a low-traffic window; first 72 hours are tightly monitored per the alert rules in §Observability.                                                                                                                                                                                                |

"Signals clear" means the reviewer of the next flag-flip PR can point at the dashboards and alerting history for the previous environment and show that the gates above are met. This is a human judgement; dashboards and metric names below are the inputs.

### Rollback protocol

Flag flip `true → false` is safe at any point while v1 still exists (until the epic's final bead retires it):

- The dual-read helper stops reading the ledger and reverts to reading `amount` / `availableAmount` from the waste-balance document.
- The v1 write path has remained in place throughout the epic — summary-log submissions and PRN lifecycle events go back to updating the embedded array.
- Ledger transactions written during the flag-ON window are durable but inert — they are not read and they are not deleted. If the flag is later flipped back on, they pick up where they left off.

The **side-effect worth naming**: during the flag-ON window the v1 `amount` / `availableAmount` fields are not updated, because the v2 write path replaces the v1 write path rather than running both. So a rollback after any v2 writes have happened reverts reads to the pre-flip v1 balance. Data is not lost (the ledger keeps every transaction), but recent state is not reflected in read paths until either (a) the flag flips back on, or (b) the operator re-uploads under v1 and rebuilds v1 from current waste-records state.

In practice: short rollbacks (minutes to hours) before many accreditations have written v2 transactions have essentially no customer-visible impact. Longer rollbacks after broad v2 adoption need a communications step and the operator-re-upload path as recovery. The flag-flip itself is not zero-downtime-fast — `cdp-app-config` changes trigger a redeploy of the service, so the rollback latency is 5–10 minutes, not seconds.

## Part B — Per-accreditation cutover

### Recommendation

**Bulk seed-only backfill, run against each environment while the flag is still OFF, before the flag flips on in that environment.**

For each accreditation with a non-zero v1 balance or any v1 transactions, write one or two **cutover-seed** ledger transactions carrying the v1 closing totals forward as the ledger's opening state. From the flag flip onward, every new write appends to an already-correctly-totalled ledger.

### Why seed-only, not full-fidelity backfill

Full-fidelity backfill — one ledger transaction per historical v1 embedded transaction — would be the textbook answer. It is rejected because v1 transaction entities carry only `rowId` (the naked row identifier within a summary log), not `summaryLogId` or `wasteRecordId`. An accreditation's historical v1 transactions cannot be deterministically mapped back to waste records without a join that is ambiguous for any accreditation where the same `rowId` appears across multiple summary logs — which is the normal case for monthly uploads of the same supplier row. The PAE-1380-affected accreditations are the pathological version of this; the join is ambiguous for mainstream accreditations too.

`previousVersionIds[]` on v1 entities could narrow the join via the waste-records collection's version history, but the complexity of that migration is disproportionate to the value. A seed-only backfill achieves the same correctness for current balance with a one-line-per-accreditation script.

### Why not bare on-next-write (the ADR's literal wording)

The ADR says "reads fall back to v1 until each accreditation has been transitioned to the ledger". The simplest reading is: first v2 write creates the first ledger entry, reads flip to v2 from that point. This fails:

| Scenario                                           | v1 balance                 | First post-flip event                                       | v2 ledger closing   | v2 reads | Correct balance | Result |
| -------------------------------------------------- | -------------------------- | ----------------------------------------------------------- | ------------------- | -------- | --------------- | ------ |
| Accreditation A, re-upload of the same summary log | 500 (from five rows × 100) | Five identical-target rows, reconciliation delta = 100 each | 500                 | 500      | 500             | ✓      |
| Accreditation B, new summary log with new rows     | 500 (from prior months)    | Three new rows × 100, reconciliation delta = 100 each       | 300                 | 300      | 800             | ✗      |
| Accreditation C, PRN operation                     | 500                        | Issuance emits pending-debit of 50                          | opens 0, closes -50 | -50      | 450             | ✗      |

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

### Sequencing with the PAE-1380 recovery uploads

The seven PAE-1364-affected accreditations are being asked to re-upload under the existing PAE-1380 workaround ([epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091)). That brings their v1 `amount` / `availableAmount` to a correct state. The cutover order is:

1. PAE-1380 recovery re-uploads complete (already in flight).
2. Flag-gated write and read paths deploy everywhere, flag OFF (the epic's `.10`, `.11`, `.12` beads).
3. Backfill runs against dev → test → ext-test → perf-test → prod, each immediately before that environment's flag flip. The backfill script is idempotent: running it twice produces no additional seeds because a seed is only written when the ledger is empty for that accreditation.
4. Flag flips in the same environment order, following the promotion gates.

Running the backfill once per environment (rather than once globally against prod-only) is deliberate: each environment gets a correctness check before its flag flips, and `perf-test` in particular gets a realistically-populated ledger to measure against.

### Accepted residual risk

Post-cutover, if an operator re-uploads a summary log that was originally submitted **pre-cutover**, the reconciliation invariant inflates the ledger because the row has no prior ledger history (the seed doesn't count for row-keyed reconciliation). Concretely: a row with `targetAmount = 100` that contributed 100 to v1 pre-cutover produces a fresh +100 ledger transaction on re-upload post-cutover. The seed already carries the original 100, so the ledger closing becomes 600 instead of 500.

This is acceptable because:

- PAE-1380 recovery (the known pre-cutover re-upload driver) completes before cutover per the sequence above.
- Regular operator behaviour is to re-upload within the current reporting month, not to revise historic summary logs. Post-cutover re-uploads of pre-cutover data are rare.
- The inflation is detectable: an accreditation whose ledger closing exceeds its summed waste-records target is a red flag. A dashboard panel for this ratio (§Observability) catches it.
- Correction exists: the operations team can post a `manual-adjustment` debit to restore correctness when a case is reported. This is the same escape hatch the ADR already reserves for any out-of-band balance correction.

If this residual risk is judged unacceptable, the alternative is full-fidelity backfill with the ambiguity handling costs above. The recommendation is to accept the risk and keep the backfill script simple.

## Observability

The following metrics are added alongside the feature flag. Naming follows the `waste_balance_*` convention already present in the service's metric namespace (confirm against the existing Prometheus exposition before implementation).

### Metrics

| Name                                                | Type      | Labels                                                                         | Purpose                                                                                                                                                                                      |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waste_balance_ledger_writes_total`                 | counter   | `source_kind`, `outcome` (`success` / `conflict_retry` / `conflict_exhausted`) | Write throughput and retry shape per source kind.                                                                                                                                            |
| `waste_balance_ledger_write_duration_seconds`       | histogram | `source_kind`                                                                  | Write-path latency distribution.                                                                                                                                                             |
| `waste_balance_ledger_reads_total`                  | counter   | `primitive`, `outcome` (`ledger_hit` / `empty_v1_fallback` / `error`)          | Read distribution across primitives; the `empty_v1_fallback` count should trend to zero as cutover completes.                                                                                |
| `waste_balance_ledger_read_duration_seconds`        | histogram | `primitive`                                                                    | Read-path latency per primitive (`getCurrentBalance`, `getCreditedAmountByWasteRecordId`, etc).                                                                                              |
| `waste_balance_ledger_contention_retries_total`     | counter   | —                                                                              | Optimistic-append retry count (per-retry, not per-call). Non-zero is normal under load; unbounded growth isn't.                                                                              |
| `waste_balance_ledger_contention_exhausted_total`   | counter   | `source_kind`                                                                  | Retry budget exhausted → caller sees `LedgerContentionError`. Must be zero in steady state.                                                                                                  |
| `waste_balance_cutover_seeds_total`                 | counter   | —                                                                              | Seed transactions written. Incremented by the backfill script per seed.                                                                                                                      |
| `waste_balance_cutover_accreditations_seeded_total` | counter   | —                                                                              | Distinct accreditations seeded. Paired with the above to show ratio of 1- vs 2-seed accreditations.                                                                                          |
| `waste_balance_ledger_inflation_suspected_total`    | counter   | —                                                                              | A read returned a ledger closing amount materially different from the sum of targets on the accreditation's waste-records (see Dashboards). Emitted as a guard metric, not as an error path. |

### Dashboards

Three panels on a new `epr-backend-waste-balance-ledger` Grafana board:

1. **Rollout progress.** Stacked area of `waste_balance_ledger_reads_total` by outcome, split by environment. Empty-v1-fallback fraction trending towards zero as cutover progresses.
2. **Write health.** `waste_balance_ledger_write_duration_seconds` p50/p95/p99 per `source_kind`, `waste_balance_ledger_contention_retries_total` rate, `waste_balance_ledger_contention_exhausted_total` rate. The exhausted panel has a "should always be flat at zero" annotation.
3. **Cutover integrity.** Per-accreditation ledger closing vs summed waste-record targets, sampled. Material divergence surfaces the inflation-suspected risk called out in §Part B.

### Alerts

- `waste_balance_ledger_contention_exhausted_total` rate-over-5-min > 0 → page.
- Read-path p99 regression > 2× the pre-flip baseline, sustained 10 min → warn.
- Write-path p99 regression > 2× the pre-flip baseline, sustained 10 min → warn.
- `waste_balance_ledger_reads_total{outcome="error"}` rate-over-5-min > 0.1/s → page.

Metric names, label cardinalities, and histogram bucket choices all need a sanity check against the existing `waste_balance_*` metric conventions in `epr-backend` before implementation — any mismatch is easier to fix before the dashboards exist than after.

## Consequences

- The cutover-seed `source.kind` is a new fourth variant in the ledger schema. Joi validation for the ledger document needs to accept it alongside `summary-log-row`, `prn-operation`, and `manual-adjustment`. Writers other than the backfill script do not emit this kind.
- The backfill script is operationally non-trivial to run against prod: it touches every accreditation's waste-balance document once. Running it while the flag is OFF means no live read or write path touches the ledger during the run, which keeps it simple.
- Observability instrumentation is additive to the existing waste-balance routes and repository layer; adding it should not require API changes.
- The accepted residual risk around post-cutover re-uploads of pre-cutover summary logs is monitor-and-correct rather than prevent-by-design. This is worth revisiting if the operations team reports any such case in the first six months post-cutover.

## Open questions for `.14` scoping

These do not block sign-off of this recommendation; they are the first questions the implementing bead needs to answer.

- Exact metric names and label shapes against the existing `waste_balance_*` namespace in `epr-backend`.
- Backfill script location (standalone script in `epr-backend/scripts/`, MongoDB migration, or one-shot admin endpoint). Constraint: it must run under the same network and credentials path as the service in each environment.
- Rollout sub-beads: whether to break `.14` into one bead per environment plus one for the backfill script, or whether a single bead with per-environment checkboxes is sufficient.
- Whether `perf-test` gets its own bead or is folded into the prod bead's pre-flip step.

## Related

- [ADR 0031 — Waste balance transaction ledger](../decisions/0031-waste-balance-transaction-ledger.md)
- [ADR 0027 — Modular monolith structure](../decisions/0027-modular-monolith-structure.md)
- [Waste balance LLD](../defined/pepr-lld.md#waste-balance)
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver
- [PAE-1364](https://eaflood.atlassian.net/browse/PAE-1364) / [epr-backend#1091](https://github.com/DEFRA/epr-backend/pull/1091) — workaround the ledger cutover enables retiring
