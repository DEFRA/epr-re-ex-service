# 34. Multi-year accreditation model

Date: 2026-05-12

## Status

Accepted

Part 2 amendment (2026-10-01): Proposed. 2026 accreditations are also read over HTTP. See [Decision](#decision).

## Context

Operators apply for accreditation via DEFRA forms each year. The re-ex service currently stores accreditations as a
sub-document array on the organisation (`org.accreditations[]`), with each registration pointing to a single
accreditation via `registration.accreditationId`.

For 2027, the same registration will need both a 2026 accreditation (already in the local `epr-organisations` MongoDB
collection) and a new 2027 accreditation. The 2027 accreditations will be owned by a new registration service, not
submitted through the existing DEFRA forms → epr-backend pipeline.

### Accreditation sub-document fields used (`accreditations[]`)

| Field                                               | Used by (feature/file)                                                                                                                                  | Component                   | Purpose                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                | PRN creation, public register, PRN tonnage aggregation, fetch-registration-and-accreditation, admin overview                                            | backend, frontend, admin-ui | Sub-document identifier; used in accreditation API URL paths for PRN, summary-log, report and admin routes                                                                                                                                   |
| `status` / `statusHistory`                          | Public register; registration page and org dashboard; admin organisation-overview; PRN action guards                                                    | backend, frontend, admin-ui | Filter publishable accreditations; `status` displayed as govuk-tag in frontend and admin overview tables; guards PRN action availability in frontend; `statusHistory` queried by `isSuspendedAtDate()` for waste balance and PRN eligibility |
| `accreditationNumber`                               | Public register, summary-log-uploads report, PRN snapshot, accreditation rows, reports detail view, admin organisation-overview, admin PRN activity CSV | backend, frontend, admin-ui | Displayed in accreditation rows, summary-log and reports detail (frontend); admin organisation-overview table and PRN activity CSV download                                                                                                  |
| `validFrom` / `validTo`                             | Public register, PRN snapshot (derive accreditation year), waste balance date-range check, PRN eligibility check                                        | backend                     | Active date range; `validFrom` is the source for accreditation year on PRNs; both dates used by `isWithinAccreditationDateRange()` to validate waste balance entries and PRN issuance eligibility                                            |
| `material`                                          | PRN snapshot, PRN view, summary log waste balance, reports detail view, admin organisation-overview, admin PRN activity CSV                             | backend, frontend, admin-ui | Material category; transformed for display in PRN views and reports (frontend); shown in admin organisation-overview table and PRN activity CSV; used in backend for glass-specific logic and form-submission linking keys                   |
| `glassRecyclingProcess`                             | PRN snapshot, glass submission splitting                                                                                                                | backend                     | Glass sub-process; only populated when `material` is GLASS; first element used in PRN snapshot and deduplication key                                                                                                                         |
| `wasteProcessingType`                               | PRN creation (`isExport` flag), PRN/PERN display, admin PRN activity CSV, form-submission deduplication key                                             | backend, frontend, admin-ui | Sets `isExport` flag at PRN creation; determines PRN vs PERN label in frontend display; included in admin PRN activity CSV and form-submission deduplication key                                                                             |
| `submittedToRegulator`                              | PRN snapshot, admin PRN activity CSV                                                                                                                    | backend, admin-ui           | Agency for PRN snapshot; included in admin PRN activity CSV download                                                                                                                                                                         |
| `site.address`                                      | PRN snapshot, reports detail view, public register, summary-log-uploads report, admin organisation-overview                                             | backend, frontend, admin-ui | Reprocessing site address; snapshotted into PRN; displayed in reports detail (frontend) and admin organisation-overview table; formatted in public register and summary-log-uploads report                                                   |
| `prnIssuance.tonnageBand`                           | PRN tonnage aggregation (MongoDB `$lookup`), admin prn-tonnage route                                                                                    | backend, admin-ui           | Tonnage band display                                                                                                                                                                                                                         |
| `formSubmission.time`                               | Form submission linking                                                                                                                                 | backend                     | `selectLatestAccreditation()` sorts duplicates by submission timestamp to resolve the correct accreditation during form-data migration                                                                                                       |
| `reprocessingType`                                  | Summary-log upload validation, org overview display                                                                                                     | backend                     | Sub-type of reprocessing (e.g. INPUT); validated against summary log entries in `processing-type.js`; displayed in org overview as `"REPROCESSOR - <type>"`                                                                                  |
| `submitterContactDetails`,`prnIssuance.signatories` | Initial users list population                                                                                                                           | backend                     | Initial set of users who can link organisation                                                                                                                                                                                               |

Fields written by forms migration but **never read** by application logic: `orgName`,
`samplingInspectionPlanPart2FileUploads`, `orsFileUploads`, `prnIssuance.incomeBusinessPlan`

---

## Options

These two concerns are addressed separately:

1. **Multi-year model** — how to represent accreditations from multiple scheme years within `epr-organisations`
2. **2027 ingestion** — how to bring 2027 accreditations from the new registration service into epr-backend

The sections below cover each in turn.

---

### Part 1 — Multi-year data model

#### Current model

Accreditations are stored as a sub-document array on the organisation:

```
epr-organisations
└─ accreditations[]   ← one sub-doc per accreditation (currently all 2026)
     id, status, material, validFrom, validTo, …
```

Each registration holds a **single** forward pointer to its accreditation:

```
registration.accreditationId  →  org.accreditations[].id
```

This is a **1:1** relationship. For multi-year support it must become **1:N** — one registration,
one accreditation per scheme year. The options below describe how to re-model that link.

---

#### Option A — Back-reference: add `year` + `registrationId` to `epr-organisations.accreditations[]`

Each accreditation sub-doc gains two fields:

- `year: number` — the scheme year, set from the form-submission timestamp
- `registrationId: string` — back-reference to the owning registration

`registration.accreditationId` is removed. To list all accreditations for a registration, filter
`org.accreditations[]` where `registrationId == reg.id`. Adding a 2027 accreditation means pushing
a new sub-doc — no change to the registration document. Year-scope the duplicate-approval guard
(currently keyed on `wasteProcessingType + material + postcode`) to also include `year`.

Migration: back-populate `year` + `registrationId` on all 2026 accreditation sub-docs; remove
`accreditationId` from all registration documents.

**Pros:**

- Additive to the accreditation sub-doc; no structural change to the collection
- Year is explicit and directly queryable without date arithmetic
- Adding a future year requires only a new sub-doc push; registration document is untouched

**Cons:**

- Migration script required to back-populate both fields on 2026 data and remove the forward pointer
- All callers reading `registration.accreditationId` must be updated to query by `registrationId`

---

#### Option B — Forward map: replace `registration.accreditationId` with

`registration.accreditations: Map(year, accreditationId)`

`registration.accreditationId` (single string) is replaced with a year-keyed map:

```
registration.accreditations: { "2026": "<accId>", "2027": "<accId>", … }
```

Accreditation sub-documents are unchanged. To fetch a specific year's accreditation:
`reg.accreditations[year]` → ID → look up in `org.accreditations[]`. Duplicate-approval guard
becomes a map-key existence check on `reg.accreditations[year]`.

Migration: convert every `registration.accreditationId: "id"` to
`registration.accreditations: { "2026": "id" }`.

**Pros:**

- Accreditation sub-documents are untouched; their fields, indexes, and callers are unchanged
- O(1) year-scoped lookup from the registration document
- Year-scoping the duplicate-approval guard is a map-key existence check — no array scan

**Cons:**

- Migration required on all registration documents
- All callers reading `registration.accreditationId` must switch to `registration.accreditations[year]`
- Map key type (string vs number) must be standardised and enforced at write time

---

#### Option C — No schema change _(not viable for multi-year)_

Keep `epr-organisations.accreditations[]` and `registration.accreditationId` unchanged. Year
continues to be derived from `validFrom`.

`registration.accreditationId` is a single string field and cannot reference two accreditations
simultaneously. This option cannot support a registration holding both a 2026 and a 2027
accreditation, so it is listed for completeness only and is not a valid candidate.

---

### Part 2 — 2027 accreditation ingestion

The new registration service owns 2027 accreditations. Options A and B persist a local copy;
they share a common sync concern addressed first.

#### Sync mechanisms (Options A and B only)

Two ways to keep a local copy current:

- **SQS events** — registration service publishes domain events to SNS; epr-backend's existing
  SQS consumer (`src/server/queue-consumer/`) processes them. Fits the established pattern; no
  new inbound endpoint required.

- **Webhook** — registration service POSTs change notifications to `POST /internal/accreditations/notify`.
  Simpler for the registration service team; adds an inbound route on our side.

Both result in the same local store; the choice is an operational / team coordination decision
and can be deferred.

---

#### Option A — Persist in `epr-organisations.accreditations[]`

On sync event: write 2027 accreditation as a new sub-doc on the organisation document.
Reads use the existing organisations repository unchanged.

**Pros:** no new collection; read path is unchanged for all existing callers.
**Cons:** org document grows with each year; 2027 data co-located with mutable 2026 data —
the re-ex service must explicitly enforce read-only access for 2027 sub-docs. Options B and C
do not have this problem.

---

#### Option B — Persist in a new `epr-accreditations` collection

On sync event: write to a standalone collection indexed on `(registrationId, year)`.
The accreditations module queries it directly.

**Pros:** clean separation; org documents stay lean; 2027 data naturally isolated from
re-ex write paths — no read-only guard needed.
**Cons:** new collection to index and back up; read path changes for year-spanning queries.

---

#### Option C — On-demand fetch from registration service

No local copy. At read time, call the registration service REST API with `registrationId`.
2026 data continues to come from the local organisations repository.

**Pros:** no sync infrastructure; registration service is single source of truth for 2027;
2027 data never enters re-ex write paths.
**Cons:** latency on every 2027 read; runtime dependency (needs circuit breaker / fallback);
REST contract must be agreed before implementation.

---

### Cross-cutting design: accreditation module with port

Regardless of option, introduce `src/accreditations/` following the existing hexagonal pattern
(`src/*/port.js` + adapter plugins).

**The module can be implemented now, before 2027 data is available.** The initial adapter
wraps existing 2026 lookups only. When the registration service is ready, the adapter is
extended or swapped without touching any application code.

#### Accreditation type

Derived from `src/domain/organisations/accreditation.js`, extended with `registrationId` and `year`:

```js
/**
 * @typedef {{
 *   id: string;
 *   registrationId: string;
 *   year: number;
 *   status: 'created' | 'approved' | 'suspended' | 'rejected' | 'cancelled';
 *   statusHistory: { status: string; updatedAt: string }[];
 *   material: string;
 *   wasteProcessingType: string;
 *   submittedToRegulator: string;
 *   accreditationNumber?: string;
 *   validFrom?: string;
 *   validTo?: string;
 *   site?: { address: { line1: string; postcode: string } };
 *   prnIssuance: { tonnageBand: string; signatories: User[] };
 * }} Accreditation
 */
```

#### Port

```js
// src/accreditations/port.js

/** @param {string} registrationId  @param {number} [year]  @returns {Promise<Accreditation[]>} */
findByRegistrationId: (registrationId, year
?
) =>
Promise < Accreditation[] >

/** @param {number} [year]  @returns {Promise<Accreditation[]>} */
findAll
:
(year
?
) =>
Promise < Accreditation[] >
```

#### Adapter phases

- **Phase 1 (now)** — reads 2026 data only from local organisations repository. Ships before
  the registration service is ready.
- **Phase 2 (Option C)** — reads every year over HTTP: 2026 from epr-backend, 2027 from the
  registration service (see the Part 2 amendment under Decision).
- **Phase 3 (optional)** — if live-call latency is unacceptable, switch to an Option A or B
  adapter backed by a locally synced store. Port interface unchanged throughout.

---

## Decision

**Part 1:** Option A — add `registrationId` + `year` to `org.accreditations[]`; migration is
optional. 2026 sub-docs and registration documents remain untouched: the Phase 1 adapter resolves
2026 accreditations via the existing `registration.accreditationId` link.

**Part 2:** Option C — on-demand fetch from the registration service for 2027. ~~Local read for 2026.~~

**Part 2 amendment (2026-10-01, proposed):** 2026 accreditations are also read over HTTP, not
from the organisation documents. epr-backend serves 2026 accreditations from an endpoint with
the same contract the registration service will serve for 2027. REEX then reads every year
the same way, and the registration service can take over 2026 later without changing REEX.

Reason: on 21 September 2026 the REEX and registration service teams agreed that the
registration service owns accreditation data and REEX reads it when it needs it. Reading 2026
the same way means REEX has one read path instead of two, and finds the problems with that
path now, using live 2026 data, instead of when 2027 goes live. The
[PAE-1965](https://eaflood.atlassian.net/browse/PAE-1965) proof of concept showed that this
works and measured what it costs (see Consequences).

**Rationale.** This is the lowest-risk delivery path. Adding `registrationId` and `year` to the
existing accreditation sub-docs (back-reference) keeps 2026 data untouched, makes migration
optional. Fetching 2027 accreditations on demand from the registration service avoids a new collection
and all sync infrastructure while its API stabilises, keeping it the single source of truth for 2027 data. The
accreditations module ships immediately with 2026-only reads and is extended in Phase 2 when the API contract is agreed;
if live-call latency proves problematic, the adapter can be swapped for a locally synced store
without touching application code.

## Consequences

### Performance (Part 2 amendment)

The PAE-1965 proof of concept read 2026 accreditations over HTTP on the perf-test and test
environments. The results:

- **About +28ms for each organisation read.** Endpoints that don't read an organisation did not
  change, so the slowdown comes from the HTTP call.
- **No noticeable change for operators.** Operator pages, and most regulator pages, show one
  registration at a time.
- **Frontend pages are +100 to +250ms slower,** because each page reads the organisation
  several times.
- **Admin pages that list many organisations are two to five times slower:**

  | Page                                    | Before    | After |
  | --------------------------------------- | --------- | ----- |
  | Organisations list                      | 200–450ms | 1–2s  |
  | Summary log uploads                     | ~450ms    | ~2.5s |
  | PRN tonnage                             | 0.8–1.2s  | ~2.7s |
  | Overseas sites                          | ~1s       | ~2.5s |
  | Public register (download)              | 2.6s      | ~6s   |
  | Regulator: reprocessor/exporter figures | ~4s       | ~6.5s |

- **Slow reports barely change.** The 22–35s reports (credited tonnage, UK waste balance,
  market insights workbook) are slow for other reasons.
- **These numbers are the best case.** The proof of concept called epr-backend, the same
  service and database. Calls to the registration service go to another service and its own
  database, so they will be slower. Run the performance tests again against the registration
  service before 2027 goes live.

What this means:

- Admin pages that list many organisations need fewer, larger requests (a batch endpoint), and
  shouldn't fetch accreditations they don't use.
- Frontend pages need fewer organisation reads per request, or to cache accreditations for the
  length of a request.
- If latency is still too high after that, Phase 3 (a locally synced store) is the fallback.
  Because a synced copy can fall out of date, using it needs a new ADR.

### Other consequences

- **Each service needs the other running.** REEX calls the registration service for
  accreditations, and the registration service calls REEX for organisations. If either is down,
  both are affected. The HTTP client needs timeouts, retries and a circuit breaker.
- **Some reads can't go through an HTTP lookup.** These need reworking before 2026 can be
  served entirely over HTTP:
  - searching by accreditation id or number
  - aggregations that join on accreditation fields
  - checks when an organisation is saved
- **Existing mechanisms for changing accreditation cannot be re-used for 2027.** Status change functionality and the JSON editor (in Admin UI) cannot be used as-is for editing 2027 accreditation data (as the REEX service has a read-only view of it).
