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

Only five status values occur in production: `created`, `approved`, `active` (organisation level
only), `suspended`, `cancelled`. **No `rejected` status is present on any record.** (The intended
reject transitions introduce it — see Rule 6.)

## Decision

We decide:

1. **Registration and accreditation status is managed through explicit per-transition actions in
   the admin UI, backed by dedicated status-transition endpoints** — one endpoint arm per
   supported transition, each enforcing the transition tables and carrying exactly the
   parameters that transition needs (see
   [Intended status transitions](#intended-status-transitions-epic-pae-1598)). Editing status
   through the admin JSON editor is blocked
   ([PAE-1645](https://eaflood.atlassian.net/browse/PAE-1645)). Accreditation cancellation is
   suspended-first for user-driven changes, the registration-cancellation cascade being the sole
   system-driven exception.
2. **Adopt the validity-date rules (Rules 1–4 and 6 below) as the go-forward baseline.**
   `validFrom`..`validTo` is the entitlement window (`validFrom` = date of determination, `validTo`
   = 31 December of the scheme year); only `created → approved` touches the regulator-issued number
   and the validity dates; suspension and cancellation never move them.
3. **Suspension and cancellation stop counting loads, by date.** The waste-balance gate includes a
   load only when it is within `validFrom`..`validTo` **and** the effective status at the load's
   date is neither `suspended` nor `cancelled` — both take effect from their `statusHistory`
   `updatedAt`, and `validFrom` stays the start of entitlement. PRN actions are gated on the
   current accreditation status — a **suspended** accreditation may **create but not issue** a PRN,
   a **cancelled** one may do **neither** (Rules 4 and 5).
4. **Defer the genuinely policy-dependent items** to named owners rather than deciding them here
   (see [Target rules (going forward)](#target-rules-going-forward)).

The rules below first record the behaviour as it exists today.

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

_Intended grant mechanics_ ([REG1 / PAE-1599](https://eaflood.atlassian.net/browse/PAE-1599),
[ACC1 / PAE-1617](https://eaflood.atlassian.net/browse/PAE-1617)): the grant transition takes the
determination date as `appliesFrom` and the regulator-issued number, sets `validFrom = appliesFrom`
and the number, and **does not touch `validTo`** — `validTo` is owned by the application data
already on the record. The schema requires both dates (and the number) whenever the status is
`approved` or `suspended`, so a grant on a record lacking `validTo` is rejected, as is an inverted
window (`appliesFrom` after `validTo`) or a number already in use by any other record of the same
kind in any organisation.

### Rule 2 — the dates always reflect the **latest** approval

The validity window and number always reflect the **most recent** `created → approved` grant:
granting sets them afresh from that grant's determination date (Rule 1), never a superseded earlier
one. A record in `created` is not yet granted, so it must carry neither a number nor a validity
window. **`created → approved` is the only transition that touches the number and the validity
dates** — suspension and cancellation never move them (Rules 4 and 5).

_Observed exceptions (see [Data findings](#data-findings)): this invariant does not hold everywhere
in the current data — three currently-`created` entities hold non-null validity dates, to be
corrected by the [PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731) data cleanup. The schema
permits (but does not force) null for the number in `created` too, so the number is likely subject to
the same leak; this could not be confirmed from the PII-free extract, in which the number is redacted._

### Rule 3 — the `approved` transition timestamp is a record only

The `updatedAt` of an `approved` entry in `statusHistory` records **when the approval was
performed** and is used for nothing else. It is **not** the effective start of validity and is
**not** read by any date-filtering or waste-balance logic — `validFrom` (Rule 1) is the effective
date. A consequence is that the determination date must be **captured and persisted** at approval
time; it cannot be reconstructed from status history alone.

### Rule 4 — suspension uses the transition timestamp as the effective suspension date

When an accreditation is `suspended`, the `updatedAt` of the `suspended` `statusHistory` entry
**is** used as the effective date of suspension. The waste-balance / accreditation-period gate
(`isAccreditedAtDates` → `isSuspendedOrCancelledAtDate` in
`src/common/helpers/dates/accreditation.js`) excludes any load whose date falls on or after the
suspension timestamp, in addition to requiring the load date to be within `validFrom`..`validTo`.
The validity **window itself is unchanged**, so a lifted suspension reactivates with the original
`validFrom`.

"Was the operator live on day D?" is answered by combining the validity window (inside
`validFrom`..`validTo`?) with status history (suspended or cancelled on D?) — the window alone is
not enough.

### Rule 5 — cancellation works exactly like suspension: the transition timestamp is the effective cancellation date

Cancellation uses the same dated mechanic as suspension (Rule 4): the `updatedAt` of the
`cancelled` `statusHistory` entry **is** the effective date of cancellation. The waste-balance gate
(`isSuspendedOrCancelledAtDate`) excludes any load whose effective status at its date is
`suspended` **or** `cancelled` — a load dated before the cancellation still counts, a load dated on
or after it does not. There is no separate `cancelledAt` field and the validity dates are never
cleared or shortened by cancellation (Rule 2): the timestamp on the status-history entry carries
the date semantics.

Because cancellation is terminal rather than temporary, it additionally switches the record off on
the resolution paths, via two status sets in
`src/domain/organisations/registration-utils.js`:

- `REPORTABLE_STATUSES` — `cancelled` **is** a member, so a cancelled registration/accreditation
  **still appears on the public register / reporting output**. (Under
  [PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705) `suspended` leaves this set —
  registrations cannot be suspended — so it becomes `{approved, cancelled}`; the `cancelled`
  membership is unchanged. Removing cancelled registrations from monthly reports is a separate open
  question, [PAE-1784](https://eaflood.atlassian.net/browse/PAE-1784).)
- `ACTIVE_ACCREDITATION_STATUSES = {approved, suspended}` — `cancelled` is **excluded**. Consumed by
  `resolveAccreditation` (→ returns `null`), `resolveAccreditationNumber` (→ returns `''`), and
  `isRegistrationAccredited` (→ returns `false`). So on the reporting/export resolution path a
  cancelled accreditation is treated as **not live**: no accreditation number, and the registration
  falls back to **registered-only**.

(Today the only permitted transition into `cancelled` is `suspended → cancelled`, per
`src/domain/organisations/status.js`, so a cancelled record always has a prior suspension date. The
intended registration transitions change this: registrations cancel **directly from `approved`** —
they have no suspended state ([PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705),
[REG8 / PAE-1615](https://eaflood.atlassian.net/browse/PAE-1615)) — and cancelling a registration
**force-cancels** its linked live accreditation. User-driven accreditation cancellation remains
suspended-first — see
[Intended status transitions](#intended-status-transitions-epic-pae-1598).)

**Worked example.** Accreditation valid `1 Jan → 31 Dec`, **suspended 1 Jun**, **cancelled 1 Aug**.
The gate finds the most recent status at or before a load's date:

| Load date | Most recent status at/before | Counted? |
| --------- | ---------------------------- | -------- |
| 1 May     | approved                     | ✅ included |
| 1 Jul     | suspended                    | ❌ excluded from the suspension date |
| 1 Sep     | cancelled                    | ❌ excluded from the cancellation date |

### Rule 6 — `rejected` is not in use today; the intended transitions introduce it

No production record carries a `rejected` status, and no transition reaches it. The intended
transitions introduce rejection for both kinds —
`created → rejected` ([REG2 / PAE-1609](https://eaflood.atlassian.net/browse/PAE-1609),
[ACC2 / PAE-1618](https://eaflood.atlassian.net/browse/PAE-1618)) with
`rejected → created` reopen-for-rework ([REG7 / PAE-1614](https://eaflood.atlassian.net/browse/PAE-1614),
[ACC7 / PAE-1623](https://eaflood.atlassian.net/browse/PAE-1623)) — so status-management and
migration logic must treat the vocabulary as `created`, `approved`, `active` (org only),
`suspended`, `cancelled`, **and `rejected`**. Rejection involves no number and no validity dates
(the operator is simply not granted), so it does not interact with the date rules above.

### Intended status transitions (epic PAE-1598)

Status changes are to be performed through dedicated per-transition `status-history` POST endpoints
(admin-write scope), one discriminated payload arm per supported transition — surfaced in the admin
UI as one explicit action per transition. Each endpoint checks the record really is in `fromStatus`,
validates the transition against the domain table (`src/domain/organisations/status.js`), audits
the change, and appends the `statusHistory` entry. Editing status through the admin JSON editor is
blocked ([PAE-1645](https://eaflood.atlassian.net/browse/PAE-1645)), making these actions the only
sanctioned path.

**Registration** (no suspended state — [PAE-1705](https://eaflood.atlassian.net/browse/PAE-1705)):

| Transition | Ticket | Notes |
| ---------- | ------ | ----- |
| `created → approved` | [REG1 / PAE-1599](https://eaflood.atlassian.net/browse/PAE-1599) | Grant — sets `registrationNumber` + `validFrom` (= `appliesFrom`); `validTo` untouched (Rule 1) |
| `created → rejected` | [REG2 / PAE-1609](https://eaflood.atlassian.net/browse/PAE-1609) | Refuse a non-compliant application |
| `rejected → created` | [REG7 / PAE-1614](https://eaflood.atlassian.net/browse/PAE-1614) | Reopen for rework |
| `approved → cancelled` | [REG8 / PAE-1615](https://eaflood.atlassian.net/browse/PAE-1615) | Direct cancel; **force-cancels** the linked live accreditation in the same update |
| `cancelled → approved` | [REG9 / PAE-1616](https://eaflood.atlassian.net/browse/PAE-1616) | Reinstate after appeal, effective the day actioned; the cascade-cancelled accreditation is **not** auto-reinstated |

**Accreditation** (cancellation is suspended-first for user-driven changes; a direct
`approved → cancelled` action was considered and **rejected** —
[ACC8 / PAE-1624](https://eaflood.atlassian.net/browse/PAE-1624) — the registration-cancellation
cascade being the sole, system-driven exception):

| Transition | Ticket | Notes |
| ---------- | ------ | ----- |
| `created → approved` | [ACC1 / PAE-1617](https://eaflood.atlassian.net/browse/PAE-1617) | Grant — sets `accreditationNumber` + `validFrom` (= `appliesFrom`); `validTo` untouched (Rule 1) |
| `created → rejected` | [ACC2 / PAE-1618](https://eaflood.atlassian.net/browse/PAE-1618) | Refuse; operator stays registered-only |
| `rejected → created` | [ACC7 / PAE-1623](https://eaflood.atlassian.net/browse/PAE-1623) | Reopen for rework |
| `approved → suspended` | [ACC3 / PAE-1619](https://eaflood.atlassian.net/browse/PAE-1619) | Dated effect from the transition timestamp (Rule 4) |
| `suspended → approved` | [ACC5 / PAE-1621](https://eaflood.atlassian.net/browse/PAE-1621) | Reinstate; original validity window preserved (Rule 4) |
| `suspended → cancelled` | [ACC6 / PAE-1622](https://eaflood.atlassian.net/browse/PAE-1622) | The only user-driven path into `cancelled` |
| `cancelled → approved` | [ACC9 / PAE-1785](https://eaflood.atlassian.net/browse/PAE-1785) | Reinstate after successful appeal, effective the day actioned |

Both accreditation to-`approved` actions (grant and reinstate) additionally require the **linked
registration to be `approved`** ([PAE-1800](https://eaflood.atlassian.net/browse/PAE-1800)) — without
this, a cancelled registration's cascade-cancelled accreditation could appear to be reinstated while
the cascade holds it at `cancelled`.

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

From the all-461-organisation extract, the current data is **largely consistent** with the rules
above, with a small number of anomalies that the migration must decide how to carry over:

- **`created` records holding validity dates (Rule 2 breach) — 3 entities.** Currently `created`
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
  (`…→suspended→approved`); a handful of historical re-edit loops where a record returned to
  `created` and was re-approved.

The full anomaly set is reproducible from the safe extract via the PAE-1718 analysis scripts.

## Target rules (going forward)

The sections above record the business rules. This section splits what follows from them into what
we affirm, what we change, and what we defer.

### Affirm (keep — these are correct; adopt as the target invariant)

- **Rules 1 / 2** — `created → approved` sets the regulator-issued number, `validFrom`
  (determination date) and `validTo` (31 Dec); the window and number always reflect the **latest**
  grant, and a `created` record carries neither.
- **Rule 3** — the `approved` transition timestamp remains a record only; `validFrom` is the
  effective date, captured and persisted at approval.
- **Rules 4 / 5** — suspension and cancellation are **dated** effects from their `statusHistory`
  `updatedAt` (excluded from that date onward), with the window itself unchanged.
- **Rule 6** — the status vocabulary is `created`, `approved`, `active` (org), `suspended`,
  `cancelled`, plus `rejected` once the reject transitions are introduced.

### Change (intended changes to meet the rules)

- **PRN actions are gated on the accreditation's current status.** A **suspended** accreditation may
  still **create (draft)** a PRN but may **not issue** one; a **cancelled** accreditation may do
  **neither**. Issuing is the terminal, balance-debiting action, so the issuable check is hoisted
  ahead of the ledger debit — a suspended or cancelled accreditation is never debited. Drafting a PRN
  is not balance-affecting, so it is allowed while suspended and blocked only once cancelled.
  Implementation: [PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730).

  | Accreditation status | Loads counted (within window) | Create (draft) PRN | Issue PRN |
  | -------------------- | ----------------------------- | ------------------ | --------- |
  | `approved`           | ✅                             | ✅                  | ✅         |
  | `suspended`          | ❌ from the suspension date     | ✅                  | ❌         |
  | `cancelled`          | ❌ from the cancellation date   | ❌                  | ❌         |

- **Registration cancellation applies the same dated exclusion at the registration level.** A
  cancelled registration excludes registered-only waste records dated on/after the cancellation — the
  registration-level analogue of the accreditation gate
  ([PAE-1784](https://eaflood.atlassian.net/browse/PAE-1784) covers the monthly-report side).
  Registration _suspension_ is resolved: registrations cannot be suspended at all (below).
- **Data must match the rules.** The three un-cleared `created` records and the two `2020-05-06`
  records are corrected so no `created` record holds dates and no approved record has a prior-year
  window: [PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731).

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
  record and is the effective date used by the gate (Rule 5, available to the migration as
  `effectiveFrom`). Policy needs only to confirm whether a _different_ effective date
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
  both dated this way (Rules 4 and 5), so the backfill is a data-complete, no-new-field change
  rather than a behavioural guess.
- The determination date must be captured and persisted at approval time; consumers must always
  evaluate the validity window **together with** status history — the window alone does not tell you
  whether the operator was suspended on a given day.
- `validFrom` being the source of the PRN accreditation year means an off-by-one determination date
  (e.g. 1 January vs 31 December) changes the year a PRN is attributed to. Determination dates must be
  recorded accurately.
- Because the waste-balance gate reads `validFrom`/`validTo` and status-at-date — but **not**
  `created`-vs-`approved` status — a `created` record still holding dates (Rule 2 breach) leaks into
  the balance. The migration should either enforce Rule 2 as a data-cleanup step or make the ledger
  honour status directly.
- The two prior-year (`2020`) approved registrations and the three `created` records holding dates
  should be triaged/cleaned before migration
  ([PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731)).

## Follow-ups

Actionable tickets (all under epic PAE-1598):

- The per-transition endpoints and admin-UI actions — see
  [Intended status transitions](#intended-status-transitions-epic-pae-1598) for the ticket per
  transition, plus the [PAE-1800](https://eaflood.atlassian.net/browse/PAE-1800) guard and the
  JSON-editor block ([PAE-1645](https://eaflood.atlassian.net/browse/PAE-1645)).
- **[PAE-1730](https://eaflood.atlassian.net/browse/PAE-1730)** — the waste-balance gate excludes
  loads whose effective status at the load date is `suspended` or `cancelled` (keeping `validFrom`
  as the start); PRN issuance is blocked while suspended or cancelled and PRN creation while
  cancelled; regression tests for the suspension and cancellation cases.
- **[PAE-1731](https://eaflood.atlassian.net/browse/PAE-1731)** — data cleanup for the three
  un-cleared `created` records and the two `2020-05-06` records.
- **[PAE-1784](https://eaflood.atlassian.net/browse/PAE-1784)** — remove cancelled registrations
  from monthly reports (the registration-level dated exclusion).
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
  `isSuspendedOrCancelledAtDate`, `isWithinAccreditationDateRange` (the waste-balance date gate;
  suspension- and cancellation-from-timestamp).
- `src/domain/organisations/registration-utils.js` — `REPORTABLE_STATUSES`,
  `ACTIVE_ACCREDITATION_STATUSES`, `resolveAccreditation` (cancellation status gating).
- `src/domain/organisations/status.js` — permitted status transitions (`suspended → cancelled`).
- `src/repositories/organisations/schema/accreditation.js`,
  `src/repositories/organisations/schema/registration.js` — `validFrom`/`validTo` are the only date
  fields; required when approved/suspended; no `cancelledAt`.
