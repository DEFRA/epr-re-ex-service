# 32. Waste balance commit marker (considered alternative to ADR 0031)

Date: 2026-04-24

## Status

Rejected

## Context

[ADR 0031](0031-waste-balance-transaction-ledger.md) moves waste balance transactions out of the embedded `transactions[]` array into a dedicated append-only ledger collection, with each transaction carrying its own running totals so that the current balance is the closing totals on the latest entry — a single indexed read.

The shape leaves one concession visible in its negative consequences: a summary-log submission writes N ledger transactions via per-row optimistic appends rather than as a single atomic operation. A crash between the first and last row leaves K of N transactions committed. The authoritative balance at that point is the closing totals on the latest committed row, which is inaccurate with respect to the submitted summary log. Nothing in the ledger distinguishes this interim state from a fully-committed submission until the operator re-uploads. Recovery relies on the per-row delta reconciliation invariant (credits already present produce zero deltas, missing credits emit their full amounts) and the designed operator-re-upload path. The system converges, but only on re-submission.

This ADR records a considered alternative that removes the partial-batch visibility window entirely using only ordinary MongoDB write semantics — no multi-document transactions. It was explored, found workable, and not adopted. It is recorded here because the shape is attractive, the implementation is tractable, and if operational experience ever shifts the balance of forces the remediation path is thought through rather than rediscovered.

## Decision

Retain ADR 0031 as it stands. Do not introduce a commit-marker document.

## The considered alternative

Introduce a second collection holding one commit-marker document per accreditation. The marker records the `number` of the latest ledger transaction considered committed for that accreditation along with its closing totals. Writers append ledger transactions in the usual append-only way, then atomically advance the commit marker as the final step of the batch. A crash before that advance leaves the mid-batch ledger rows in place but invisible to readers.

### Shape

**`waste-balance-ledger`** — exactly as ADR 0031 defines it. No change.

**`waste-balance-commitments`** (new):

- `accreditationId` — primary key.
- `committedNumber` — the `number` of the latest ledger transaction considered part of the authoritative balance for this accreditation.
- `closingAmount`, `closingAvailableAmount` — the closing totals at `committedNumber`. Denormalised from the ledger row so that reading the current balance is a single read on the marker rather than a marker-then-ledger round-trip.
- `lastSourceId` *(optional)* — e.g. the most recently committed `summaryLogId`. Enables a log-level idempotency shortcut ("have we already committed this summary log?") on top of the per-row reconciliation that remains authoritative.

### Write path for a batch

For each summary-log submission or PRN operation:

1. Read the commit marker → `committedNumber = C`, closing totals `(A, V)`.
2. Sweep any ledger orphans: `deleteMany({accreditationId, number: {$gt: C}})`. Idempotent. Only affects rows left behind by a prior crashed writer.
3. Compute the batch's N transactions, assigning numbers `C+1 … C+N` and carrying the closing totals forward row by row.
4. Insert all N transactions into the ledger. The `(accreditationId, number)` unique index serialises slot allocation exactly as in ADR 0031; a losing writer retries from step 1.
5. Advance the commit marker atomically:

   ```
   updateOne(
     { accreditationId, committedNumber: C },
     { $set: { committedNumber: C + N,
               closingAmount: A',
               closingAvailableAmount: V',
               lastSourceId: ... } }
   )
   ```

   If the match fails because another writer has already advanced the marker, retry from step 1.

### Read path

- **Current balance** — read the commit marker. One indexed read. Its `closingAmount` and `closingAvailableAmount` are authoritative.
- **Ledger history** — `find({accreditationId, number: {$lte: committedNumber}}).sort({number: -1})`. The `$lte` filter automatically hides any uncommitted rows left by a crashed writer.

### Crash semantics

A crash between steps 3 and 5 leaves K of N ledger rows inserted but the marker still at C. Readers see the pre-batch state. On the next write attempt, step 2 sweeps the orphans before allocating. Visibility is binary: a batch is either fully committed or not visible at all.

The per-row delta reconciliation invariant is retained: an operator re-upload after a crash still resolves the logical shortfall, just as it does under ADR 0031. The difference is that between crash and re-upload, the balance the ledger reports is the *prior* state rather than the *partial* state.

### Concurrency

Two writers on the same accreditation contend at the `(accreditationId, number)` unique index exactly as under ADR 0031 — the loser retries. The commit-marker advance is the same writer's next step after its inserts succeed, so the marker is not a new contention surface between different writers' batches. In the extreme case of two writers each having successfully inserted disjoint ledger ranges (A: `C+1..C+3`, B: `C+4..C+7`), the marker's conditional update (`committedNumber: C`) rejects whichever arrives second; that writer, on retry, finds its own rows already present and advances the marker to include them.

## Why it is attractive

- **Atomic switch between two visible states.** At any instant, readers see either the pre-batch ledger or the fully-committed post-batch ledger; never a partial batch. Removes the "balance is briefly wrong with respect to the submission" window ADR 0031 leaves open.
- **Single-read balance remains constant-cost.** The commit marker carries the closing totals, so current-balance reads stay O(1) — they just read a different collection.
- **Orphan cleanup is inline on the write path.** No background sweeper, no alerting on orphan accumulation, no "did the sweep run" question.
- **No multi-document transactions required.** Works on ordinary MongoDB write semantics, well-matched to CDP's Percona replica-set deployment and imposing no new operational concepts.
- **Additive on top of ADR 0031.** If adopted later, the ledger shape does not change. The commitment collection is new, readers move from "latest ledger row" to "commit marker," and the sweep becomes part of the write path. Migration is tractable.

## Why not adopted

- **Re-upload convergence is already the designed recovery path.** The per-row delta reconciliation invariant means a re-upload after any partial state converges to the correct totals. The only property the commit marker adds on top is that *between* crash and re-upload, readers see the prior state rather than a partial state. Whether that distinction justifies a new collection is the whole question, and the current answer is no.
- **The window is narrow and self-correcting in practice.** Summary-log submissions are operator-driven and infrequent, a crash mid-submission is already an incident, and re-upload is the operator-facing resolution. The population of readers genuinely harmed by a briefly-wrong balance (rather than by the underlying crash) is small.
- **Second collection to migrate, reason about, and keep consistent.** Not large, but not free. Each accreditation now has ledger rows *and* a commitment document, and any future work touching balance semantics has two places to think about.
- **YAGNI.** No current consumer is known to be harmed by the partial-batch window in ways re-upload does not resolve. Adopting this shape now would be reserving against a hypothetical.

## Consequences

- ADR 0031 stands unchanged. The partial-batch window remains an explicit negative consequence resolved by re-upload.
- If operational experience reveals the partial-batch window to be genuinely costly — e.g. a downstream consumer that cannot tolerate briefly-inaccurate balances, a pattern of operator confusion on interim state, or a reporting surface where intermediate state surfaces externally — this ADR is the documented remediation path. Adopting it at that point would be an additive change on top of the existing ledger shape, not a rework of it.
- Future contributors landing on ADR 0031's negative consequences can find, here, both the shape of the alternative and the reasoning for not applying it prophylactically.

## Related

- [ADR 0031 — Waste balance transaction ledger](0031-waste-balance-transaction-ledger.md) — the design this ADR records a considered alternative to.
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver ticket for the ledger work.
