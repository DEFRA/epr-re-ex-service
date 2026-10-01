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
registrations nested, and each registration's accreditations nested within it.
`organisationNumber` is the organisation's business reference, stored as `orgId`. It is not the
MongoDB `id`, and no database id appears in the new routes.
`GET /v1/organisations/{id}` is unchanged and goes on returning the stored document.

A field is served when a client needs it, and it is shaped as the domain defines it, not as a page
shows it. A field that no client needs yet is left out, because adding it later does not break
anyone.

The new routes serve only registrations and accreditations that have been granted a number. The
admin frontend goes on reading unapproved records from the `/v1` routes.

```js
/**
 * @typedef {{
 *   organisationNumber: number
 *   name: string
 *   tradingName?: string
 *   status: 'created' | 'approved' | 'active' | 'rejected'
 *   submittedToRegulator: Regulator
 *   linkedDefraOrganisation?: {
 *     defraOrganisation: { id: string, name: string }
 *     linkedAt: string
 *     linkedBy: { email: string }
 *   }
 *   registrations: Record<string, Registration>
 * }} Organisation
 *
 * @typedef {{ code: 'ea' | 'nrw' | 'sepa' | 'niea' }} Regulator
 *
 * @typedef {ReprocessorRegistration | ExporterRegistration} Registration
 *
 * @typedef {{
 *   status: 'approved' | 'cancelled'
 *   validFrom: string
 *   material: 'aluminium' | 'fibre' | 'glass_re_melt' | 'glass_other' | 'paper' | 'plastic'
 *     | 'steel' | 'wood'
 *   submittedToRegulator: Regulator
 * }} RegistrationCommon
 *
 * @typedef {RegistrationCommon & {
 *   wasteProcessingType: 'reprocessor'
 *   reprocessingType: 'input' | 'output'
 *   site: { address: UkAddress }
 *   accreditations: Record<string, Accreditation>
 * }} ReprocessorRegistration
 *
 * @typedef {RegistrationCommon & {
 *   wasteProcessingType: 'exporter'
 *   overseasSites: Record<string, OverseasSite>
 *   accreditations: Record<string, ExporterAccreditation>
 * }} ExporterRegistration
 *
 * @typedef {{
 *   name: string
 *   address: OverseasAddress
 *   coordinates?: string
 * }} OverseasSite
 *
 * @typedef {{
 *   accreditationNumber: string
 *   status: 'approved' | 'suspended' | 'cancelled'
 * }} Accreditation
 *
 * @typedef {Accreditation & {
 *   overseasSites: Record<string, AccreditedOverseasSite>
 * }} ExporterAccreditation
 *
 * @typedef {
 *   | { status: 'pending' }
 *   | { status: 'approved', approvedOn: string }
 * } AccreditedOverseasSite
 *
 * @typedef {{
 *   line1: string
 *   line2?: string
 *   town: string
 *   county?: string
 *   postcode: string
 * }} UkAddress
 *
 * @typedef {{
 *   line1: string
 *   line2?: string
 *   townOrCity: string
 *   stateOrRegion?: string
 *   postcode?: string
 *   country: string
 * }} OverseasAddress
 */
```

- **`status` is today's value on the timeline** (ADR-0051). The timeline and its events are not
  returned; nothing in either frontend reads them.
- **Every enumeration is open.** A client handles a value it does not know, so a new status or
  material is not a breaking change.
- **Dates are ISO 8601.** `validFrom` and `approvedOn` are dates, and `linkedAt` is a date-time.
- **The regulator is an object**, so it can gain attributes without breaking clients.
- **Registrations are keyed by registration number**, and the value does not repeat it.
- **Accreditations are keyed by scheme year** (`"2026"`), so there cannot be two for one year and
  the current one is `accreditations[currentYear]`. Its material, processing type, site and
  regulator are its registration's. Its `accreditationNumber` is the reference quoted in letters,
  so it is served as a field.
- **A reprocessor and an exporter are different shapes**, told apart by `wasteProcessingType`. Only
  a reprocessor has a `reprocessingType` and a `site`, and only an exporter has overseas sites.
- **Overseas sites are keyed by `orsId`**, the three-digit id used in summary logs, at both levels.
  The ORS id is unique within a registration. The store links a registration to a shared site
  record by its database id, which is a storage detail and is not served.
  - **The registration holds every site the exporter uses**, with its details resolved from the
    `overseas-sites` collection.
  - **An accreditation records, for each site accredited for its year, whether it is approved**, and
    the date if it is. An operator reapplies for sites each year, may add or drop them, and pays a
    fee per approved site, so the list is per year. 2027 lists come from the registration service
    with the 2027 accreditation. Every ORS id it lists is one its registration holds.
  - Until then, the accreditation lists every site on its registration, with the approval date
    stored on the site today.
- **`companyDetails` is flattened** to `name` and `tradingName`.
- **The Defra ID organisation is grouped on its own** within the link, apart from when and by whom
  the link was made.

