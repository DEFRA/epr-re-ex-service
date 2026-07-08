# 42. Status-management rules for registrations and accreditations

Date: 2026-07-08

## Status

Proposed

## Context

This ADR records the **rules currently used to manage the status** of registration and
accreditation sub-documents, and how those status changes interact with the dates
(`validFrom` / `validTo`) that gate downstream business logic. It is the output of the
PAE-1718 spike, whose purpose was to establish _how approval of reg/acc has been carried
out so far, what state the production data is in, and whether it is consistent_ — the
prerequisite for migrating status onto the event-sourced waste-balance ledger
([ADR 36](0036-event-sourced-waste-balance-stream.md),
[ADR 37](0037-committed-row-states-with-summary-log-membership.md)), where a status change
becomes an influencing event on the waste balance.

The **decision** captured here is deliberately descriptive: to _document the status rules
as they are implemented and exercised today_, so the migration has an agreed, code-verified
baseline rather than an assumed one. Where the observed rules are inconsistent or surprising,
that is called out as a migration input rather than silently normalised.

The companion ADR **_Registration and accreditation validity dates (`validFrom`/`validTo`)_**
(PAE-1716, in review) covers _what the dates mean and what they should be set to_. This ADR
covers _how status transitions drive and consume those dates in the current system_. The two
should be read together.

### Evidence base

The rules below were checked against (a) the production admin data for **all 461
organisations** — status histories and `validFrom`/`validTo` for every registration and
accreditation, extracted PII-free — and (b) the backend code that consumes status and dates
(`src/common/helpers/dates/accreditation.js`,
`src/domain/organisations/registration-utils.js`, `src/domain/organisations/status.js`,
`src/repositories/organisations/schema/`).

Only five status values occur in production: `created`, `approved`, `active` (organisation
level only), `suspended`, `cancelled`. **No `rejected` status is present on any record.**

## Decision

### Rule 1 — `created → approved` sets **both** `validFrom` and `validTo`

When a registration or accreditation transitions from `created` to `approved`, **both** validity
dates are set together:

- **`validFrom`** is set to the **date of determination**, which may be **before, after, or equal
  to** the day the approval was actually recorded. It is an independently-set business date, not
  a copy of the transition timestamp.
- **`validTo`** is set to the **end of the scheme year (31 December)**.

(What those dates _should_ be is governed by the validity-dates ADR, PAE-1716.)

### Rule 2 — `approved → created` clears **both** validity dates

When a registration or accreditation is sent **back to `created`** (an un-approve / re-edit),
`validFrom` **and** `validTo` are **reset to null**. A record in `created` is not yet valid and
therefore carries no validity window.

Rules 1 and 2 are a matched pair: the only transitions that touch the validity dates are
`created → approved` (set both) and `approved → created` (clear both). Suspension and
cancellation never move them (Rules 4 and 5).

