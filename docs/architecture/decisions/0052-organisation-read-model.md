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

A new endpoint, `GET /organisations/{organisationNumber}`, returns an organisation with its
registrations nested, and each registration's accreditations nested within it, carrying only the
fields the frontends use. `organisationNumber` is the organisation's `orgId`.
`GET /v1/organisations/{id}` is unchanged and goes on returning the stored document.

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
 *   overseasSites: Record<string, OverseasSite>
 *   accreditations: Record<string, Accreditation>
 * }} Registration
 *
 * @typedef {{
 *   name: string
 *   country: string
 *   address: {
 *     line1: string
 *     line2?: string
 *     townOrCity: string
 *     stateOrRegion?: string
 *     postcode?: string
 *   }
 *   coordinates?: string
 *   validFrom: string | null
 * }} OverseasSite
 *
 * @typedef {{
 *   id: string
 *   accreditationNumber: string | null
 *   status: 'created' | 'approved' | 'suspended' | 'rejected' | 'cancelled'
 * }} Accreditation
 */
```

- **`status` is today's value on the timeline** (ADR-0051). The timeline and its events are not
  returned; nothing in either frontend reads them.
- **Accreditations are keyed by scheme year** (`"2026"`), so there cannot be two for one year and
  the current one is `accreditations[currentYear]`. Its material, processing type, site and
  regulator are its registration's.
- **`site` is `null` for exporters, and `overseasSites` is empty for reprocessors.**
- **Overseas sites are keyed by `orsId`**, the three-digit id used in summary logs, as they are
  stored today. Site details are resolved from the `overseas-sites` collection rather than returned
  as a site id. `validFrom` is the regulator's approval date, and `null` for an unapproved or
  interim site ([ADR-0041](./0041-interim-site-modelling-and-ingestion.md)).
- **`companyDetails` is flattened** to `name` and `tradingName`.

Not returned, and not read by either frontend: `statusHistory`, accreditation `validFrom`/`validTo`,
`registration.accreditationId` (nesting replaces it), `glassRecyclingProcess` (ADR-0050),
accreditation `material`/`wasteProcessingType`/`site`/`submittedToRegulator`, the overseas site's
internal `overseasSiteId`, `createdAt` and `updatedAt`, `registration.orgName`
(the organisation's `name` replaces it), and all form, contact, permit, file upload, user and
PRN-issuance data. Those stay in the store for the backend's own use.

Auth: the `organisationRead` and `adminRead` scopes.

### Affected endpoints

| Endpoint | Effect |
| --- | --- |
| `GET /organisations/{organisationNumber}` | New: returns this model |
| `GET /v1/organisations/{id}` | Unchanged |
| `GET /v1/organisations` | Unchanged |
| `PUT /v1/organisations/{id}` | Unchanged |
| `GET /v1/organisations/{id}/overview` | Retired |
| `GET .../registrations`, `.../registrations/{id}` | Retired |
| `GET .../accreditations`, `.../accreditations/{id}` | Retired |
| `GET .../registrations/{id}/overseas-sites`, `.../accreditations/{id}/overseas-sites` | Retired |

### Backend-only fields

The backend's own processing reads the model above plus the following. They are not returned.

```js
/**
 * @typedef {Organisation & {
 *   version: number
 *   statusTimeline: StatusTimeline
 *   companiesHouseNumber?: string
 *   registeredAddress?: Address
 *   users: { email: string, roles: string[], contactId?: string }[]
 *   submitterContactDetails: Contact
 *   linkedDefraOrganisation?: { linkedBy: { id: string } }
 * }} StoredOrganisation
 *
 * @typedef {Registration & {
 *   statusTimeline: StatusTimeline
 *   site: { address: { region?: string, country?: string } } | null
 *   submitterContactDetails: Contact
 *   applicationContactDetails: Contact
 *   approvedPersons: Contact[]
 * }} StoredRegistration
 *
 * @typedef {Accreditation & {
 *   statusTimeline: StatusTimeline
 *   prnIssuance: { tonnageBand: string, signatories: Contact[] }
 *   submitterContactDetails: Contact
 * }} StoredAccreditation
 *
 * @typedef {{ fullName: string, email: string, phone?: string }} Contact
 */
```

| Field | Read by |
| --- | --- |
| `version` | Optimistic locking on every write |
| `statusTimeline` (ADR-0051) | Current status and transition rules; the accreditation's is read at a date for row classification and monthly reports owed |
| `companiesHouseNumber`, `registeredAddress`, registration `site.address.region`/`country` | Public register |
| `users`, contact details, `approvedPersons`, `prnIssuance.signatories` | Collating users for linking and Defra roles; report submission contact export |
| `linkedDefraOrganisation.linkedBy.id` | Unlinking |
| `prnIssuance.tonnageBand` | Public register, PRN tonnage, market insights |

An accreditation's material, processing type, site and regulator — used for the PRN snapshot, the
PRN/PERN flag, the December pool and PRN numbering — are read from its registration, as they are
for the frontends. The registration–accreditation match rule already guarantees material,
processing type and site postcode agree; the regulator needs the same guarantee.

## Consequences

- One shape for both frontends. The retired routes above go once their callers have moved. The
  admin ORS list, a cross-organisation report, and the per-report export activity are not
  organisation reads and are unaffected.
- Existing consumers of `GET /v1/organisations/{id}` — the admin JSON editor and basic-auth
  clients — are unaffected.
- The frontends stop joining registrations to accreditations and stop deciding which accreditation
  is live; the reapply journey reads the accreditation's year rather than parsing it from
  `validFrom`, and date-range display uses the year.
- Both `overseas-sites` routes accept basic auth, so an external consumer may read them. That
  consumer needs confirming before they are retired.
- The new route has a response schema, so its contract is enforced rather than implied by the
  store.

## Related

- [ADR-0034](./0034-multi-year-accreditation-model.md) — one accreditation per registration per
  scheme year
- [ADR-0035](./0035-read-organisation-data-with-basic-auth.md) — basic-auth access to organisation
  data
- [ADR-0041](./0041-interim-site-modelling-and-ingestion.md) — interim sites, which have no
  `validFrom`
- [ADR-0050](./0050-glass-as-two-material-types.md) — `material` carries the glass type
- [ADR-0051](./0051-status-as-a-dated-timeline.md) — status timeline and accreditation `year`