Not returned, because no client needs them: the database `id` at every level, `statusHistory`,
accreditation `validFrom`/`validTo`,
`registration.accreditationId` (nesting replaces it), `glassRecyclingProcess` (ADR-0050),
accreditation `material`/`wasteProcessingType`/`site`/`submittedToRegulator`, the overseas site's
internal `overseasSiteId`, `createdAt` and `updatedAt`, `registration.orgName`
(the organisation's `name` replaces it), and all form, contact, permit, file upload, user and
PRN-issuance data. Those stay in the store for the backend's own use.

Auth: the `organisationRead` and `adminRead` scopes.

### Endpoints

Each sub-resource returns the matching part of the model, in the same shape, so a page fetches
only what it shows. Every response body is an object.

| Endpoint                                                        | Returns                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /organisations/{organisationNumber}`                       | `Organisation`                                              |
| `.../registrations`                                             | `{ registrations: Record<string, Registration> }`           |
| `.../registrations/{registrationNumber}`                        | `Registration`                                              |
| `.../registrations/{registrationNumber}/overseas-sites`         | `{ overseasSites: Record<string, OverseasSite> }`           |
| `.../registrations/{registrationNumber}/overseas-sites/{orsId}` | `OverseasSite`                                              |
| `.../registrations/{registrationNumber}/accreditations`         | `{ accreditations: Record<string, Accreditation> }`         |
| `.../registrations/{registrationNumber}/accreditations/{year}`  | `Accreditation`                                             |
| `.../accreditations/{year}/overseas-sites`                      | `{ overseasSites: Record<string, AccreditedOverseasSite> }` |
| `.../accreditations/{year}/overseas-sites/{orsId}`              | `AccreditedOverseasSite`                                    |

Each resource is addressed by the key its parent holds it under.

Where the store is looser than these types, the conversion from the store maps the record or drops
it, and logs what it dropped:

- a registration or accreditation without a number is not served;
- a site reference whose overseas site record no longer exists is dropped;
- an accredited site whose ORS id its registration does not hold is dropped.

### Existing endpoints

| Endpoint                                                                                  | Effect                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /v1/organisations/{id}`                                                              | Unchanged                                                                                      |
| `GET /v1/organisations`                                                                   | Unchanged                                                                                      |
| `PUT /v1/organisations/{id}`                                                              | Unchanged                                                                                      |
| `GET /v1/organisations/{id}/overview`                                                     | Unchanged, for unapproved records; operators move to `GET /organisations/{organisationNumber}` |
| `GET /v1/.../registrations`, `.../registrations/{id}`                                     | Unchanged, for unapproved records; operators move to the matching new endpoint                 |
| `GET /v1/.../accreditations`, `.../accreditations/{id}`                                   | Unchanged, for unapproved records; operators move to the matching new endpoint                 |
| `GET /v1/.../registrations/{id}/overseas-sites`, `.../accreditations/{id}/overseas-sites` | Unchanged. They carry interim sites for the registration service (ADR-0041)                    |

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

| Field                                                                                     | Read by                                                                                                                    |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                                                 | Optimistic locking on every write                                                                                          |
| `statusTimeline` (ADR-0051)                                                               | Current status and transition rules; the accreditation's is read at a date for row classification and monthly reports owed |
| `companiesHouseNumber`, `registeredAddress`, registration `site.address.region`/`country` | Public register                                                                                                            |
| `users`, contact details, `approvedPersons`, `prnIssuance.signatories`                    | Collating users for linking and Defra roles; report submission contact export                                              |
| `linkedDefraOrganisation.linkedBy.id`                                                     | Unlinking                                                                                                                  |
| `prnIssuance.tonnageBand`                                                                 | Public register, PRN tonnage, market insights                                                                              |

An accreditation's material, processing type, site and regulator — used for the PRN snapshot, the
PRN/PERN flag, the December pool and PRN numbering — are read from its registration, as they are
for the frontends. The registration–accreditation match rule already guarantees material,
processing type and site postcode agree; the regulator needs the same guarantee.

### Stored but unused

Written by forms ingest, but read by nothing in the backend, the frontend or the admin frontend,
other than the admin JSON editor and `GET /v1/organisations/{id}`, which pass the whole document
through.

| Level          | Fields                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Organisation   | `formSubmission`, `businessType`, `partnership`, `reprocessingNations`, `wasteProcessingTypes`, `managementContactDetails`, `schemaVersion` (only a write-side schema condition)                                                                                                     |
| Registration   | `formSubmission`, `validTo` (stripped on read), `yearlyMetrics`, `orsFileUploads`, `samplingInspectionPlanPart1FileUploads`, `cbduNumber`, `wasteManagementPermits`, `noticeAddress`, `exportPorts`, `plantEquipmentDetails`, `suppliers`, `site.gridReference`, `site.siteCapacity` |
| Accreditation  | `formSubmission`, `orgName`, `orsFileUploads`, `samplingInspectionPlanPart2FileUploads`, `prnIssuance.incomeBusinessPlan`                                                                                                                                                            |
| Status history | `updatedBy`: compared by the admin edit guard, but never set                                                                                                                                                                                                                         |

The registration fields from `cbduNumber` onwards and accreditation `orgName` are passed through
the `/v1` registration and accreditation sub-resources, but neither frontend reads them.

## Consequences

- One shape for every client of a granted organisation. The `/v1` routes stay for unapproved
  records and for clients the team cannot see; retiring them is a separate decision. The
  admin ORS list, a cross-organisation report, and the per-report export activity are not
  organisation reads and are unaffected.
- An unapproved registration or accreditation is an application awaiting a decision. Handling
  applications moves to another team by the end of 2026, after which this service holds only
  numbered records. The new routes already serve only those, so the handover leaves them
  unchanged and removes only the `/v1` reads of unapproved records.
- Existing consumers of `GET /v1/organisations/{id}` — the admin JSON editor and basic-auth
  clients — are unaffected.
- The frontends stop joining registrations to accreditations and stop deciding which accreditation
  is live; the reapply journey reads the accreditation's year rather than parsing it from
  `validFrom`, and date-range display uses the year.
- Approval is per accreditation year, but is stored today as a single `validFrom` on the shared site
  record. Per-year approval needs a storage change, expected with the registration service's data.
- The operator frontend still needs database ids to call the summary-log, report, PRN, waste
  balance and ledger routes. It goes on reading them from the `/v1` routes until those routes are
  addressed by domain keys.
- The new routes have response schemas, so their contract is enforced rather than implied by the
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
