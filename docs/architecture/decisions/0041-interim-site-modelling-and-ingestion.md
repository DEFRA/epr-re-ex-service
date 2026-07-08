# 41. Interim Site modelling and ingestion

Date: 2026-07-07

## Status

Proposed

## Context

Exporters may route waste through an **Interim Site** before it reaches the final Overseas Reprocessing Site
(ORS). ORS reference data reaches the service as a workbook the regulator uploads via the Admin UI:
operators/exporters declare their sites at registration and accreditation, the regulator reviews and enriches
that data (notably adding the `validFrom` approval date), and the regulator-supplied version is what actually
gets imported. Interim Site data follows the same lifecycle, and the workbook already has an `Interim Sites`
table alongside the existing `OSRs` table, as a second tab in the same file, with each row linking one
interim site to one ORS.

The Summary Log already has an `INTERIM_SITE_ID` column, format-validated as a three-digit ID the same way
`OSR_ID` is, but not yet checked against any reference data. Three things are needed:

1. Model and store Interim Site reference data, linked to the ORS it serves.
2. Ingest Interim Site data through the Admin UI, alongside the existing ORS import.
3. Validate `INTERIM_SITE_ID` on Summary Log upload against the correct ORS's interim sites, and surface
   interim-site data through the existing overseas-sites API.

Validation failure must not block the Summary Log upload. The operator is warned and the affected row is
excluded from the waste balance — the same treatment the existing `OSR_ID` check already gives an
unrecognised or unapproved ORS.

The existing ORS design (`docs/architecture/discovery/ors-management.md`) is the direct precedent for all
three: an `overseas-sites` collection, spreadsheet import via the existing upload pipeline, a natural
ID-to-record map, and scope-gated read/write APIs. This ADR decides how far to extend that design for
Interim Site, and where its relationships genuinely differ.

## Decision

### 1. Data model

**Interim Site records are linked to the ORS they serve, not to a registration.** The workbook associates
each interim site with exactly one ORS per row (the same interim site can appear on multiple rows if it
serves multiple ORSs), so that's the relationship modelled. Keying interim sites off the registration instead
— mirroring `overseasSites` — was considered and rejected: the source data never links an interim site to a
registration directly, and Summary Log validation itself checks the interim site against the ORS given on
the same row (Column Z), not against anything registration-scoped.

Interim Site is a new reference-data collection, structurally similar to `overseas-sites` (same address
shape: line 1 required, line 2 optional, city/town required, state/region and postcode optional; plus name
and country). Each Interim Site record is linked from the **overseas-sites side** — an ORS record carries a
map of the interim site IDs that serve it, mirroring the three-digit-ID-to-record-ID pattern already used
between registrations and ORS records, one level down.

**Module placement: a second repository inside the existing `overseas-sites` module, not a new top-level
module.** An Interim Site is always linked to, and only ever reached through, an ORS — same workbook, same
upload, same domain concern, no independent use case today.  Splitting it out later, if an
independent use case emerges, is a low-cost move since the repository-port boundary is already in place.

### 2. Admin UI

- **Ingestion**: the regulator-supplied workbook already contains both `OSRs` and `Interim Sites` as separate
  tabs in one file. The existing upload flow (single workbook upload, async processing, per-file progress and
  results) is extended to read both tables from that one file, with a second tab on the upload page for
  Interim Sites — one upload, one place to track both.
- **Errors during import**: each entry in the existing per-file `errors[]` array gains a `sheet` field to
  identify which table a row error belongs to, e.g. `{ "sheet": "Interim Sites", "row": 6, "field":
  "finalOverseasReprocessingSite", "message": "ORS ID '042' not found in this file" }` — no new reporting
  mechanism.
- **Search and view**: the "Overseas reprocessing sites" search page gains one new column listing the
  three-digit Interim Site IDs linked to that ORS directly in the cell (e.g. `101, 102`, or "-"), rather than
  a count or a link to a separate detail page. This keeps the table's one-row-per-mapping shape intact — no
  row-multiplication, no accordion or expand-in-place, both of which are unprecedented in this admin
  frontend and unnecessary once the IDs fit inline. Full interim-site detail shown inline is a follow-up UI
  decision; this ADR only fixes that the IDs are visible on the ORS row.
- **CSV download**: the admin page offers two separate downloads — the existing ORS CSV, unchanged, and a new
  Interim Sites CSV, one row per (ORS, linked interim site) pairing, with interim site fields (ID, name,
  country, address) plus enough ORS-identifying fields (ORS ID, org ID, registration number) to
  cross-reference the two files. A single merged CSV was rejected: interim sites are a variable-cardinality
  child of an ORS, and a fixed-width row can't represent an unbounded N per row without an unstable header.

