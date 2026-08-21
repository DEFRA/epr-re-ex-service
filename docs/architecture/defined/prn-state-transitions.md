# PRN State Transitions

This document describes the state machine for Packaging Recycling Notes (PRNs) in
the EPR backend: the statuses a PRN moves through, the actors permitted to drive
each transition, the waste balance effects, and the preconditions that gate them.

For related context, see:

- [ADR 24: Create PRN API strategy](../decisions/0024-create-prn-api-strategy.md) - how draft PRNs are created and incrementally updated
- [ADR 36: Event-sourced waste balance stream](../decisions/0036-event-sourced-waste-balance-stream.md) - the stream the balance effects append to

<!-- prettier-ignore-start -->
<!-- TOC -->

- [PRN State Transitions](#prn-state-transitions)
  - [States](#states)
  - [Actors](#actors)
  - [Diagram](#diagram)
  - [Transitions in detail](#transitions-in-detail)
  - [Waste balance effects](#waste-balance-effects)
  - [Preconditions](#preconditions)
  - [Scope](#scope)
  - [Implementation](#implementation)

<!-- TOC -->
<!-- prettier-ignore-end -->

## States

| Status                   | Description                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `draft`                  | PRN details being entered. Not yet created.                                                                   |
| `awaiting_authorisation` | PRN created by the reprocessor/exporter, awaiting a signatory to issue it. Available balance is ringfenced.   |
| `awaiting_acceptance`    | PRN authorised and issued. PRN number allocated, total balance deducted. Awaiting producer/scheme acceptance. |
| `accepted`               | Producer/compliance scheme accepted the PRN. May be cancelled by a service maintainer (via the admin portal) until 31 January of the following compliance year. |
| `awaiting_cancellation`  | Producer/compliance scheme rejected the PRN. Awaiting the signatory to cancel it.                             |
| `cancelled`              | PRN cancelled after issue. Waste balance fully reversed. Terminal state.                                      |
| `deleted`                | PRN deleted before issue. Ringfenced balance released. Terminal state.                                        |
| `discarded`              | Draft discarded before creation. No balance interaction. Terminal state.                                      |

## Actors

| Actor                        | Code value             | Actions                                                                |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Reprocessor / Exporter       | `reprocessor_exporter` | Enters PRN details (draft), creates PRN, discards draft                |
| PRN Signatory                | `signatory`            | Authorises & issues, deletes (pre-issue), cancels (post-rejection)     |
| Producer / Compliance Scheme | `producer`             | Accepts or rejects an issued PRN (via the external API)                |
| Service Maintainer           | `service_maintainer`   | Cancels an accepted PRN via the admin portal, within the compliance-year window (PAE-1823) |
| Regulator                    | _(none yet)_           | Direct cancellation of an issued PRN — not yet implemented; the accepted-PRN case is delivered above, for the admin portal rather than a regulator-facing one |

## Diagram

```mermaid
stateDiagram-v2
    [*] --> draft: Reprocessor/Exporter<br/>Enter PRN details

    draft --> awaiting_authorisation: Reprocessor/Exporter<br/>Create PRN<br/>/ Deduct available balance<br/>[Sufficient available balance]
    draft --> discarded: Reprocessor/Exporter<br/>Discard

    awaiting_authorisation --> awaiting_acceptance: PRN Signatory<br/>Authorise & Issue PRN<br/>/ Allocate PRN number<br/>/ Deduct total balance<br/>[Sufficient total balance]<br/>[Accreditation not suspended]
    awaiting_authorisation --> deleted: PRN Signatory<br/>Delete PRN<br/>/ Credit available balance

    awaiting_acceptance --> accepted: Producer/Compliance Scheme<br/>Accept PRN
    awaiting_acceptance --> awaiting_cancellation: Producer/Compliance Scheme<br/>Reject PRN

    awaiting_cancellation --> cancelled: PRN Signatory<br/>Cancel PRN<br/>/ Credit full balance

    awaiting_acceptance --> cancelled: Regulator<br/>Cancel PRN<br/>/ Reverse balance<br/>(future scope)
    accepted --> cancelled: Service Maintainer<br/>Cancel PRN (admin portal)<br/>/ Credit full balance<br/>[Within cancellation window]

    cancelled --> [*]
    deleted --> [*]
    discarded --> [*]
```

> The regulator-initiated `awaiting_acceptance → cancelled` transition is not
> implemented. `accepted → cancelled` is delivered (PAE-1823), driven by a
> service maintainer via the admin portal rather than a regulator-facing one.

## Transitions in detail

| From                     | To                       | Actor                | Trigger           | Stream event                | Balance effect           |
| ------------------------ | ------------------------ | -------------------- | ----------------- | --------------------------- | ------------------------ |
| `draft`                  | `awaiting_authorisation` | Reprocessor/Exporter | Create PRN        | `PRN_CREATED`               | Deduct available balance |
| `draft`                  | `discarded`              | Reprocessor/Exporter | Discard draft     | _(none)_                    | None                     |
| `awaiting_authorisation` | `awaiting_acceptance`    | Signatory            | Authorise & issue | `PRN_ISSUED`                | Deduct total balance     |
| `awaiting_authorisation` | `deleted`                | Signatory            | Delete PRN        | `PRN_CREATION_CANCELLED`    | Credit available balance |
| `awaiting_acceptance`    | `accepted`               | Producer             | Accept PRN        | `PRN_ACCEPTED`              | None (status only)       |
| `awaiting_acceptance`    | `awaiting_cancellation`  | Producer             | Reject PRN        | `PRN_REJECTED`              | None (status only)       |
| `awaiting_cancellation`  | `cancelled`              | Signatory            | Cancel PRN        | `PRN_CANCELLED_AFTER_ISSUE` | Credit full balance      |
| `accepted`               | `cancelled`              | Service Maintainer   | Cancel PRN (admin portal) | `PRN_CANCELLED_AFTER_ISSUE` | Credit full balance |

Accept and reject are driven by the producer through the external API; the
admin-portal cancellation is driven by a service maintainer through a dedicated
admin route (`admin.write` scope), which supplies the actor explicitly rather
than inferring it from status; the remaining transitions are driven internally
and the permitted actor is inferred from the PRN's current status.

## Waste balance effects

The waste balance carries two figures: a **total** amount and the **available**
amount (total less anything ringfenced by in-flight PRNs). PRNs move balance in
two phases so that a created-but-not-yet-issued PRN cannot be double-spent:

- **On create** (`draft → awaiting_authorisation`): the tonnage is deducted from
  **available** balance, ringfencing it while the PRN awaits a signatory.
- **On issue** (`awaiting_authorisation → awaiting_acceptance`): the tonnage is
  deducted from **total** balance, completing the spend, and the PRN number is
  allocated.

Reversals mirror whichever phases had been applied:

- **Delete** (`awaiting_authorisation → deleted`) credits **available** balance,
  releasing the creation ringfence.
- **Cancel** (`awaiting_cancellation → cancelled`, or `accepted → cancelled`
  via the admin portal) credits **both** total and available balance,
  reversing the create and issue deductions. Both cancellation paths emit the
  same `PRN_CANCELLED_AFTER_ISSUE` event and the same full credit.

Accept and reject are balance-neutral: they append a status-only event to the
stream and move no balance.

## Preconditions

- **Sufficient available balance** at create — `availableAmount` must be at least
  the PRN tonnage, otherwise creation is rejected.
- **Sufficient total balance** at issue — `amount` must be at least the PRN
  tonnage, otherwise issue is rejected.
- **A waste balance must exist** for the accreditation at both create and issue.
- **The accreditation must not be suspended** at issue.
- **Within the cancellation window** at admin-portal cancellation — an
  accepted PRN issued under an accreditation for compliance year Y may be
  cancelled up to and including 31 January of Y+1, evaluated on the
  accreditation year the PRN was issued under, not the date it was accepted.

## Scope

Delivered: `draft`, `discarded`, `awaiting_authorisation`, `awaiting_acceptance`,
`accepted`, `awaiting_cancellation`, `deleted`, `cancelled`, including producer
acceptance/rejection, signatory cancellation, and service-maintainer
cancellation of an accepted PRN via the admin portal (PAE-1823). The
admin-portal cancellation route and its list-page visibility are both gated
behind the `FEATURE_FLAG_PRN_ADMIN_CANCELLATION` flag (off by default), so the
transition is only reachable once the flag is enabled for an environment.

Future scope: regulator-initiated direct cancellation of an issued
(`awaiting_acceptance`) PRN, shown dashed in the diagram above.

## Notes

- A PRN must not be edited by a reprocessor/exporter once issued. Where the
  producer has rejected it, the only action is to cancel — it cannot be re-issued.
- "Pending" (uncommitted) waste balance is not considered here.

## Implementation

| Concern                                          | Location                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Status values, actors, transition table          | `src/packaging-recycling-notes/domain/model.js`                              |
| Status update handler                            | `src/packaging-recycling-notes/routes/status.js`                             |
| Transition orchestration & PRN number allocation | `src/packaging-recycling-notes/application/update-status.js`                 |
| Waste balance effects per transition             | `src/packaging-recycling-notes/application/update-status-balance-effects.js` |
| External accept / reject endpoints               | `src/packaging-recycling-notes/routes/accept.js`, `reject.js`                |
| Cancellation window rule (PAE-1823)              | `src/packaging-recycling-notes/domain/cancellation-window.js`                |
| Admin cancellation endpoint (PAE-1823)           | `src/packaging-recycling-notes/routes/admin-cancel.js`                       |

> Paths are relative to the `epr-backend` repository root.
