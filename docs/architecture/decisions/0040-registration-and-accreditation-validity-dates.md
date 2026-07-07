# 40. Registration and accreditation validity dates (`validFrom` / `validTo`)

Date: 2026-07-07

## Status

Proposed

## Context

Every registration and accreditation sub-document carries a `validFrom` and a `validTo`
date (see [ADR 34](0034-multi-year-accreditation-model.md) for the field inventory). These
dates are not descriptive metadata — they are the temporal gate that several downstream
business rules depend on. Before this ADR, the rule for _how those dates are set_ lived only
in a wiki page and its comment thread; this record captures the business rules and their
statutory basis so the determination logic is documented alongside the code that consumes it.

### Why the dates exist (business drivers)

An RE/EX registration and accreditation each cover a **bounded period**, and the answer to
"was this operator entitled to do X on date D?" is decided by whether D falls inside that
period. The dates are consumed by:

- **Waste balance** — a waste load only counts toward the PRN-issuable balance if its date
  is within the accreditation validity window. From the wiki: _"loads will not contribute to
  waste balance until dates fall within accreditation dates are valid."_
- **PRN/PERN issuance eligibility** — only accredited operators may issue PRNs/PERNs, and only
  while the accreditation is valid (BR-E2). `validFrom` is also the source for the accreditation
  _year_ stamped on a PRN.
- **Reporting cadence** — registered-only operators report quarterly; accredited operators
  report monthly (BR-E5, [ADR 28](0028-reporting-api-and-due-rules.md)). Which cadence applies
  to a period is decided by whether that period overlaps a valid accreditation.
- **Public register** — the accreditation number and "granted" status are shown from the
  accreditation start date, and suspended/cancelled entries are flagged (BR-REG2,
  [ADR 25](0025-public-register-generation.md)).

Both registration and accreditation are **annual** (BR-E1, BR-E2), which is why there is an
end date at all.

## Decision

### Rule 1 — `validFrom` is the date of determination

`validFrom` is set to the **date the regulator determines (approves/grants)** the registration
or accreditation. This is the exact approval date, not the first of the month.

- **Accreditation** has a statutory start date: the regulations stipulate the date of
  determination as the start.
- **Registration** has no statutory "start date" concept — a registration is granted and then
  runs annually. DEFRA policy takes the **date of determination of the registration application**
  as the de facto start date, and treats all pEPR requirements relating to registration as
  applying from that date forward (never retrospectively to before registration).

No data is expected for any period before `validFrom` (no retrospective reporting pre-registration
or pre-accreditation).

### Rule 2 — `validTo` is the end of the scheme year (31 December)

`validTo` is set to **31 December of the scheme year** in which the registration/accreditation
was determined. The scheme year is the calendar year: the annual RE/EX return is due _"by
28 February following the accreditation year"_ and PRNs must be accepted _"by 31 January of the
following year"_ — both anchor the year end at 31 December.

### Rule 3 — suspension and cancellation do not move the window

`validFrom`/`validTo` record the **granted period**. If an accreditation is suspended and later
reinstated, the dates are unchanged; the interruption is recorded in `status` / `statusHistory`
(queried by the suspended-at-date check — see [ADR 34](0034-multi-year-accreditation-model.md)).
"Was the operator live on day D?" is answered by combining the validity window (are we inside
`validFrom`..`validTo`?) with status history (were they suspended on D?). A suspended accreditation
therefore keeps its number and can reactivate if the suspension is lifted.

### Worked example — accreditation approved 3 February 2026

An operator must already be registered to be accredited (SIP Part 1 is submitted at registration,
Part 2 at accreditation — BR-E2), so there are **two separate determination events** with their
own dates.

| Record            | `validFrom`                                                     | `validTo`    |
| ----------------- | --------------------------------------------------------------- | ------------ |
| **Registration**  | Date the registration was determined (on or before 3 Feb 2026)  | `2026-12-31` |
| **Accreditation** | `2026-02-03` (date of determination)                            | `2026-12-31` |

