# 42. Registration and accreditation validity dates and status-management rules

Date: 2026-07-08

## Status

Proposed

## Context

How should registration and accreditation status transitions be handled? Regulators need to grant,
reject, suspend, cancel and reinstate registrations and accreditations, and each of those changes
carries rules — which statuses it may move between, what happens to the regulator-issued number and
the validity dates, and from when the change takes effect. Free-form editing cannot enforce those
rules.

## Decision

**Status transitions are performed through explicit per-transition actions (buttons) in the admin
UI.** Each action posts to one of two status-history endpoints — one for registrations, one for
accreditations:

- `POST /v1/organisations/{organisationId}/registrations/{registrationId}/status-history`
- `POST /v1/organisations/{organisationId}/registrations/{registrationId}/accreditations/{accreditationId}/status-history`

The payload names the transition explicitly (`fromStatus` → `toStatus`) together with exactly the
parameters that transition needs; only the supported transitions are accepted. The endpoint checks
the record really is in the stated from-status, checks the transition is permitted, applies exactly
that transition's field changes, and appends the change to the record's status history. Editing
status through the admin JSON editor is blocked.

### Validity dates

`validFrom`..`validTo` is the entitlement window. It answers "was the operator entitled to do X on
date D?" and gates the waste balance (loads only count within the window), PRN/PERN issuance,
reporting cadence (registered = quarterly, accredited = monthly), and the public register.

- **`validFrom`** is the **date of determination** — for accreditation the statutory start date; for
  registration the de facto start date. It may be before, on, or after the day the approval is
  recorded.
- **`validTo`** is **31 December of the scheme year** and comes from the application data; no status
  transition changes it.

### Rules

1. **Granting (`created → approved`) sets the regulator-issued number and `validFrom`.** The number
   originates from the regulator and is supplied with the grant, together with the determination
   date, which becomes `validFrom`. A number may not already be in use by another record of the same
   kind. A record must hold a number and both dates whenever it is `approved` or `suspended`.
2. **A `created` record carries no number and no validity dates.** The number and dates always
   reflect the latest grant.
3. **The `approved` transition timestamp is a record only.** `validFrom` is the effective start of
   entitlement; the timestamp of the approval in status history is used for nothing else. The
   determination date must therefore be captured at grant time — it cannot be reconstructed from
   status history.
4. **Suspension takes effect from its transition timestamp.** Loads dated on or after the
   suspension are excluded from the waste balance. The validity window itself is unchanged, so a
   lifted suspension reactivates with the original `validFrom`.
5. **Cancellation works exactly like suspension: it takes effect from its transition timestamp.**
   Loads dated on or after the cancellation are excluded from the waste balance; the validity dates
   are never cleared or shortened. Because cancellation is terminal, a cancelled accreditation is
   also not live: its accreditation number no longer resolves and its registration is treated as
   registered-only. Cancelled records remain visible on the public register.
6. **Rejection (`created → rejected`) refuses an application.** No number and no dates are involved,
   and a rejected application can be reopened for rework (`rejected → created`).

"Was the operator live on day D?" is always answered by combining the validity window with the
effective status at that date — the window alone is not enough.

### Permitted transitions — registration

Registrations have no suspended state: a registration is either live or terminated.

| Transition             | Action    | Notes                                                                                        |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `created → approved`   | Grant     | Sets `registrationNumber` and `validFrom` (Rule 1)                                            |
| `created → rejected`   | Reject    | Refuse a non-compliant application                                                            |
| `rejected → created`   | Reopen    | Application returns for rework                                                                |
| `approved → cancelled` | Cancel    | Direct cancel; force-cancels the linked live accreditation in the same change                 |
| `cancelled → approved` | Reinstate | After a successful appeal, effective the day actioned; the force-cancelled accreditation is **not** auto-reinstated |

### Permitted transitions — accreditation

User-driven cancellation is suspended-first: there is no direct `approved → cancelled` action. The
registration-cancellation cascade is the sole, system-driven exception.

| Transition              | Action    | Notes                                                                     |
| ----------------------- | --------- | ------------------------------------------------------------------------- |
| `created → approved`    | Grant     | Sets `accreditationNumber` and `validFrom` (Rule 1)                       |
| `created → rejected`    | Reject    | Operator stays registered-only                                            |
| `rejected → created`    | Reopen    | Application returns for rework                                            |
| `approved → suspended`  | Suspend   | Effective from the transition timestamp (Rule 4)                          |
| `suspended → approved`  | Reinstate | Original validity window preserved                                        |
| `suspended → cancelled` | Cancel    | Effective from the transition timestamp (Rule 5)                          |
| `cancelled → approved`  | Reinstate | After a successful appeal, effective the day actioned                     |

Either transition to `approved` (grant or reinstate) requires the linked registration to be
`approved`.

### PRN actions by accreditation status

Issuing is the balance-debiting action, so it is blocked as soon as the accreditation is not
`approved`; drafting is not balance-affecting, so it is blocked only once cancelled.

| Accreditation status | Loads counted (within window) | Create (draft) PRN | Issue PRN |
| -------------------- | ----------------------------- | ------------------ | --------- |
| `approved`           | ✅                             | ✅                  | ✅         |
| `suspended`          | ❌ from the suspension date     | ✅                  | ❌         |
| `cancelled`          | ❌ from the cancellation date   | ❌                  | ❌         |

## Consequences

- Every status change is a dated event: its status-history timestamp is its effective date.
  Suspension and cancellation consume that date directly; approval does not (Rule 3 — `validFrom`
  is the effective date and must be captured at grant).
- Consumers must always evaluate the validity window together with status history; neither alone
  answers whether an operator was live on a given date.
- `validFrom` determines the year a PRN is attributed to, so determination dates must be recorded
  accurately.
