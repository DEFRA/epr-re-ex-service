# 42. Registration and accreditation validity dates and status-management rules

Date: 2026-07-08

## Status

Proposed

## Context

This ADR answers the question: **how should registration and accreditation status transitions be
handled?** The decision is to manage them through **explicit, purpose-built transition actions in
the admin UI**, each backed by a dedicated endpoint that enforces the transition tables and date
rules recorded here — replacing free-form status edits through the admin JSON editor. The rest of
this document is the background that grounds that decision: what the validity dates mean, how each
transition drives and consumes them, and what the production data and code showed when the rules
were derived.

As that background, this ADR is a single record of two closely-related things:

1. **What the validity dates (`validFrom` / `validTo`) mean and what they are set to** — the
   business/statutory rules for the dates on every registration and accreditation sub-document.
2. **How registration/accreditation status is managed, and how status transitions drive and
   consume those dates** in the current system.

It combines the outputs of the **PAE-1716** (validity dates) and **PAE-1718** (assessment of
existing statuses/dates and migration approach) spikes into one document, and **supersedes the
separate validity-dates ADR** — the two were companion records and are clearer merged, because the
date rules and the status rules only make sense together. It is the prerequisite for migrating
status onto the event-sourced waste-balance ledger
([ADR 36](0036-event-sourced-waste-balance-stream.md),
[ADR 37](0037-committed-row-states-with-summary-log-membership.md)), where a status change becomes
an influencing event on the waste balance.