If registration and accreditation are determined on the same day, both `validFrom` are
`2026-02-03`.

Reporting cadence on a mid-period transition (e.g. quarterly for the part period up to the
accreditation start, then monthly thereafter) is out of scope for this ADR and will be recorded
in a separate reporting ADR. The earlier "whole quarter becomes monthly" interpretation is not
carried here — it does not affect how `validFrom`/`validTo` are set.

## Consequences

- The determination date must be captured and persisted at approval time; it cannot be
  reconstructed later from status history alone.
- Consumers must always evaluate the validity window **together with** status history — the
  window alone does not tell you whether the operator was suspended on a given day.
- `validFrom` being the source of the PRN accreditation year means an off-by-one determination
  date (e.g. a determination recorded on 1 January vs 31 December) changes the year a PRN is
  attributed to. Determination dates must be recorded accurately.

## Open question — registration end date (`validTo`)

**How should a registration's `validTo` behave at year end — a hard 31 December that requires
renewal, or a date that rolls forward?**

DEFRA policy describes registration as _"for a year and then **rolls on** unless cancelled or
withdrawn"_, whereas accreditation is unambiguously a fixed annual grant that must be renewed.
This leaves the registration `validTo` semantics unresolved:

- **Option A — hard annual expiry.** `validTo` = 31 December; the registration lapses at year
  end unless a renewal is determined, matching the accreditation model and the annual renewal
  fee (BR-E1, £1,571 per active registration).
- **Option B — roll-on.** `validTo` is open-ended (or auto-extended) and only set when the
  registration is actively cancelled or withdrawn (Reg 90), matching the "rolls on" wording.

This needs a policy owner to confirm before the registration renewal / lapse behaviour is
finalised. It also interacts with the multi-year model in
[ADR 34](0034-multi-year-accreditation-model.md) and the registered-only edge cases in
[ADR 30](0030-registered-only-edge-cases.md) (cancellation handling). Until confirmed, treat
registration `validTo` as 31 December of the determination year (Option A) but do not build
hard-lapse enforcement that would be wrong under Option B.

## References

### Confluence (MWR space, eaflood.atlassian.net)

- **Reporting: mid-year registration / accreditation and suspensions** — page 6475481144.
  Primary source: DEFRA policy statement (Pete Spink) that accreditation's start is the
  statutory _date of determination_ and registration's start is the _date of determination of
  the application_; the mid-quarter cadence rule; the waste-balance-within-valid-dates rule;
  and the worked `2026-02-01 → 2026-12-31` example in the comment thread.
- **pEPR Packaging — Statutory Requirements and Business Rules** — page 6521095536. BR-E1
  (annual RE/EX registration per site/material), BR-E2 (only accredited operators may issue
  PRNs/PERNs; annual renewal; SIP Part 1/Part 2 sequencing), BR-E5 (registered = quarterly,
  accredited = monthly + annual return by 28 Feb following the accreditation year), BR-REG2
  (public register; suspended/withdrawn entries flagged).
- **Data structure view – RREPW** — page 6546358726. Public-register column mapping:
  Active date → `accreditations.validFrom`; Accreditation status → `accreditations.status`.

### Regulations

- **SI 2024/1332** — Producer Responsibility Obligations (Packaging and Packaging Waste)
  Regulations 2024, as amended by SI 2025/1369. Part 6 (Regs 84–100) — RE/EX registration and
  accreditation; Reg 90 — cancellation of RE/EX registration; Reg 91 — reporting duties of
  _registered_ operators (basis for no pre-registration reporting obligation); Reg 129 —
  public register.

### Related ADRs

- [ADR 25 — Public Register of Registrations/Accreditations](0025-public-register-generation.md)
- [ADR 28 — Reporting API and Due Rules](0028-reporting-api-and-due-rules.md)
- [ADR 30 — Registered-only operator edge cases](0030-registered-only-edge-cases.md)
- [ADR 34 — Multi-year accreditation model](0034-multi-year-accreditation-model.md)
