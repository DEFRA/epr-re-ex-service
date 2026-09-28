# 52. Organisation read model

Date: 2026-09-28

## Status

Proposed. Depends on [ADR-0051](./0051-status-as-a-dated-timeline.md) (status as a dated timeline,
with an accreditation's validity window replaced by a scheme `year`) and
[ADR-0050](./0050-glass-as-two-material-types.md) (glass re-melt and glass other as materials).

## Context

`GET /v1/organisations/{id}` returns the stored organisation document, unprojected: every form
field, contact, file upload, status history entry, and the flat `registrations[]` and
`accreditations[]` arrays joined by `registration.accreditationId`. The frontends read a small
fraction of it, and each reads it through a different shape:

- `epr-frontend` reads the raw document, plus the `registrations` and `accreditations`
  sub-resources, which reshape the same data into `application.*` and `dateRange.*`.
- `epr-re-ex-admin-frontend` reads the raw document for its list page and JSON editor, and
  `/overview`, a backend projection, everywhere else.

So there are four shapes of one record, the join between registration and accreditation is
reimplemented in each frontend, and neither frontend reads `statusHistory`, `validTo`, or any
accreditation field other than `id`, `accreditationNumber`, `status` and — in one place, for its
year only — `validFrom`.

ADR-0034 made accreditations one per scheme year per registration. ADR-0051 replaces an
accreditation's `validFrom`/`validTo` with that `year`, and makes status a timeline projected from
events, so the current status is a single derived value.

## Decision

`GET /v1/organisations/{id}` returns an organisation with its registrations nested, and each
registration's accreditations nested within it, carrying only the fields the frontends use.

```js
/**
 * @typedef {{
 *   id: string
 *   orgId: number
 *   name: string
 *   tradingName?: string
 *   status: 'created' | 'approved' | 'active' | 'rejected'
 *   submittedToRegulator: 'ea' | 'nrw' | 'sepa' | 'niea'
 *   linkedDefraOrganisation?: {
 *     orgId: string
 *     orgName: string
 *     linkedAt: string
 *     linkedBy: { email: string }
 *   }
 *   registrations: Registration[]
 * }} Organisation
 *
 * @typedef {{
 *   id: string
 *   registrationNumber: string | null
 *   status: 'created' | 'approved' | 'rejected' | 'cancelled'
 *   validFrom: string | null
 *   material: string
 *   wasteProcessingType: 'reprocessor' | 'exporter'
 *   reprocessingType?: 'input' | 'output'
 *   submittedToRegulator: 'ea' | 'nrw' | 'sepa' | 'niea'
 *   site: {
 *     address: {
 *       line1: string
 *       line2?: string
 *       town: string
 *       county?: string
 *       postcode: string
 *     }
 *   } | null
 *   accreditations: Accreditation[]
 * }} Registration
 *
 * @typedef {{
 *   id: string
 *   year: number
 *   accreditationNumber: string | null
 *   status: 'created' | 'approved' | 'suspended' | 'rejected' | 'cancelled'
 * }} Accreditation
 */
```

- **`status` is today's value on the timeline** (ADR-0051). The timeline and its events are not
  returned; nothing in either frontend reads them.
- **Accreditations are ordered by `year`.** The current accreditation is the one whose `year` is
  the current scheme year. Its material, processing type, site and regulator are its
  registration's.
- **`site` is `null` for exporters.**
- **`companyDetails` is flattened** to `name` and `tradingName`.

Not returned, and not read by either frontend: `statusHistory`, accreditation `validFrom`/`validTo`,
`registration.accreditationId` (nesting replaces it), `glassRecyclingProcess` (ADR-0050),
accreditation `material`/`wasteProcessingType`/`site`/`submittedToRegulator`, `registration.orgName`
(the organisation's `name` replaces it), and all form, contact, permit, file upload, user and
PRN-issuance data. Those stay in the store for the backend's own use.

Auth is unchanged: `organisationRead` and `adminRead`.

## Consequences

- One shape for both frontends. The `/overview` projection and the `registrations`/`accreditations`
  sub-resources become redundant, and are retired once their callers have moved.
- The frontends stop joining registrations to accreditations and stop deciding which accreditation
  is live; the reapply journey reads `year` rather than parsing it from `validFrom`, and date-range
  display uses `year`.
- The admin JSON editor needs the stored document, so it moves to its own `adminRead`-scoped route.
- The route's `BASIC_AUTH` strategy means an external consumer may already read the full document
  from it. That consumer needs confirming before the response narrows.
- A response schema is added to the route, so the contract is enforced rather than implied by the
  store.

## Related

- [ADR-0034](./0034-multi-year-accreditation-model.md) — one accreditation per registration per
  scheme year
- [ADR-0035](./0035-read-organisation-data-with-basic-auth.md) — basic-auth access to organisation
  data
- [ADR-0050](./0050-glass-as-two-material-types.md) — `material` carries the glass type
- [ADR-0051](./0051-status-as-a-dated-timeline.md) — status timeline and accreditation `year`