> **Update (2026-08-04).** Since this record was first drafted, the target rules below have been
> **implemented** under epic PAE-1598: dedicated status-transition endpoints now enforce the
> transition tables (see [Implemented status transitions](#implemented-status-transitions-epic-pae-1598)),
> the [BUG-1](#known-defect-resolved) waste-balance gate fix has shipped
> ([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730), done), and the data cleanup has been
> applied ([PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731), done). The as-was analysis is
> retained as the evidence trail for the migration; where behaviour has since changed, the change is
> noted inline.

### Why the dates exist

Each registration and accreditation covers a **bounded annual period** (BR-E1, BR-E2).
`validFrom`..`validTo` answers "was the operator entitled to do X on date D?" and gates the
**waste balance** (loads only count within the window), **PRN/PERN issuance**, **reporting cadence**
(registered = quarterly, accredited = monthly), and the **public register**.

### Evidence base

The rules below were checked against (a) the production admin data for **all 461 organisations** —
status histories and `validFrom`/`validTo` for every registration and accreditation, extracted
PII-free — and (b) the backend code that consumes status and dates
(`src/common/helpers/dates/accreditation.js`, `src/domain/organisations/registration-utils.js`,
`src/domain/organisations/status.js`, `src/repositories/organisations/schema/`).

Only five status values occurred in production at the time of the extract: `created`, `approved`,
`active` (organisation level only), `suspended`, `cancelled`. **No `rejected` status was present on
any record.** (`rejected` has since become reachable through the implemented reject transitions —
see Rule 6.)

## Decision

We decide:

1. **Registration and accreditation status is managed through explicit per-transition actions in
   the admin UI, backed by dedicated status-transition endpoints** — one endpoint arm per
   supported transition, each enforcing the transition tables and carrying exactly the
   parameters that transition needs (see
   [Implemented status transitions](#implemented-status-transitions-epic-pae-1598)). Editing status
   through the admin JSON editor is blocked
   ([PAE-1645](https://eaflood.atlassian.net/browse/PAE-1645)). Accreditation cancellation is
   suspended-first for user-driven changes, the registration-cancellation cascade being the sole
   system-driven exception.
2. **Adopt the validity-date rules (Rules 1–4 and 6 below) as the go-forward baseline.**
   `validFrom`..`validTo` is the entitlement window (`validFrom` = date of determination, `validTo`
   = 31 December of the scheme year); only `created → approved` (set) and `approved → created`
   (clear) touch the regulator-issued number and the validity dates; suspension and cancellation
   never move them.
3. **Change Rule 5: suspension and cancellation stop counting loads, by date.** The waste-balance
   gate excludes a load whose effective status at its date is `suspended` or `cancelled` (keeping
   `validFrom` as the start), and PRN actions are gated on the current accreditation status — a
   **suspended** accreditation may **create but not issue** a PRN, a **cancelled** one may do
   **neither** ([BUG-1](#known-defect-resolved)).
4. **Defer the genuinely policy-dependent items** to named owners rather than deciding them here
   (see [Target rules (going forward)](#target-rules-going-forward)).

Decisions 1 and 3 have since been implemented under epic PAE-1598
([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730) et al. — see the update note above). The
rules below first record the behaviour as it existed at the time of the assessment.

### Rule 1 — `created → approved` sets the regulator-issued number and **both** validity dates

A registration or accreditation is **created first** (`created` status, with **no** number or
validity dates — production confirms created-only records carry null `validFrom`/`validTo`) and
**approved later** by the regulator. When it transitions from `created` to `approved`, three fields
are set together:

- **`registrationNumber` / `accreditationNumber`** — the regulator-issued identifier for the grant.
  It **originates from the regulator** (it is not generated by the service) and must be **supplied by
  the caller on approval**. The schema **requires** it — non-null — whenever status is `approved` or
  `suspended` (`registrationNumber` / `accreditationNumber` `.when('status',
  requiredWhenApprovedOrSuspended)` in `schema/registration.js` / `schema/accreditation.js`), and
  allows it to be null in any other status.
- **`validFrom`** is set to the **date of determination**, which may be **before, after, or equal
  to** the day the approval was actually recorded. It is an independently-set business date, not a
  copy of the transition timestamp (see Rule 3). Its statutory basis:
  - **Accreditation** has a statutory start date: the regulations stipulate the date of
    determination as the start.
  - **Registration** has no statutory "start date" concept — a registration is granted and then
    runs annually. DEFRA policy takes the **date of determination of the registration application**
    as the de facto start date, and treats all pEPR requirements relating to registration as
    applying from that date forward (never retrospectively to before registration). No data is
    expected for any period before `validFrom`.
- **`validTo`** is set to **31 December of the scheme year** in which the record was determined. The
  scheme year is the calendar year: the annual RE/EX return is due _"by 28 February following the
  accreditation year"_ and PRNs must be accepted _"by 31 January of the following year"_ — both
  anchor the year end at 31 December.

`validFrom` is therefore the exact determination date, not the first of the month.

_As implemented_ ([REG1 / PAE-1599](https://eaflood.atlassian.net/browse/PAE-1599),
[ACC1 / PAE-1617](https://eaflood.atlassian.net/browse/PAE-1617)): the grant endpoint takes the
determination date as `appliesFrom` and the regulator-issued number, sets `validFrom = appliesFrom`
and the number, and **does not touch `validTo`** — `validTo` is owned by the application data
already on the record. The schema still requires both dates (and the number) whenever the status is
`approved` or `suspended`, so a grant on a record lacking `validTo` is rejected (422), as is an
inverted window (`appliesFrom` after `validTo`) or a number already in use by any other record of
the same kind in any organisation.

### Rule 2 — `approved → created` clears the number and **both** validity dates

When a registration or accreditation is sent **back to `created`** (an un-approve / re-edit), the
regulator-issued `registrationNumber` / `accreditationNumber` **and** `validFrom` **and** `validTo`
are **reset to null**. A record in `created` is not yet granted, so it carries neither a number nor a
validity window.

Rules 1 and 2 are a matched pair: **the only transitions that touch the number and the validity dates
are `created → approved` (set all three) and `approved → created` (clear all three).** Suspension and
cancellation never move them (Rules 4 and 5). This single principle reconciles the two
apparently-conflicting intuitions about re-approval — see Rule 2a.

_Observed exceptions (see [Data findings](#data-findings)): the clearing in this rule was **not
applied consistently** — three then-`created` entities still held non-null validity dates, since
corrected by the [PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731) data cleanup. The schema
permits (but does not force) null for the number in `created` too, so the number was likely subject
to the same leak; this could not be confirmed from the PII-free extract, in which the number is
redacted._

_As implemented:_ the revert transitions themselves (`approved → created`,
[REG4 / PAE-1611](https://eaflood.atlassian.net/browse/PAE-1611) and
[ACC4 / PAE-1620](https://eaflood.atlassian.net/browse/PAE-1620)) remain **outstanding** — the
domain transition table allows them, but no endpoint arm exposes them yet, so the clearing mechanic
in this rule is the agreed target rather than shipped behaviour.

### Rule 2a — a repeated `created → approved` re-sets the dates from the **latest** approval

Because each `approved → created` clears the dates (Rule 2), a subsequent `created → approved` sets
them **afresh** (Rule 1). In a `created → approved → created → approved` sequence it is therefore
the **second (latest) `created → approved`** whose determination date becomes `validFrom` — the
validity window always reflects the **most recent** approval, never a superseded earlier one.

This is distinct from re-activation **after a suspension** (`approved → suspended → approved`):
suspension does **not** clear the dates (Rule 2's principle), so re-activation preserves the
**original** `validFrom`. The rule of thumb: the dates follow the last `created → approved`, and a
suspension→re-approval is _not_ a `created → approved`. (This corrects the earlier blanket
statement that "re-approvals never change `validFrom`", which holds only for the suspension path.)

### Rule 3 — the `approved` transition timestamp is a record only

The `updatedAt` of an `approved` entry in `statusHistory` records **when the approval was
performed** and is used for nothing else. It is **not** the effective start of validity and is
**not** read by any date-filtering or waste-balance logic — `validFrom` (Rule 1) is the effective
date. A consequence is that the determination date must be **captured and persisted** at approval
time; it cannot be reconstructed from status history alone.

### Rule 4 — suspension uses the transition timestamp as the effective suspension date

When an accreditation is `suspended`, the `updatedAt` of the `suspended` `statusHistory` entry
**is** used as the effective date of suspension. The waste-balance / accreditation-period gate
(`isAccreditedAtDates` → `isSuspendedAtDate`, since generalised to `isSuspendedOrCancelledAtDate`,
in `src/common/helpers/dates/accreditation.js`) excludes any load whose date falls on or after the
suspension timestamp, in addition to requiring the load date to be within `validFrom`..`validTo`.
At the time of the assessment suspension was the one status whose transition timestamp carried date
semantics — cancellation now shares this mechanic ([BUG-1](#known-defect-resolved) fix) — and the
validity **window itself is unchanged**, so a lifted suspension reactivates with the original
`validFrom`.

"Was the operator live on day D?" is answered by combining the validity window (inside
`validFrom`..`validTo`?) with status history (suspended on D?) — the window alone is not enough.

### Rule 5 — cancellation did **not** derive an effective date; it was a coarse status gate (since fixed)

_This rule records the assessed behaviour that constituted [BUG-1](#known-defect-resolved); the
dated exclusion has since shipped ([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730))._

Contrary to a natural expectation that cancellation would mirror suspension, the `updatedAt` of a
`cancelled` entry was **not** used as an effective "date of cancellation" anywhere in the
date-filtering or waste-balance path, and there is **no `cancelledAt` field**. Cancellation was
handled by **status-set membership**, all-or-nothing rather than by date. (Post-fix, the
`cancelled` entry's `updatedAt` **is** the effective cancellation date in the waste-balance gate —
the status-set treatment below still governs the reporting/export paths.)

**Where `cancelled` is checked.** For registrations/accreditations the _only_ place that acts on a
`cancelled` status is `src/domain/organisations/registration-utils.js`, via two sets (all other
references are the enum definition, JSDoc types, the transition validator, or the unrelated PRN
domain):

- `REPORTABLE_STATUSES = {approved, suspended, cancelled}` — `cancelled` **is** a member. Consumed
  by `getReportableRegistrations`, so a cancelled registration/accreditation **still appears on the
  public register / reporting output**. Cancellation does not block this. (Delivered under
  [PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705): `suspended` has left this set —
  registrations cannot be suspended — so it is now `{approved, cancelled}`; the `cancelled`
  membership decided here is unchanged. Removing cancelled registrations from monthly reports is a
  separate open question, [PAE-1784](https://eaflood.atlassian.net/browse/PAE-1784).)
- `ACTIVE_ACCREDITATION_STATUSES = {approved, suspended}` — `cancelled` is **excluded**. Consumed by
  `resolveAccreditation` (→ returns `null`), `resolveAccreditationNumber` (→ returns `''`), and
  `isRegistrationAccredited` (→ returns `false`). So on the reporting/export resolution path a
  cancelled accreditation is treated as **not live**: no accreditation number, and the registration
  falls back to **registered-only**.

**What it blocked — and did not.** Because `resolveAccreditation` returns `null` for a cancelled
accreditation, and `isAccreditedAtDates(dates, null)` returns `true` (no gating), cancellation on
the export path meant "registered-only" (cannot issue PRNs), **not** a date-based exclusion of the
loads. Critically, the primary waste-balance **ingestion** path (`sync-from-summary-log.js` →
`findAccreditationById`) fetches the accreditation **by id regardless of status**, so it **never
consulted `cancelled` at all** — inclusion there was bounded only by `validFrom`/`validTo` and the
suspension check. Cancellation was therefore invisible to ingestion. (Post-fix, the same fetch feeds
`isSuspendedOrCancelledAtDate`, so ingestion now honours the cancellation date.)

(At the time of the assessment the only permitted transition into `cancelled` was
`suspended → cancelled`, so a cancelled record always had a prior suspension date. That has since
changed for **registrations**, which cancel **directly from `approved`** — they have no suspended
state ([PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705),
[REG8 / PAE-1615](https://eaflood.atlassian.net/browse/PAE-1615)) — and for a **cascade-cancelled
accreditation**, force-cancelled from `approved` or `suspended` when its registration is cancelled.
User-driven accreditation cancellation remains suspended-first — see
[Implemented status transitions](#implemented-status-transitions-epic-pae-1598).)

**Worked example — the asymmetry made concrete.** Accreditation valid `1 Jan → 31 Dec`,
**suspended 1 Jun**, **cancelled 1 Aug**. `isSuspendedAtDate` (as the gate then was) found the most
recent status at or before a load's date and asked only "is it `suspended`?":

| Load date | Most recent status at/before | Counted (ingestion date filter, as assessed)? |
| --------- | ---------------------------- | --------------------------------------------- |
| 1 May     | approved                     | ✅ included                                    |
| 1 Jul     | suspended                    | ❌ excluded (dated cut works)                  |
| 1 Sep     | **cancelled**                | ⚠️ **included** — `cancelled` ≠ `suspended`, still within `validTo` |

A load dated _after_ cancellation was **re-included** by the date filter, because `cancelled` is not
`suspended`; only the separate whole-record status gate on the export path removed the cancelled
accreditation. Suspension was applied **from a point in time**; cancellation was a **whole-record
current-status switch** that the ingestion date filter ignored.

> **⚠️ Confirmed defect (not merely an asymmetry) — RESOLVED, see [BUG-1](#known-defect-resolved).**
> As assessed, this behaviour was a live correctness bug, verified end-to-end and covered by **no
> test**: cancelling an accreditation did **not** shorten `validTo`, the ingestion path
> (`sync-from-summary-log.js`) fetched the accreditation **by id regardless of status**, and
> `isAccreditedAtDates` only excluded the literal `suspended` — so a load dated after cancellation
> but on/before `validTo` was **credited to the PRN-issuable balance**. Two production
> accreditations had an open post-cancellation window (suspended 2026-03-23, cancelled 2026-05-06,
> `validTo` 2026-12-31). The fix shipped under
> [PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730): the gate is now
> `isSuspendedOrCancelledAtDate`, so the 1 Sep load above is **excluded**.

### Rule 6 — `rejected` was not in use; it is now a live status

At the time of the extract no production record carried a `rejected` status. The reject transitions
have since been implemented for both kinds —
`created → rejected` ([REG2 / PAE-1609](https://eaflood.atlassian.net/browse/PAE-1609),
[ACC2 / PAE-1618](https://eaflood.atlassian.net/browse/PAE-1618)) with
`rejected → created` reopen-for-rework ([REG7 / PAE-1614](https://eaflood.atlassian.net/browse/PAE-1614),
[ACC7 / PAE-1623](https://eaflood.atlassian.net/browse/PAE-1623)) — so migration logic must treat
the live status vocabulary as `created`, `approved`, `active` (org only), `suspended`, `cancelled`,
**and `rejected`**. Rejection involves no number and no validity dates (the operator is simply not
granted), so it does not interact with the date rules above.

### Implemented status transitions (epic PAE-1598)

Status changes are performed through dedicated per-transition `status-history` POST endpoints
(admin-write scope), one discriminated payload arm per supported transition. The endpoint checks the
record really is in `fromStatus`, validates the transition against the domain table
(`src/domain/organisations/status.js`), audits the change, and appends the `statusHistory` entry.
Editing status through the admin JSON editor is blocked
([PAE-1645](https://eaflood.atlassian.net/browse/PAE-1645)), making the endpoints the only sanctioned
path.

**Registration** (no suspended state — [PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705)):

| Transition | Ticket | Notes |
| ---------- | ------ | ----- |
| `created → approved` | [REG1 / PAE-1599](https://eaflood.atlassian.net/browse/PAE-1599) | Grant — sets `registrationNumber` + `validFrom` (= `appliesFrom`); `validTo` untouched (Rule 1) |
| `created → rejected` | [REG2 / PAE-1609](https://eaflood.atlassian.net/browse/PAE-1609) | Refuse a non-compliant application |
| `rejected → created` | [REG7 / PAE-1614](https://eaflood.atlassian.net/browse/PAE-1614) | Reopen for rework |
| `approved → cancelled` | [REG8 / PAE-1615](https://eaflood.atlassian.net/browse/PAE-1615) | Direct cancel; **force-cancels** the linked live accreditation in the same replace |
| `cancelled → approved` | [REG9 / PAE-1616](https://eaflood.atlassian.net/browse/PAE-1616) | Reinstate after appeal, effective the day actioned; the cascade-cancelled accreditation is **not** auto-reinstated |
| `approved → created` | [REG4 / PAE-1611](https://eaflood.atlassian.net/browse/PAE-1611) | **Outstanding** — allowed by the domain table, no endpoint arm yet |

**Accreditation** (cancellation is suspended-first for user-driven changes; a direct
`approved → cancelled` arm was considered and **rejected** —
[ACC8 / PAE-1624](https://eaflood.atlassian.net/browse/PAE-1624), won't fix — the
registration-cancellation cascade being the sole, system-driven exception):

| Transition | Ticket | Notes |
| ---------- | ------ | ----- |
| `created → approved` | [ACC1 / PAE-1617](https://eaflood.atlassian.net/browse/PAE-1617) | Grant — sets `accreditationNumber` + `validFrom` (= `appliesFrom`); `validTo` untouched (Rule 1) |
| `created → rejected` | [ACC2 / PAE-1618](https://eaflood.atlassian.net/browse/PAE-1618) | Refuse; operator stays registered-only |
| `rejected → created` | [ACC7 / PAE-1623](https://eaflood.atlassian.net/browse/PAE-1623) | Reopen for rework |
| `approved → suspended` | [ACC3 / PAE-1619](https://eaflood.atlassian.net/browse/PAE-1619) | Dated effect from the transition timestamp (Rule 4) |
| `suspended → approved` | [ACC5 / PAE-1621](https://eaflood.atlassian.net/browse/PAE-1621) | Reinstate; original validity window preserved (Rule 2a) |
| `suspended → cancelled` | [ACC6 / PAE-1622](https://eaflood.atlassian.net/browse/PAE-1622) | The only user-driven path into `cancelled` |
| `cancelled → approved` | [ACC9 / PAE-1785](https://eaflood.atlassian.net/browse/PAE-1785) | Reinstate after successful appeal, effective the day actioned |
| `approved → created` | [ACC4 / PAE-1620](https://eaflood.atlassian.net/browse/PAE-1620) | **Outstanding** — allowed by the domain table, no endpoint arm yet |

Both accreditation to-`approved` arms (grant and reinstate) additionally require the **linked
registration to be `approved`** ([PAE-1800](https://eaflood.atlassian.net/browse/PAE-1800)) — without
this, a cancelled registration's cascade-cancelled accreditation could appear to be reinstated while
the repository cascade held it at `cancelled`.

### Worked example — accreditation approved 3 February 2026

An operator must already be registered to be accredited (SIP Part 1 is submitted at registration,
Part 2 at accreditation — BR-E2), so there are **two separate determination events** with their own
dates:

| Record            | `validFrom`                                                    | `validTo`    |
| ----------------- | -------------------------------------------------------------- | ------------ |
| **Registration**  | Date the registration was determined (on or before 3 Feb 2026) | `2026-12-31` |
| **Accreditation** | `2026-02-03` (date of determination)                           | `2026-12-31` |

If registration and accreditation are determined on the same day, both `validFrom` are `2026-02-03`.

Reporting cadence on a mid-period transition (e.g. quarterly for the part period up to the
accreditation start, then monthly thereafter) is **out of scope** here and will be recorded in a
separate reporting ADR.

## Data findings

From the all-461-organisation extract, the data at the time of the assessment was **largely
consistent** with the rules above, with a small number of anomalies. **The anomalies below have
since been corrected by the [PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731) data cleanup
(done)** — they are retained here as the evidence for Rule 2's leak and the cleanup's scope:

- **Validity not cleared on return to `created` (Rule 2 breach) — 3 entities.** Then `created`
  but still holding `validFrom`/`validTo`:
  `6948753f6876dbb8043e219a` REG `69526974be70ee498facc64a`;
  `68c9625b03f3b8ccb2b528a4` REG `68dbc6ddc9947d5a6fd51dd3`;
  `68c9625b03f3b8ccb2b528a4` ACC `68dbdc89a1b11ef518e79e65`.
  Because the waste-balance gate keys off `validFrom`/`validTo` (not status), these would still
  contribute loads despite not being approved.
- **Approved records with a prior-year validity window — 2 registrations.**
  `6944f1ede9c561e653c0ebc1` REG `6949440a9d4d5dd8b28a29f7` and
  `693812d0d29adae128a61f10` REG `6943dc4ee9c561e653c0ebbf` both have `validFrom = 2020-05-06`,
  `validTo = 2020-12-31` — a validity window six years before the current scheme year (almost
  certainly defaulted/erroneous test data). No loads would fall inside such a window.
- **Every currently-`approved` record has both dates set** — no approved record is missing
  `validFrom`/`validTo` (Rule 1 holds for live approvals).
- **`created`-only records carry null dates** — confirming creation does not pre-populate the
  validity window; the dates are set at approval (Rule 1), not at creation.
- **Interruptions are rare:** 1 accreditation currently `suspended`; 5 records currently `cancelled`
  (all via `created→approved→suspended→cancelled`); 1 accreditation re-approved after suspension
  (`…→suspended→approved`); a handful of re-edit loops (`…→approved→created→approved…`).

The full anomaly set is reproducible from the safe extract via the PAE-1718 analysis scripts.

## Known defect (resolved)

### BUG-1 ([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730), done) — post-cancellation loads were credited to the waste balance

As assessed, the waste-balance date gate treated a **cancelled** accreditation as still covering
dates up to `validTo`, so a load dated **after** the cancellation was wrongly counted toward the
PRN/PERN-issuable balance. Confirmed end-to-end and **untested** at the time:

- Cancelling does not shorten `validFrom`/`validTo` (the write path spreads the record verbatim and
  only appends a `statusHistory` entry; the validator permits but does not clear the dates for
  `cancelled`). Production confirmed all cancelled records kept `validTo = 2026-12-31`.
- Ingestion (`src/application/waste-records/sync-from-summary-log.js`, `findAccreditationById`)
  fetches the accreditation **by id regardless of status** and passes it to `isAccreditedAtDates`.
- `isAccreditedAtDates` → `isSuspendedAtDate` (`src/common/helpers/dates/accreditation.js`) excluded
  a date only when the effective status was the literal `'suspended'`. `cancelled` (and `created`)
  are not `'suspended'`, so the date passed and the row was `INCLUDED`.

The **same root cause** produced the Rule 2 leak: the three "returned to `created` but dates not
cleared" records also passed the gate, because `created` ≠ `suspended` (data since corrected —
[PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731)).

**The fix, as shipped** ([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730), with the
suspension-period behaviour also covered by
[PAE-1708](https://eaflood.atlassian.net/browse/PAE-1708)):

- `validFrom`..`validTo` remains the entitlement window; the gate excludes a load whose effective
  status at its date is `suspended` **or** `cancelled` — `isSuspendedAtDate` was generalised to
  **`isSuspendedOrCancelledAtDate`** (`src/common/helpers/dates/accreditation.js`), with regression
  tests. It was deliberately **not** switched to a positive "effective status is `approved`" test:
  `validFrom` (the determination date), not the `approved` transition timestamp, is the start of
  entitlement (Rule 3), so a positive gate would wrongly exclude determination-gap loads.
- **PRN actions are gated on the accreditation's current status**: creating a draft PRN on a
  `cancelled` accreditation is forbidden (403, `routes/post.js`), and issuing is blocked while
  `suspended` or `cancelled` (`assertAccreditationCanIssue`, hoisted ahead of the ledger debit in
  `update-status.js`) — a suspended or cancelled accreditation is never debited.

**The effective date already existed in the data.** Every `cancelled` `statusHistory` entry carries
an `updatedAt` (set at the transition), confirmed in production (e.g. cancelled `2026-05-06`). The
gate now reads it: `isSuspendedOrCancelledAtDate`'s most-recent-status-at-date lookup uses that
`updatedAt` as the cancellation cut-off, and the ledger migration can use it directly as the
cancellation event's `effectiveFrom` — no new field and no data loss.

One exposure from the original finding remains open by design: **cancelled/suspended operators are
not blocked from submitting summary logs** — the only submission gate is _organisation_-level status
== `ACTIVE`, and a registration/accreditation can be cancelled while its organisation stays
`ACTIVE`. Post-fix, such submissions are no longer **credited** (the gate excludes the loads), so
the exposure is reduced from a live balance error to accepting submissions that will not count.

## Target rules (going forward)

The sections above record behaviour **as assessed**. This is what the rules **should be** going
forward — split into what we affirm, what we change, and what we defer.

### Affirm (keep — these are correct; adopt as the target invariant)

- **Rule 1 / 2 / 2a** — `created → approved` sets the regulator-issued number, `validFrom`
  (determination date) and `validTo` (31 Dec); `approved → created` clears all three; a repeated
  approval re-sets them from the **latest** `created → approved`. The matched-pair mechanic is sound
  and is the intended target. (As implemented, the grant endpoint sets the number and `validFrom`
  and leaves `validTo` to the application data — Rule 1; the revert endpoints are still to be built
  — Rule 2.)
- **Rule 3** — the `approved` transition timestamp remains a record only; `validFrom` is the
  effective date, captured and persisted at approval.
- **Rule 4** — suspension remains a **dated** effect (excluded from the suspension date onward), with
  the window itself unchanged.
- **Rule 6** — the live status vocabulary is `created`, `approved`, `active` (org), `suspended`,
  `cancelled`, and — since the reject transitions shipped — `rejected` (Rule 6).

### Change (decided here — because Rule 5 was a confirmed defect; all but one delivered)

- **Rule 5 → suspension and cancellation stop counting loads, by date. ✅ Delivered
  ([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730),
  [PAE-1708](https://eaflood.atlassian.net/browse/PAE-1708)).** The waste-balance gate includes a
  load only when it is within `validFrom`..`validTo` **and** the effective status at the load's date
  is neither `suspended` nor `cancelled` (`isSuspendedAtDate` generalised to
  `isSuspendedOrCancelledAtDate`, with regression tests). `validFrom` (the determination date) stays
  the start of entitlement — a negative date-exclusion, not a positive `approved` test (Rule 3). The
  reverted-to-`created` leak was corrected by data cleanup
  ([PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731)), not by this gate.
- **PRN actions are gated on the accreditation's current status. ✅ Delivered
  ([PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730)).** A **suspended** accreditation may
  still **create (draft)** a PRN but may **not issue** one; a **cancelled** accreditation may do
  **neither**. Issuing is the terminal, balance-debiting action, so the issuable check is hoisted
  ahead of the ledger debit — a suspended or cancelled accreditation is never debited. Drafting a PRN
  is not balance-affecting, so it is allowed while suspended and blocked only once cancelled.

  | Accreditation status | Loads counted (within window) | Create (draft) PRN | Issue PRN |
  | -------------------- | ----------------------------- | ------------------ | --------- |
  | `approved`           | ✅                             | ✅                  | ✅         |
  | `suspended`          | ❌ from the suspension date     | ✅                  | ❌         |
  | `cancelled`          | ❌ from the cancellation date   | ❌                  | ❌         |

- **Registration cancellation applies the same dated exclusion at the registration level. ⏳
  Outstanding.** A cancelled registration should exclude registered-only waste records dated
  on/after the cancellation — the registration-level analogue of the accreditation gate. The
  ingestion path does not yet consult registration status; removing cancelled registrations from
  monthly reports is tracked as [PAE-1784](https://eaflood.atlassian.net/browse/PAE-1784).
  Registration _suspension_ is resolved: registrations cannot be suspended at all (below).
- **Data must match the rules. ✅ Delivered
  ([PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731)).** The three un-cleared `created`
  records and the two `2020-05-06` records were corrected so no `created` record holds dates and no
  approved record has a prior-year window.

### Defer (not decided here — needs a policy owner / separate ADR)

- **Registration `validTo` — roll-on vs hard annual expiry.** DEFRA policy describes registration as
  _"for a year and then **rolls on** unless cancelled or withdrawn"_, whereas accreditation is an
  unambiguous fixed annual grant. This leaves the registration `validTo` semantics unresolved:
  - _Option A — hard annual expiry:_ `validTo` = 31 Dec; the registration lapses at year end unless a
    renewal is determined (matches the accreditation model and the annual renewal fee, BR-E1).
  - _Option B — roll-on:_ `validTo` is open-ended / auto-extended and only set when the registration
    is actively cancelled or withdrawn (Reg 90), matching the "rolls on" wording.
  Treat registration `validTo` as 31 December of the determination year (Option A) until a policy
  owner confirms, but do not build hard-lapse enforcement that would be wrong under Option B. Interacts
  with [ADR 34](0034-multi-year-accreditation-model.md) and
  [ADR 30](0030-registered-only-edge-cases.md).
- **Cancellation effective date.** The statutory/effective date of cancellation is an acknowledged
  gap in the business rules (Confluence: _"the … effective date still need[s] confirmation"_). This is
  a policy question only, not a data one: the `cancelled` transition's `updatedAt` is present on every
  record and is a sensible default effective date (used by the BUG-1 gate and available to the
  migration as `effectiveFrom`). Policy needs only to confirm whether a _different_ effective date
  (e.g. a backdated one) is ever required; if so, that refines the value used, not the mechanism.
- **Whether cancellation is modelled as a discrete dated event in the ledger** (vs. derived from
  status-at-date) — a migration-design decision for the event-sourced-ledger ADR.
- **Registration suspension date semantics** — RESOLVED by
  [PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705) (2026-07-27): registrations **cannot be
  suspended** — suspension is an accreditation-only concept, applied directly to the accreditation.
  The registration lifecycle is `created → approved → cancelled` (with `cancelled → approved`
  reinstatement), so no registration dated-suspension gate is needed. Cancelling a registration
  **force-cancels** its linked accreditation from `approved` _or_ `suspended` — a system-driven
  exception to the accreditation's suspended-first cancellation rule; user-driven
  `approved → cancelled` remains forbidden. See
  [ADR 30](0030-registered-only-edge-cases.md) for the cascade detail.

## Consequences

- The migration to the event-sourced ledger can model **every status change as a dated event** by
  backfilling each event's `effectiveFrom` from the corresponding `statusHistory.updatedAt` — those
  timestamps already exist on all records (including `cancelled`). Suspension and cancellation are
  now both dated this way in the live gate (BUG-1 fix), so the backfill is a data-complete,
  no-new-field change rather than a behavioural guess.
- The determination date must be captured and persisted at approval time; consumers must always
  evaluate the validity window **together with** status history — the window alone does not tell you
  whether the operator was suspended on a given day.
- `validFrom` being the source of the PRN accreditation year means an off-by-one determination date
  (e.g. 1 January vs 31 December) changes the year a PRN is attributed to. Determination dates must be
  recorded accurately.
- Because the waste-balance gate reads `validFrom`/`validTo` and status-at-date — but **not**
  `created`-vs-`approved` status — a record whose dates were not cleared on return to `created` (Rule
  2 breach) would leak into the balance. The known instances were corrected by the
  [PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731) cleanup; the revert transitions
  (REG4/ACC4), when built, must clear the dates so the leak cannot recur.
- Cancellation is now truncated **by date** on the ingestion path as well as excluded on the
  CSV-export path (the [BUG-1](#known-defect-resolved) fix), and the ledger design should carry the
  same explicit cancellation cut-off (`statusHistory.updatedAt` → `effectiveFrom`).

## Follow-ups

Delivered (epic PAE-1598, done):

- **[PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730)** — [BUG-1](#known-defect-resolved):
  post-cancellation waste-balance leak fixed (`isSuspendedOrCancelledAtDate`); PRN issuance blocked
  while suspended or cancelled and PRN creation blocked while cancelled; regression tests added.
- **[PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731)** — data cleanup for the three
  un-cleared `created` records and the two `2020-05-06` records.
- **[PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705)** — registration suspension removed;
  cancelling a registration force-cancels its linked accreditation.
- The status-transition endpoints — see
  [Implemented status transitions](#implemented-status-transitions-epic-pae-1598).

Still open (epic PAE-1598):

- **[REG4 / PAE-1611](https://eaflood.atlassian.net/browse/PAE-1611)** and
  **[ACC4 / PAE-1620](https://eaflood.atlassian.net/browse/PAE-1620)** — the `approved → created`
  revert endpoints, which must clear the number and both validity dates (Rule 2).
- **[PAE-1784](https://eaflood.atlassian.net/browse/PAE-1784)** — remove cancelled registrations
  from monthly reports (the registration-level dated exclusion under
  [Target rules → Change](#change-decided-here--because-rule-5-was-a-confirmed-defect-all-but-one-delivered)).
- **[PAE-1703](https://eaflood.atlassian.net/browse/PAE-1703)** — split reporting requirements based
  on the status dates.

Open decisions are listed under [Target rules → Defer](#target-rules-going-forward) (registration
`validTo` semantics, cancellation effective date, ledger event modelling; registration suspension is
resolved — removed by [PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705)).

## References

### Confluence (MWR space, eaflood.atlassian.net)

- **Reporting: mid-year registration / accreditation and suspensions** — page 6475481144. DEFRA
  policy that accreditation's start is the statutory _date of determination_ and registration's start
  is the _date of determination of the application_; the waste-balance-within-valid-dates rule; the
  public-register display of suspended/cancelled.
- **pEPR Packaging — Statutory Requirements and Business Rules** — page 6521095536. BR-E1 (annual
  RE/EX registration), BR-E2 (only accredited operators may issue PRNs/PERNs; annual renewal; SIP
  Part 1/Part 2 sequencing), BR-E5 (registered = quarterly, accredited = monthly + annual return by
  28 Feb), BR-REG2 (public register). Notes cancellation's _"effective date still need[s]
  confirmation"_.
- **Data structure view – RREPW** — page 6546358726. Public-register column mapping: Active date →
  `accreditations.validFrom`; Accreditation status → `accreditations.status`.

### Regulations

- **SI 2024/1332** — Producer Responsibility Obligations (Packaging and Packaging Waste) Regulations
  2024, as amended by SI 2025/1369. Part 6 (Regs 84–100) — RE/EX registration and accreditation; Reg
  90 — cancellation of RE/EX registration; Reg 91 — reporting duties of _registered_ operators (basis
  for no pre-registration reporting obligation); Reg 129 — public register.

### Related ADRs

- [ADR 25 — Public Register of Registrations/Accreditations](0025-public-register-generation.md)
- [ADR 28 — Reporting API and Due Rules](0028-reporting-api-and-due-rules.md)
- [ADR 30 — Registered-only operator edge cases](0030-registered-only-edge-cases.md)
- [ADR 34 — Multi-year accreditation model](0034-multi-year-accreditation-model.md)
- [ADR 36 — Event-sourced waste-balance stream](0036-event-sourced-waste-balance-stream.md)
- [ADR 37 — Committed row states with summary-log membership](0037-committed-row-states-with-summary-log-membership.md)

### Code (behaviour verified against `epr-backend`)

- `src/common/helpers/dates/accreditation.js` — `isAccreditedAtDates`,
  `isSuspendedOrCancelledAtDate` (formerly `isSuspendedAtDate`),
  `isWithinAccreditationDateRange` (the waste-balance date gate; suspension- and
  cancellation-from-timestamp).
- `src/domain/organisations/registration-utils.js` — `REPORTABLE_STATUSES`,
  `resolveAccreditation`, `activeAccreditationValidFrom` (cancellation status gating; monthly
  obligations bounded by the accreditation `validFrom`,
  [PAE-1737](https://eaflood.atlassian.net/browse/PAE-1737)).
- `src/domain/organisations/status.js` — the registration and accreditation transition tables.
- `src/routes/v1/organisations/registration-status-history.js`,
  `src/routes/v1/organisations/accreditation-status-history.js` (+ `.schema.js`) — the
  per-transition endpoints, grant parameters, and the PAE-1800 approved-registration guard.
- `src/repositories/organisations/schema/status-transition.js` —
  `applyRegistrationStatusToLinkedAccreditations` (the force-cancel cascade).
- `src/packaging-recycling-notes/domain/model.js` (`assertAccreditationCanIssue`),
  `src/packaging-recycling-notes/routes/post.js` — PRN create/issue status gating.
- `src/repositories/organisations/schema/accreditation.js`,
  `src/repositories/organisations/schema/registration.js` — `validFrom`/`validTo` are the only date
  fields; required when approved/suspended; no `cancelledAt`.