_Observed exceptions (see [Data findings](#data-findings)): the clearing in this rule is **not
applied consistently** — three currently-`created` entities still hold non-null validity dates._

### Rule 2a — a repeated `created → approved` re-sets the dates from the **latest** approval

Because each `approved → created` clears the dates (Rule 2), a subsequent `created → approved`
sets them **afresh** (Rule 1). In a `created → approved → created → approved` sequence it is
therefore the **second (latest) `created → approved`** whose determination date becomes
`validFrom` — the validity window always reflects the **most recent** approval, never a
superseded earlier one.

This is distinct from re-activation **after a suspension** (`approved → suspended → approved`):
suspension does not clear the dates, so re-activation preserves the **original** `validFrom`
(see Rule 4 and the validity-dates ADR, PAE-1716). The rule of thumb: the dates follow the last
`created → approved`, and a suspension→re-approval is _not_ a `created → approved`.

### Rule 3 — the `approved` transition timestamp is a record only

The `updatedAt` of an `approved` entry in `statusHistory` records **when the approval was
performed** and is used for nothing else. It is **not** the effective start of validity and is
**not** read by any date-filtering or waste-balance logic — `validFrom` (Rule 1) is the
effective date.

### Rule 4 — suspension uses the transition timestamp as the effective suspension date

When an accreditation is `suspended`, the `updatedAt` of the `suspended` `statusHistory` entry
**is** used as the effective date of suspension. The waste-balance / accreditation-period gate
(`isAccreditedAtDates` → `isSuspendedAtDate` in
`src/common/helpers/dates/accreditation.js`) excludes any load whose date falls on or after the
suspension timestamp, in addition to requiring the load date to be within `validFrom`..`validTo`.
Suspension is therefore the one status whose transition timestamp carries date semantics.

### Rule 5 — cancellation does **not** derive an effective date; it is a coarse status gate

Contrary to a natural expectation that cancellation would mirror suspension, the `updatedAt` of
a `cancelled` entry is **not** used as an effective "date of cancellation" anywhere in the
date-filtering or waste-balance path, and there is **no `cancelledAt` field**. Cancellation is
handled by **status-set membership**, all-or-nothing rather than by date.

**Where `cancelled` is checked.** For registrations/accreditations the _only_ place that acts on
a `cancelled` status is `src/domain/organisations/registration-utils.js`, via two sets (all other
references are the enum definition, JSDoc types, the transition validator, or the unrelated PRN
domain):

- `REPORTABLE_STATUSES = {approved, suspended, cancelled}` — `cancelled` **is** a member. Consumed
  by `getReportableRegistrations`, so a cancelled registration/accreditation **still appears on
  the public register / reporting output**. Cancellation does not block this.
- `ACTIVE_ACCREDITATION_STATUSES = {approved, suspended}` — `cancelled` is **excluded**. Consumed
  by `resolveAccreditation` (→ returns `null`), `resolveAccreditationNumber` (→ returns `''`), and
  `isRegistrationAccredited` (→ returns `false`). So on the reporting/export resolution path a
  cancelled accreditation is treated as **not live**: no accreditation number, and the registration
  falls back to **registered-only**.

**What it blocks — and does not.** Because `resolveAccreditation` returns `null` for a cancelled
accreditation, and `isAccreditedAtDates(dates, null)` returns `true` (no gating), cancellation on
the export path means "registered-only" (cannot issue PRNs), **not** a date-based exclusion of the
loads. Critically, the primary waste-balance **ingestion** path
(`sync-from-summary-log.js` → `findAccreditationById`) fetches the accreditation **by id
regardless of status**, so it **never consults `cancelled` at all** — inclusion there is bounded
only by `validFrom`/`validTo` and the suspension check. Cancellation is therefore invisible to
ingestion.

(The only permitted transition into `cancelled` is `suspended → cancelled`, per
`src/domain/organisations/status.js`, so a cancelled record always has a prior suspension date.)

**Worked example — the asymmetry made concrete.** Accreditation valid `1 Jan → 31 Dec`,
**suspended 1 Jun**, **cancelled 1 Aug**. `isSuspendedAtDate` finds the most recent status at or
before a load's date and asks only "is it `suspended`?":

| Load date | Most recent status at/before | Counted (ingestion date filter)? |
| --------- | ---------------------------- | -------------------------------- |
| 1 May     | approved                     | ✅ included                       |
| 1 Jul     | suspended                    | ❌ excluded (dated cut works)     |
| 1 Sep     | **cancelled**                | ⚠️ **included** — `cancelled` ≠ `suspended`, still within `validTo` |

A load dated _after_ cancellation is **re-included** by the date filter, because `cancelled` is not
`suspended`; only the separate whole-record status gate on the export path removes the cancelled
accreditation. Suspension is applied **from a point in time**; cancellation is a **whole-record
current-status switch** that the ingestion date filter ignores — an asymmetry the ledger migration
must resolve.

### Rule 6 — `rejected` is not in use

No production record carries a `rejected` status. Any status-management or migration logic can
treat the live status vocabulary as `created`, `approved`, `active` (org only), `suspended`,
`cancelled`.

## Data findings

From the all-461-organisation extract, the current data is **largely consistent** with the
rules above, with a small number of anomalies that the migration must decide how to carry over:

- **Validity not cleared on return to `created` (Rule 2 breach) — 3 entities.** Currently
  `created` but still holding `validFrom`/`validTo`:
  `6948753f6876dbb8043e219a` REG `69526974be70ee498facc64a`;
  `68c9625b03f3b8ccb2b528a4` REG `68dbc6ddc9947d5a6fd51dd3`;
  `68c9625b03f3b8ccb2b528a4` ACC `68dbdc89a1b11ef518e79e65`.
  Because the waste-balance gate keys off `validFrom`/`validTo` (not status), these would still
  contribute loads despite not being approved.
- **Approved records with a prior-year validity window — 2 registrations.**
  `6944f1ede9c561e653c0ebc1` REG `6949440a9d4d5dd8b28a29f7` and
  `693812d0d29adae128a61f10` REG `6943dc4ee9c561e653c0ebbf` both have
  `validFrom = 2020-05-06`, `validTo = 2020-12-31` — a validity window six years before the
  current scheme year (almost certainly defaulted/erroneous test data). No loads would fall
  inside such a window.
- **Every currently-`approved` record has both dates set** — no approved record is missing
  `validFrom`/`validTo` (Rule 1 holds for live approvals).
- **Interruptions are rare:** 1 accreditation currently `suspended`; 5 records currently
  `cancelled` (all via `created→approved→suspended→cancelled`); 1 accreditation re-approved
  after suspension (`…→suspended→approved`); a handful of re-edit loops
  (`…→approved→created→approved…`).

The full anomaly set is reproducible from the safe extract via the PAE-1718 analysis scripts.

## Consequences

- The migration to the event-sourced ledger must model **suspension as a dated event** (from
  the `suspended` transition timestamp) but **cancellation and approval as state/record
  changes** whose transition timestamps carry no date semantics — matching current behaviour,
  or explicitly changing it as a conscious decision.
- Because the current waste-balance gate reads `validFrom`/`validTo` and suspension — but **not**
  `created`-vs-`approved` status — a record whose dates were not cleared on return to `created`
  (Rule 2 breach) leaks into the balance. The migration should either enforce Rule 2 as a
  data-cleanup step or make the ledger honour status directly.
- Cancellation's status-set treatment means a cancelled accreditation contributes **nothing**
  from the CSV-export path but is **not** truncated by date on the ingestion path; the ledger
  design should make the cancellation cut-off explicit if a point-in-time cancellation is
  intended.
- The two prior-year (`2020`) approved registrations and the three un-cleared `created` records
  should be triaged before migration so they do not carry incorrect windows into the ledger.

## Open questions / follow-ups

- **Should cancellation become a dated event** (like suspension) in the ledger, rather than a
  coarse status gate? This is a policy + design decision for the migration.
- **Should Rule 2 (clear dates on return to `created`) be enforced retrospectively** to fix the
  three inconsistent records, and guarded going forward?
- **Registration suspension:** the dated-suspension gate is implemented on the accreditation
  path; whether registration suspension needs equivalent date semantics is unresolved (only one
  registration is currently suspended/cancelled in the data).
- Triage owner needed for the `2020-05-06` validity records.

## References

### Related ADRs

- _Registration and accreditation validity dates (`validFrom`/`validTo`)_ — PAE-1716, in review
  (companion to this ADR; defines what the dates should be set to).
- [ADR 34 — Multi-year accreditation model](0034-multi-year-accreditation-model.md)
- [ADR 36 — Event-sourced waste-balance stream](0036-event-sourced-waste-balance-stream.md)
- [ADR 37 — Committed row states with summary-log membership](0037-committed-row-states-with-summary-log-membership.md)
- [ADR 30 — Registered-only operator edge cases](0030-registered-only-edge-cases.md)

### Code (behaviour verified against `epr-backend`)

- `src/common/helpers/dates/accreditation.js` — `isAccreditedAtDates`, `isSuspendedAtDate`,
  `isWithinAccreditationDateRange` (the waste-balance date gate; suspension-from-timestamp).
- `src/domain/organisations/registration-utils.js` — `REPORTABLE_STATUSES`,
  `ACTIVE_ACCREDITATION_STATUSES`, `resolveAccreditation` (cancellation status gating).
- `src/domain/organisations/status.js` — permitted status transitions
  (`suspended → cancelled`).
- `src/repositories/organisations/schema/accreditation.js`,
  `src/repositories/organisations/schema/registration.js` — `validFrom`/`validTo` are the only
  date fields; required when approved/suspended; no `cancelledAt`.
