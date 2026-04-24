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

Introduce a second collection holding one commit-marker document per accreditation. The marker names the current canonical latest transaction by `_id`. Writers insert new transactions chained backward to the existing canonical head via a `predecessorId` field, then atomically advance the marker to the new head. A crash before that advance leaves the inserted rows in the ledger as an unreferenced branch: they are reachable by brute-force query but not from the canonical-head pointer, so canonical-history reads do not see them.

This shape treats the ledger as a DAG of candidate chains rather than a single append-only sequence. In the steady state (no contention, no crashes) the DAG is linear and indistinguishable from an append-only log. Contention and crashes produce short-lived sibling branches that never become canonical; orphan branches are reclaimed by a separate (lazy) garbage-collection concern.

### Shape

**`waste-balance-ledger`** — extended from ADR 0031's shape with a `predecessorId` field and a weakened uniqueness constraint:

- All fields from ADR 0031 (accreditationId, number, source, type, amount, opening/closing totals, etc.) are retained.
- New: `predecessorId` — the `_id` of the previous transaction in this chain, or null for the first ever transaction on the accreditation.
- Uniqueness on `(accreditationId, number)` is **dropped**. Under this shape multiple transactions may share a number — they are sibling candidate branches at the same depth. The default `_id` uniqueness is sufficient.
- Indexes on `(accreditationId, number)` and `(accreditationId, predecessorId)` are retained as **non-unique** — the first for range queries, the second for forward chain walks during garbage collection.

**`waste-balance-commitments`** (new):

- `accreditationId` — primary key.
- `canonicalHeadId` — the `_id` of the current canonical latest transaction. The authoritative pointer.
- `committedNumber` — denormalised from the canonical head's `number`. Convenience field for range queries and for debugging.
- `closingAmount`, `closingAvailableAmount` — the closing totals at the canonical head. Denormalised so that reading the current balance is a single read on the marker rather than a marker-then-ledger round-trip.
- `lastSourceId` _(optional)_ — e.g. the most recently committed `summaryLogId`. Enables a log-level idempotency shortcut ("have we already committed this summary log?") on top of the per-row reconciliation that remains authoritative.

### Write path for a batch

For each summary-log submission or PRN operation:

1. Read the commit marker → `canonicalHeadId = X`, `committedNumber = N`, closing totals `(A, V)`.
2. Compute the batch's K transactions. Assign `predecessorId` by chaining from X: the first transaction has `predecessorId = X` and `number = N + 1`; each subsequent transaction's `predecessorId` is the preceding transaction's `_id` with `number` incremented. Carry closing totals forward row by row.
3. Insert all K transactions into the ledger. Each insert returns its generated `_id`; the next in the chain references it.
4. Advance the commit marker atomically:

   ```
   updateOne(
     { accreditationId, canonicalHeadId: X },
     { $set: { canonicalHeadId: lastInsertedId,
               committedNumber: N + K,
               closingAmount: A',
               closingAvailableAmount: V',
               lastSourceId: ... } }
   )
   ```

   If the match fails because another writer has already advanced the marker, the just-inserted chain is orphaned (its root's `predecessorId` no longer matches the canonical head). Retry from step 1, which re-reads the new canonical head and rebases the batch on top of it.

There is no pre-insert sweep. The ledger inserts themselves are race-free — they never conflict, because every insert produces a unique `_id` and no uniqueness constraint on `(accreditationId, number)` can reject a sibling. The only serialisation point across writers is the compare-and-swap on `canonicalHeadId` in step 4.

### Read path

- **Current balance** — read the commit marker. One indexed read. Its `closingAmount` and `closingAvailableAmount` are authoritative.
- **Canonical history** — walk backward from `canonicalHeadId` via `predecessorId`, stopping at the required depth (or at null for the full chain). O(depth) reads. This is the only read path that deterministically excludes orphan branches regardless of garbage-collection state.
- **Range query by number** — `find({accreditationId, number: {$gte: A, $lte: B}})` may return orphan rows in addition to canonical rows when orphans exist. In the steady state (no recent contention or crashes, or after garbage collection has run) the ledger is linear at every number and the query is exactly the canonical slice. When orphans are present and the caller needs a canonical-only answer, filter against the chain derived from `canonicalHeadId`.

### Crash semantics

A crash between steps 3 and 4 leaves the inserted chain in the ledger with its root still pointing to the prior canonical head, but the canonical head pointer is unmoved. The orphan chain is unreachable via `predecessorId`-walks from `canonicalHeadId` and is therefore invisible to canonical-history reads. Visibility is binary: a batch is either fully committed (canonical head advanced to its tail) or not part of the canonical chain at all.

The per-row delta reconciliation invariant is retained: an operator re-upload after a crash still resolves the logical shortfall, just as it does under ADR 0031. The difference is that between crash and re-upload, the balance the ledger reports is the _prior_ state rather than the _partial_ state.

### Concurrency

Two writers on the same accreditation do not contend at the ledger at all — their inserts succeed independently, producing two sibling chains rooted at the same prior canonical head. Contention resolves at step 4's compare-and-swap on `canonicalHeadId`: only the first writer to reach it advances the canonical head. The loser observes the CAS mismatch, discards its now-orphaned chain conceptually (the rows remain in the ledger for GC to reclaim), re-reads the new canonical head, and rebases its batch. No `(accreditationId, number)` unique-index contention, no delete-then-insert race between writers.

An earlier formulation of this alternative held `(accreditationId, number)` unique and swept orphans inline before insert. That shape exposes a race: between writer A's insert and its CAS, writer B may sweep A's uninserted-but-committed rows; A's CAS still succeeds because it only checks the commitment doc, leaving the commitment doc pointing at rows that no longer exist. The `predecessorId`-chain shape replaces that inline-sweep coupling with a structural invariant (canonical chain = what's reachable from `canonicalHeadId`), which holds without coordination between ledger and marker writes.