### 3. Interim Site ID validation and waste balance inclusion/exclusion on Summary Log upload

The check only fires when `DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE == Yes`; otherwise `INTERIM_SITE_ID` is
ignored beyond its existing three-digit format check. When it does fire, the row's `OSR_ID` is resolved first
(as today), then `INTERIM_SITE_ID` is checked against the interim sites linked to *that* ORS — never against
a registration-wide or global list.

Validation reuses the existing exclusion mechanism: a failed check excludes the row from the waste balance
and warns the operator, but the upload still succeeds — the same warning-and-exclude behaviour `OSR_ID`
failures already get, not a separate side channel.

The failure condition is distinct from the existing `OSR_ID` failures — the ORS itself may be valid and
approved, but the given `INTERIM_SITE_ID` isn't one of the interim sites recorded against it — so it gets its
own exclusion reason code, `INTERIM_SITE_NOT_FOUND`. Unlike an ORS, an interim site carries no
`validFrom`/approval-date concept of its own — it's simply linked to an ORS or it isn't — so there's no
interim-site equivalent of `ORS_NOT_APPROVED`; one reason code covers the one failure condition.

### 4. Surfacing interim site data through the overseas-sites endpoints

**New CRUD endpoints for Interim Site** (`GET/POST/PUT/DELETE /v1/interim-sites`, `GET
/v1/interim-sites/{id}`), mirroring the existing `overseas-sites` CRUD pattern and scopes — needed regardless,
so a regulator can manage an interim site record without going through a specific ORS.

**All existing `overseas-sites` read endpoints are extended to include linked interim sites**, rather than
adding parallel interim-site-specific routes: `GET /v1/overseas-sites`, `GET /v1/overseas-sites/{id}`, and the
accreditation-scoped `.../accreditations/{accreditationId}/overseas-sites` (`accreditation-list.js`). The
last of these is used for external consumption by the registration service — the same consumer ADR 0035
added Basic Auth for on `GET /v1/organisations` — and already supports both `access-token` and Basic Auth, so
it's the natural place to give that consumer interim site detail too.

A separate `.../accreditations/{accreditationId}/interim-sites` endpoint was considered and rejected: an
interim site is never meaningful on its own in this model, only in relation to an ORS, so a consumer asking
"what sites does this accreditation cover" is already asking a question interim sites are part of the answer
to. A second route would duplicate the resolution work and need to stay in step with the first, for no
benefit unless a consumer wants interim sites without the ORS lookup — nothing here needs that.

Concretely, `resolveOverseasSites` in `accreditation-list.js` returns a map keyed by three-digit ORS ID, each
entry resolved to full ORS detail. Each entry gains one field, `interimSites` — a map keyed by three-digit
interim site ID, resolved to interim site detail:

```json
{
  "099": {
    "name": "...", "country": "...", "address": { "...": "..." },
    "coordinates": "...", "validFrom": "2026-01-01",
    "interimSites": {
      "101": { "name": "...", "country": "...", "address": { "...": "..." } }
    }
  }
}
```

An ORS with no linked interim sites returns `interimSites: {}`, matching how the outer map already behaves
for an accreditation with no ORSs — no null/absent-field case for consumers to handle, and no route change or
versioning needed since the field is purely additive. `GET /v1/overseas-sites/{id}` gains the equivalent
field on the raw ORS document, resolved the same way.

## Consequences

- Reuses the existing ORS reference-data model, workbook ingestion pipeline, and read API shape — an
  extension of an established pattern, not a new one.
- Interim Site validity is scoped to the ORS it's linked to, not to a registration — the same interim site ID
  can mean different things under different ORSs.
- Validation reuses the existing warn-and-exclude behaviour used for ORS checks — no new mechanism for how
  Summary Log validation failures are communicated.
- The admin search table gains one column and the CSV export becomes two files; both existing shapes
  (one-row-per-mapping table and CSV) stay unchanged — interim site data is additive, not a restructure.
  Import error reporting needs to distinguish ORS-row failures from Interim-Site-row failures, since one
  upload can now produce both.
- The registration service (and any other external consumer of `.../accreditations/{id}/overseas-sites`)
  gets interim site data as an additive field on a response it already integrates with, at the cost of that
  endpoint doing a two-hop resolution (accreditation → ORS → interim sites) instead of one.
- Detailed column layout, parser specifics, and UI wireframes are follow-up work — this ADR fixes the model
  and integration points, not implementation detail.
