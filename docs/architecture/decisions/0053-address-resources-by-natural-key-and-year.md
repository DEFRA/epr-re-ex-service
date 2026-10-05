# 53. Address resources by natural key and year

Date: 2026-10-05

## Status

Proposed

Supersedes the route shapes in Part 2 of [ADR 0048](0048-dual-multi-year-summary-logs.md). ADR 0048's
storage scoping still stands, except that the accreditation is identified by its number rather than
by its database id.

## Context

Every `epr-backend` route, and every page URL in the two frontends, addresses organisations,
registrations and accreditations by their MongoDB `_id`. That id is one we made up, and it has leaked
into our external interface.

From 2027 the registration service holds accreditations, and later registrations too, and the
organisation will live in its own service. Those services will not know our ids, and they may not
use MongoDB at all. A 2027 accreditation arrives from the registration service with no
`epr-backend` id, so a route that names `{accreditationId}` cannot address it. A consumer that
already receives our ids, such as the registration service reading `GET /v1/organisations`, would
have to carry them into its own database.

The domain already issues an identifier for each of these resources, and users quote them:

| Resource      | Natural key          |
| ------------- | -------------------- |
| Organisation  | organisation number  |
| Registration  | registration number  |
| Accreditation | accreditation number |

Using these keys gives every service the same identifier for the same thing. The organisation
already has three identifiers between Defra ID, `epr-backend` and the EPR domain; registrations and
accreditations would follow the same path if each service kept its own.

The second change is the year. [ADR 0034](0034-multi-year-accreditation-model.md) settled that a
registration has at most one accreditation per year. So the accreditation a request needs is "this
registration's accreditation for this year": a slot, which returns `404` when it is empty. The year
replaces the accreditation number in the path. The accreditation number is still the
accreditation's identity, and it is returned as a field.

## Decision

### Natural keys, never database ids

No route or page URL carries a database id. Organisations, registrations and accreditations are
addressed by their natural keys, and an accreditation is addressed through its registration and
year. The new routes carry no version segment.

### Where the year goes

- **A registration has no year.** It spans years unchanged, so a year never qualifies the registration
  itself.
- **The year follows the thing it applies to.** Summary logs, reports and ledgers belong to a year,
  so the year follows them.
- **An accredited stream sits under its accreditation, and the accreditation is addressed by year.**
  The year then appears once, in the accreditation slot, and the resource after it needs no year of
  its own.

### Summary logs

```
POST /organisations/{organisationNumber}/registrations/{registrationNumber}/summary-logs/{year}

GET  /organisations/{organisationNumber}/registrations/{registrationNumber}/summary-logs/{year}
GET  /organisations/{organisationNumber}/registrations/{registrationNumber}/accreditation/{year}/summary-logs
```

There is one upload route for both streams. As ADR 0048 says, the template states its processing
type and an accredited template carries its accreditation number, so validation decides the stream
from the file.

Reading back needs two routes. An operator who was suspended, or accredited part way through a year,
has both a registered-only and an accredited summary log for that year. The frontend shows them as
two rows, and each row links to its own stream.

### Reports, waste-balance ledger and PRNs

These follow the same rule:

```
/organisations/{organisationNumber}/registrations/{registrationNumber}/reports/{year}/{cadence}/...
/organisations/{organisationNumber}/registrations/{registrationNumber}/accreditation/{year}/reports/{cadence}/...

/organisations/{organisationNumber}/registrations/{registrationNumber}/waste-balance-ledger/{year}
/organisations/{organisationNumber}/registrations/{registrationNumber}/accreditation/{year}/waste-balance-ledger

/organisations/{organisationNumber}/registrations/{registrationNumber}/accreditation/{year}/packaging-recycling-notes/...
```

This replaces ADR 0048's `{year}/accreditation/{accreditationId|none}` branch. The `none` sentinel
goes, because the registered-only stream no longer sits in the accreditation slot. PRNs are
accredited-only, so they have only the accredited route, and ADR 0048's exception for PRN routes no
longer applies.

### Storage

ADR 0048 scopes summary logs, row state, row history and the ledger by
`{organisationId, registrationId, year, accreditationId}`. A 2027 accreditation has no
`accreditationId`, so these keys hold the accreditation number instead, with a migration for the
2026 records. Whether storage also moves to the organisation and registration numbers is left open
(see Open questions).

### What stays as it is

- **Existing routes stay for their current consumers** until those consumers move, so nothing they
  call breaks. The registration service's read of `GET /v1/organisations` is one of them.
- **Old page URLs redirect.** Anyone with a bookmark is sent on to the new URL. The organisation the
  user is signed in to already carries the natural keys of its registrations and accreditations,
  so the lookup needs no new call.
- **The JSON editor and the admin views of every accreditation stay on 2026 data** through the
  existing routes. The registration service's case management replaces them for 2027, so they never
  show or edit 2027 data.

## Open questions

- **`summary-logs` or `summary-log`.** A summary log as an uploaded file has many instances, which
  argues for the plural. A summary log as the year's waste records is one thing, which argues for
  the singular. This ADR uses the plural.
- **Storage for organisations and registrations.** Their data moves to other services too, so their
  keys could change when it does, or now.
- **Cutover.** The change is wide but shallow: every route and page changes the same way. It can land
  in one go, or route by route with each new route returning the database ids alongside the natural
  keys until every page has moved. The repository ports are id-based today, so going piece by piece
  may mean carrying two of every port for a while.

## Consequences

- Every frontend page URL changes, in both frontends.
- The authorisation layer in `epr-backend` resolves an organisation by its number, not its id.
- The accreditations port from ADR 0034 takes a registration number and a year, so the 2027 adapter
  can ask the registration service with keys it knows.
- A storage migration replaces `accreditationId` with the accreditation number on summary logs, row
  state, row history and the ledger.
- If a registration ever has two accreditations in one year, the accreditation slot needs a
  different address.
