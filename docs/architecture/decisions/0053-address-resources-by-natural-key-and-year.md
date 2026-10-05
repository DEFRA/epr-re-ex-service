# 53. Address resources by natural key and year

Date: 2026-10-05

## Status

Proposed

Supersedes Part 2 of [ADR 0048](0048-dual-multi-year-summary-logs.md), and the line in its
Consequences about breaking the report and ledger routes. Part 1 of ADR 0048 still stands, except
that its storage keys hold the accreditation number in place of `accreditationId`.

Builds on [ADR 0052](0052-organisation-read-model.md), proposed in PR #491, which defines the
organisation, registration and accreditation resources and their routes. This ADR covers what hangs
off them: summary logs, reports, the waste-balance ledger and PRNs.

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

| Resource      | Natural key          | Stored as             |
| ------------- | -------------------- | --------------------- |
| Organisation  | organisation number  | `orgId`               |
| Registration  | registration number  | `registrationNumber`  |
| Accreditation | accreditation number | `accreditationNumber` |

Using these keys gives every service the same identifier for the same thing. The organisation
already has three identifiers between Defra ID, `epr-backend` and the EPR domain; registrations and
accreditations would follow the same path if each service kept its own.

The second change is the year. [ADR 0034](0034-multi-year-accreditation-model.md) settled that a
registration has at most one accreditation per year. So the accreditation a request needs is "this
registration's accreditation for this year": a slot, which returns `404` when it is empty. ADR 0052
addresses it as `.../registrations/{registrationNumber}/accreditations/{year}`. The accreditation
number is still the accreditation's identity, and it is served as a field.

## Decision

These routes follow the team's API design rules: resources are addressed by their domain keys, the
path carries no version, and new routes are built beside the existing ones.

### Domain keys in place of database ids

An approved organisation, registration or accreditation is addressed by its natural key, and an
accreditation is addressed through its registration and year. A registration or accreditation that
has no number yet has not been approved, and it stays on the existing routes, as ADR 0052 says.

A resource the domain gives no key, such as one upload of a summary log, keeps its database id
until it is given a key of its own.

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

POST /organisations/{organisationNumber}/registrations/{registrationNumber}/accreditations/{year}/summary-log
GET  /organisations/{organisationNumber}/registrations/{registrationNumber}/accreditations/{year}/summary-log
```

Each stream has its own address, and an upload is posted to the stream it is for, so a summary log
is read back from the address it was posted to. The template states its processing type, as ADR 0048
says, so validation rejects a file whose template does not match the route's stream. This replaces
ADR 0048's single upload route.

An operator who was suspended, or accredited part way through a year, has both a registered-only and
an accredited summary log for that year. The frontend shows them as two rows, and each row links to
its own stream.

The routes beneath a summary log, such as `upload-completed`, `submit` and `file`, keep their
`{summaryLogId}` and move under these two addresses.

### Reports, waste-balance ledger and PRNs

The discussion that agreed this ADR did not cover these routes. They apply the same rules, and are
proposed for review:

```
.../registrations/{registrationNumber}/reports/{year}/{cadence}/...
.../registrations/{registrationNumber}/accreditations/{year}/reports/{cadence}/...

.../registrations/{registrationNumber}/waste-balance-ledger/{year}
.../registrations/{registrationNumber}/accreditations/{year}/waste-balance-ledger

.../registrations/{registrationNumber}/accreditations/{year}/packaging-recycling-notes/...
```

They replace ADR 0048's `{year}/accreditation/{accreditationId|none}` branch. The `none` sentinel
goes, because the registered-only stream no longer sits in the accreditation slot. PRNs are
accredited-only, so they have only the accredited route. A PRN number is quoted on its own, so it is
served as a field and found through a query on the collection.

The new PRN search for RPD obligations is a breaking change for that consumer anyway, so it is the
point at which it moves to these keys.

### Storage

ADR 0048 scopes summary logs, row state, row history and the ledger by
`{organisationId, registrationId, year, accreditationId}`. A 2027 accreditation has no
`accreditationId`, so these keys hold the accreditation number instead, with a migration for the
2026 records.

That is safe only if an accreditation number is unique, and nothing enforces that today. The
migration adds a unique index on the accreditation number, and on the registration number, so the
data proves the assumption before any key depends on it.

### What stays as it is

- **Existing routes stay for their current consumers** until those consumers move, so nothing they
  call breaks. The registration service's read of `GET /v1/organisations` is one of them, and the
  routes for unapproved records are others.
- **Old page URLs redirect.** Anyone with a bookmark is sent on to the new URL. In `epr-frontend` the
  organisation the user is signed in to already carries the natural keys of its registrations and
  accreditations. In `epr-re-ex-admin-frontend` the redirect reads the record through the existing
  route, which returns its numbers. An unapproved record has no number, so its page URL does not
  change.
- **The JSON editor stays on 2026 data** through the existing routes, so it never shows or edits 2027
  data. This assumes the registration service's case management covers that work for 2027.
- **The admin listing of every accreditation, including those with no registration, covers 2026
  only.** It is not rebuilt for 2027 accreditations.

## Open questions

- **Agreement from the services that will own the keys.** The registration service, and the service
  that will own organisations, need to issue and accept the same numbers. Otherwise each service has
  its own identifier again. This ADR is the starting point for that conversation.
- **The upload journey in the frontend.** The routes let a page either take the operator into one
  stream before the upload, or accept any summary log and send it to the stream its template names.
  That is a user experience decision.
- **`summary-log` under an accreditation.** An accreditation has one summary log, so the singular
  names a single resource. The design rules do not settle whether a resource that only ever has one
  child names it in the singular or the plural.
- **Storage for organisations and registrations.** Their data moves to other services too, so their
  keys could change when it does, or now.
- **Cutover.** The change is wide but shallow: every route and page changes the same way. Three ways
  to land it were discussed:
  - in one go, across the whole stack
  - page by page, with each new route also returning the database ids so the pages not yet moved
    can still build their links
  - layer by layer: the API and frontends first, then the ports, then storage

  Doing it in one go blocks the other workstream for as long as it takes, and may leave the
  pre-production environments undeployable until it is finished. The repository ports are id-based
  today, so going piece by piece may mean carrying two of every port for a while. The year routes
  from ADR 0048 are deployed, but no frontend uses them yet, so changing them now breaks nothing.

## Consequences

- Every frontend page URL for an approved record changes, in both frontends.
- The authorisation layer in `epr-backend` resolves an organisation by its number, not its id.
- The accreditations port from ADR 0034 takes a registration number and a year, so the 2027 adapter
  can ask the registration service with keys it knows.
- A storage migration replaces `accreditationId` with the accreditation number on summary logs, row
  state, row history and the ledger, and adds unique indexes on both numbers.
- If a registration ever has two accreditations in one year, the accreditation slot needs a
  different address.