### Orphan garbage collection

Orphan chains accumulate in two cases: writer crashes between insert and CAS, and CAS losers under concurrent writes. Neither affects the correctness of the canonical balance or canonical history — they are storage overhead only.

Reclamation can be lazy. A periodic sweep per accreditation walks backward from `canonicalHeadId` via `predecessorId` to enumerate the canonical chain, then deletes any ledger rows for that accreditation whose `_id` is not a member of that chain. Alternatively, opportunistic cleanup on the write path can delete sibling chains as soon as the CAS winner is known — cheap when contention is rare, skippable when the CAS does not actually race.

Orphans tolerated without cleanup cost nothing other than disk space; they are invisible to canonical-chain reads and distinguishable from the canonical chain by reachability from `canonicalHeadId`. An optional TTL (e.g. "rows older than 7 days not on the canonical chain are deleted") is sufficient for any realistic contention pattern.

## Why it is attractive

- **Atomic switch between two visible states.** At any instant, canonical-history readers see either the pre-batch ledger or the fully-committed post-batch ledger; never a partial batch. Removes the "balance is briefly wrong with respect to the submission" window ADR 0031 leaves open.
- **Single-read balance remains constant-cost.** The commit marker carries the closing totals, so current-balance reads stay O(1) — they just read a different collection.
- **Race-free ledger writes.** Ledger inserts never contend; the only serialisation point between concurrent writers is the compare-and-swap on `canonicalHeadId`. The sweep-and-insert race present in an inline-cleanup variant of this shape does not exist.
- **Forensic trail is preserved until GC.** Failed write attempts (crashed or CAS-loser) remain in the ledger as unreferenced branches. That is occasionally useful for debugging and costs nothing until garbage collection is tuned aggressively.
- **No multi-document transactions required.** Works on ordinary MongoDB write semantics, well-matched to CDP's Percona replica-set deployment and imposing no new operational concepts.
- **Additive on top of ADR 0031.** If adopted later, the ledger's transaction shape gains `predecessorId` and loses a uniqueness constraint, and a new commitment collection is introduced. Readers shift from "latest ledger row by number" to "canonical head by `_id`." Migration is tractable.

## Why not adopted

- **Re-upload convergence is already the designed recovery path.** The per-row delta reconciliation invariant means a re-upload after any partial state converges to the correct totals. The only property the commit marker adds on top is that _between_ crash and re-upload, readers see the prior state rather than a partial state. Whether that distinction justifies a new collection and a new garbage-collection concern is the whole question, and the current answer is no.
- **The window is narrow and self-correcting in practice.** Summary-log submissions are operator-driven and infrequent, a crash mid-submission is already an incident, and re-upload is the operator-facing resolution. The population of readers genuinely harmed by a briefly-wrong balance (rather than by the underlying crash) is small.
- **Two collections and a GC concern to migrate, reason about, and keep consistent.** Not large, but not free. Each accreditation now has ledger rows _and_ a commitment document, any future work touching balance semantics has two places to think about, and orphan garbage collection is a new operational surface.
- **History reads are no longer simple range queries.** Canonical-chain reads require a chain walk from `canonicalHeadId`, or a range query combined with a reachability filter. In the steady state this degrades to a trivial query, but readers must be written to handle the contested case correctly.
- **YAGNI.** No current consumer is known to be harmed by the partial-batch window in ways re-upload does not resolve. Adopting this shape now would be reserving against a hypothetical at non-trivial cost.

## Consequences

- ADR 0031 stands unchanged. The partial-batch window remains an explicit negative consequence resolved by re-upload.
- If operational experience reveals the partial-batch window to be genuinely costly — e.g. a downstream consumer that cannot tolerate briefly-inaccurate balances, a pattern of operator confusion on interim state, or a reporting surface where intermediate state surfaces externally — this ADR is the documented remediation path. Adopting it at that point would be an additive change on top of the existing ledger shape, not a rework of it.
- Future contributors landing on ADR 0031's negative consequences can find, here, both the shape of the alternative and the reasoning for not applying it prophylactically.

## Related

- [ADR 0031 — Waste balance transaction ledger](0031-waste-balance-transaction-ledger.md) — the design this ADR records a considered alternative to.
- [PAE-1382](https://eaflood.atlassian.net/browse/PAE-1382) — driver ticket for the ledger work.
