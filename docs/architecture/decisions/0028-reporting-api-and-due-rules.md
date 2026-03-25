# 28. Reporting API and Due Rules

Date: 2026-03-19

## Status

Proposed

## Context

Reprocessors and exporters must submit periodic reports to regulatory agencies. Accredited operators report monthly; registered-only operators report quarterly. The system needs clear rules for when a report is considered "due" and a well-defined API for managing the full report lifecycle.

The existing `discoverPeriods` function derives reporting periods from uploaded waste record dates. The `reports` and `periodic-reports` MongoDB collections (see [Regulatory Reporting Data Model](../discovery/reporting-data-model.md)) store persisted report data and track which periods have active reports.

## Decision

### Report "Due" Rules

A report is **due** for a given `(organisationId, registrationId, year, period)` when **both** conditions are met:

1. **One or more waste records exist** within that period (determined by the waste record date fields mapped via `DATE_FIELDS_BY_OPERATOR_CATEGORY`)
2. **No persisted report exists** in the `periodic-reports` collection for that slot (i.e. `currentReportId` is null or the slot does not exist)
3. **The current date is after the last day of the period** (e.g. a Q1 report is not due until after 31 March; a January monthly report is not due until after 31 January)

A report that has been created (status `in_progress`, `ready_to_submit`, or `submitted`) is no longer "due" — it has a persisted status instead.

Periods are shown to the user once their start date has been reached, including the current in-progress period. However, a report can only be **created** after the period has ended — the POST endpoint enforces this constraint.

### Reporting API Endpoints

The reports resource is scoped to a registration and addressed by year and period:

```
Base: /v1/organisations/{organisationId}/registrations/{registrationId}
```

| Method | Path                                 | Description                                                                                                                                                                                                                                |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/reports/calendar`                  | List reporting periods. Each item includes `year`, `period`, `startDate`, `endDate`, `dueDate`, and a `report` object (`{ status, id }` or `null` if no report exists).                                                                    |
| GET    | `/reports/{year}/{cadence}/{period}` | Get a report for a specific period. If a persisted report exists, returns the stored data. If no report exists, generates the aggregated data on the fly. Returns the same shape in both cases — the `reports` collection shape (see [Regulatory Reporting Data Model](../discovery/reporting-data-model.md)). When no stored report exists, report metadata fields (`id`, `version`, `status`, `statusHistory`) are absent. |
| POST   | `/reports/{year}/{cadence}/{period}` | Create a report for the given period. Generates the aggregated data and persists it in the database with status `in_progress`. Returns 201 with the full created report. Returns 409 if a report already exists for this period.                |
| DELETE | `/reports/{year}/{cadence}/{period}` | Delete (soft-delete) a report. Sets status to `deleted`, archives `currentReportId` to `previousReportIds`, and clears the slot. The period reverts to "due" status on the list endpoint.                                                  |

### Changes from Current Implementation

The current API has two endpoints:

- `GET /reports/calendar` — returns `{ cadence, periods }` computed from waste records
- `GET /reports/{year}/{cadence}/{period}` — returns aggregated report detail (computed)

These are replaced by the four endpoints above. Key changes:

1. **`GET /reports/calendar`** now returns `reportingPeriods` with optional nested `report` objects (including `dueDate`), not just computed periods
2. **`GET /reports/{year}/{cadence}/{period}`** now returns a stored report if one exists, or generates the aggregated data on the fly
3. **`POST /reports/{year}/{cadence}/{period}`** is new — creates a report and snapshots the aggregated data
4. **`DELETE /reports/{year}/{cadence}/{period}`** is new — soft-deletes a report

### Detail Endpoint Response Shape

The `GET /reports/{year}/{cadence}/{period}` and `POST /reports/{year}/{cadence}/{period}` endpoints return the `reports` collection document shape as the API contract. The API shape matches the database shape — no transformation layer exists between the two.

When a stored report exists, all fields are returned as persisted. When no stored report exists (computed on the fly), the response contains the same data structure with aggregated values from waste records. Report metadata fields (`id`, `version`, `status`, `statusHistory`) are absent in the computed case since no report has been created.

Manual entry fields (`tonnageRecycled`, `tonnageNotRecycled`, export activity manual fields) are `null` on a computed or newly created report — `null` means "not yet entered" as distinct from `0` which means "the operator entered zero".

The route handler appends `details: { material, site }` from the registration to both stored and computed responses.

See [Regulatory Reporting Data Model](../discovery/reporting-data-model.md) for the full `REPORTS` entity definition and the `ReportDetail` schema in the API definition for the complete field list.

### List Endpoint Behaviour

The `GET /reports/calendar` endpoint merges two data sources:

1. **Computed periods** from `generateReportingPeriods()` — periods whose start date has been reached (including the current in-progress period)
2. **Persisted reports** from `reportsRepository.findPeriodicReports()` — periods with stored reports

Merge logic for each period:

- Period has waste records + no persisted report + period has ended = reporting period with `report: null`
- Period has a persisted report = reporting period with `report: { status, id }`
- Period has not started yet = excluded from response

Response shape:

```json
{
  "cadence": "monthly",
  "reportingPeriods": [
    {
      "year": 2026,
      "period": 1,
      "startDate": "2026-01-01",
      "endDate": "2026-03-31",
      "dueDate": "2026-04-28",
      "report": {
        "status": "submitted",
        "id": "uuid-here"
      }
    },
    {
      "year": 2026,
      "period": 4,
      "startDate": "2026-04-01",
      "endDate": "2026-04-30",
      "dueDate": "2026-05-28",
      "report": null
    }
  ]
}
```

Note: the `cadence` reflects the operator's current reporting cadence (as accredited). Reporting periods may span different cadences historically — e.g. quarterly periods while registered-only, then monthly periods once accredited.

## Consequences

- The "due" concept is implicit — a reporting period with `report: null` is due. There is no `due` status in the database. This avoids needing background jobs to create "due" records and keeps the source of truth in the waste records.
- Deleting a report sets `report` back to `null` for the period, reverting it to due automatically (assuming waste records still exist and the period has ended).
- The single `GET /reports/{year}/{cadence}/{period}` endpoint serves both preview and retrieval — if no report exists it generates the aggregated data on the fly; if a report exists it returns the stored snapshot.
- The list endpoint shows periods once they have started (including the current in-progress period). The POST endpoint enforces that a period must have ended before a report can be created. This separation allows users to view aggregated data for the current period without being able to submit prematurely.
