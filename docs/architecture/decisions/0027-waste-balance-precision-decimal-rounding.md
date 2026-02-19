# 27. Waste Balance Precision: Remediation of IEEE 754 Floating-Point Rounding Errors

Date: 2026-02-18

## Status

Accepted

## Context

[PAE-1082](https://eaflood.atlassian.net/browse/PAE-1082) identified that waste balance totals stored in MongoDB could accumulate IEEE 754 floating-point rounding errors when many decimal credit/debit transactions were applied using native JavaScript arithmetic. For example, summing a sequence of values such as `28.48 + 27.96 + 14.84 + …` (80 operations) produces `537.5199999999999` rather than `537.52`.

The root cause was fixed at the point of calculation by switching to [Decimal.js](https://mikemcl.github.io/decimal.js/) for all waste balance arithmetic (`src/domain/waste-balances/decimal-utils.js`). However, affected documents written to MongoDB _before_ the fix was deployed retain their erroneous values and must be corrected.

The waste balance data model is append-only: each change is recorded as a discrete transaction (CREDIT, DEBIT, etc.) that is appended to the balance's `transactions` array. Direct mutation of existing transactions would break the audit trail.

Our platform is hosted on DEFRA's Core Delivery Platform (CDP). CDP provides a browser-based terminal that allows operators to open an interactive shell inside a running container for a specific environment and service. It is a manual, operator-driven tool and does not support scheduled or scripted execution outside of a session.

The affected field values all originated from two-decimal-place inputs. The data layer contract guarantees that all waste balance amounts are at most two decimal places before any arithmetic is applied. Therefore, any stored value that differs from its two-decimal-place rounded equivalent is the result of floating-point drift and can safely be treated as erroneous.

## Options

### Option 1: Issue remedial transactions on server boot / deploy

Introduce a new `ROUNDING_CORRECTION` transaction type. On startup, the server inspects every waste balance document; any document whose `amount` or `availableAmount` differs from its value rounded to two decimal places has a `ROUNDING_CORRECTION` transaction appended that brings the totals back to the exact two-decimal-place figure. The feature is guarded by a feature flag (`FEATURE_FLAG_WASTE_BALANCE_ROUNDING_CORRECTION`) with `false`, `true`, and `dry-run` modes. A distributed lock prevents concurrent instances from double-running the correction.

**Pros:**

- Runs automatically as part of a normal deploy — no manual operator intervention required
- Idempotent: a balance already at two decimal places is never touched; a second deploy is a no-op
- Auditable: the correction is permanently recorded as a first-class transaction in the append-only log, preserving the full change history
- Dry-run mode lets the team verify which balances would be corrected before enabling the live flag
- Follows the same pattern as `runGlassMigration`, an established convention in this codebase for startup data migrations
- Distributed locking prevents duplicate corrections when multiple instances start simultaneously
- The feature flag defaults to `false`, meaning the migration does not run unless explicitly enabled
- No dependency on human availability at the time of deployment

**Cons:**

- Adds a small amount of latency to server startup while the correction scan runs (mitigated by the flag defaulting to `false` and being disabled once the migration is confirmed complete)
- Requires a feature flag lifecycle: the flag must be enabled for the corrective deploy, then disabled / removed in a follow-up release

---

### Option 2: Issue remedial transactions via the CDP terminal

Use the CDP browser terminal to exec into a running container and run a one-off Node.js script that connects to the database and applies the same `ROUNDING_CORRECTION` transactions.

**Pros:**

- Completely decoupled from the application deployment lifecycle
- No changes to application code are required beyond the script itself
- The correction can be applied without a new release

**Cons:**

- Requires manual operator intervention: an engineer must be available, logged in to CDP, and execute the script at the right time in the right environment
- CDP terminal sessions are ephemeral and can be terminated at any point; a disconnection mid-run could leave the correction partially applied
- The CDP terminal is intended for interactive debugging, not for running long-running or production-critical data operations
- Multiple environments (dev, staging, production) each require a separate manual step, increasing the risk of human error or an environment being missed
- No mechanism to prevent two operators from running the script simultaneously without coordination
- Harder to test end-to-end within the standard CI pipeline; the script exists outside the main application lifecycle

---

### Option 3: Modify existing transactions and recalculate

Directly update each historical transaction document to replace its erroneous amount values with the correct figures, then recompute the final `amount` and `availableAmount` totals from the corrected history.

**Pros:**

- Leaves no trace of the original error in the `transactions` array
- The history reads as if the bug never existed

**Cons:**

- Mutating historical records violates the append-only audit trail that underpins the waste balance data model; an external audit would observe that records were altered after the fact
- Requires identifying and touching every individual transaction that contributed to a drifted total, not just the final balance document — significantly higher blast radius
- Recalculating totals from a modified history is complex: the system must correctly distinguish CREDIT, DEBIT, and PRN ring-fence / issue / cancellation operations to derive the right final values
- Any mistake in recalculation would produce an incorrect total with no easy recovery path
- Data integrity guarantees for MongoDB Decimal128 fields and the version/schema fields across all affected documents must be carefully maintained during the bulk update
- Difficult to make idempotent: re-running against already-modified records requires additional guard logic

---

### Option 4: Leave data as-is and round on read / write

Accept the erroneous values in the database and apply rounding to two decimal places whenever values are read from or written to the database, masking the error at the repository boundary.

**Pros:**

- No database writes required; zero risk of data corruption during remediation
- No migration code to write, test, or maintain

**Cons:**

- The incorrect values persist indefinitely; the stored data does not reflect the true waste balance
- Rounding on every read introduces silent, invisible transformations that make it harder to reason about what is actually in the database
- Any consumer of the raw MongoDB documents (reporting tools, the admin UI, data exports, future reads before the rounding layer is applied) would still observe the erroneous values
- Does not satisfy a strict audit requirement: the data record should reflect what tonnage was actually credited/debited
- Provides no signal in the data that a correction was applied, making it harder to diagnose related issues later
- Sets a precedent for masking data quality issues at the presentation layer rather than correcting them at source

---

## Decision

**Option 1: Issue remedial transactions on server boot / deploy.**

A new `ROUNDING_CORRECTION` transaction type is appended to any waste balance whose `amount` or `availableAmount` contains floating-point drift beyond two decimal places. The migration runs automatically on startup when the feature flag `FEATURE_FLAG_WASTE_BALANCE_ROUNDING_CORRECTION` is set to `true`, and is a no-op on any balance that is already correct.

The two-decimal-place invariant guaranteed by the data layer makes detection trivial and reliable: `roundTo2dp(value) !== value` is sufficient to identify any affected balance without replaying the full transaction history. The correction amounts for `amount` and `availableAmount` are computed and applied independently, which correctly handles cases where PRN ring-fence operations have caused the two fields to accumulate different rounding errors.

This approach was chosen over the alternatives because it is the only option that is automated, auditable, idempotent, and safe to run in a production environment without manual operator intervention. It follows established codebase conventions and requires no permanent changes to the application's read/write paths.

## Consequences

- A `ROUNDING_CORRECTION` transaction type is added to the waste balance domain model. Consumers of the transaction log must be aware that this type exists and does not represent a real-world tonnage movement
- The feature flag `FEATURE_FLAG_WASTE_BALANCE_ROUNDING_CORRECTION` must be enabled for the corrective deploy, verified via dry-run first, and then disabled in a subsequent release once the migration is confirmed complete across all environments
- `runWasteBalanceRoundingCorrection` runs inside a distributed lock (`waste-balance-rounding-correction`) so multiple instances starting simultaneously will not double-apply corrections
- Any balance document that was already correctly stored (i.e. stored at exactly two decimal places) is untouched; the migration is safe to enable even if some balances were never affected