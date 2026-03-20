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

Reports for periods that have not yet ended are not shown to the user.

### Reporting API Endpoints

The reports resource is scoped to a registration and addressed by year and period:

```
Base: /v1/organisations/{organisationId}/registrations/{registrationId}
```

| Method | Path                                 | Description                                                                                                                                                                                                                                |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/reports`                           | List reporting periods with optional nested report. Each item includes `year`, `period`, `startDate`, `endDate`, `dueDate`, and an optional `report` object (`{ status, id }`).                                                            |
| GET    | `/reports/{year}/{cadence}/{period}` | Get a report for a specific period. If a persisted report exists, returns the stored data. If no report exists, generates the aggregated data (tonnage, supplier, destination, PRN data) on the fly. Returns the same shape in both cases. |
| POST   | `/reports/{year}/{cadence}/{period}` | Create a report for the given period. Generates the aggregated data and persists it in the database with status `in_progress`. Returns 201 with the created report. Returns 409 if a report already exists for this period.                |
| DELETE | `/reports/{year}/{cadence}/{period}` | Delete (soft-delete) a report. Sets status to `deleted`, archives `currentReportId` to `previousReportIds`, and clears the slot. The period reverts to "due" status on the list endpoint.                                                  |

### Changes from Current Implementation

The current API has two endpoints:

- `GET /reports` — returns `{ cadence, periods }` computed from waste records
- `GET /reports/{year}/{cadence}/{period}` — returns aggregated report detail (computed)

These are replaced by the four endpoints above. Key changes:

1. **`GET /reports`** now returns `reportingPeriods` with optional nested `report` objects (including `dueDate`), not just computed periods
2. **`GET /reports/{year}/{cadence}/{period}`** now serves dual purpose — returns a stored report if one exists, or generates the aggregated data on the fly. This replaces both the old period endpoint and the `/details` endpoint
3. **`POST /reports/{year}/{cadence}/{period}`** is new — creates a report and snapshots the aggregated data
4. **`DELETE /reports/{year}/{cadence}/{period}`** is new — soft-deletes a report

### List Endpoint Behaviour

The `GET /reports` endpoint merges two data sources:

1. **Computed periods** from `discoverPeriods()` — periods where waste records exist and the period has ended
2. **Persisted reports** from `reportsRepository.findPeriodicReports()` — periods with stored reports

Merge logic for each period:

- Period has waste records + no persisted report + period has ended = reporting period with no `report` field
- Period has a persisted report = reporting period with `report: { status, id }`
- Period has not ended yet = excluded from response

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
      "dueDate": "2026-05-28"
    }
  ]
}
```

Note: the `cadence` reflects the operator's current reporting cadence (as accredited). Reporting periods may span different cadences historically — e.g. quarterly periods while registered-only, then monthly periods once accredited.

## Consequences

- The "due" concept is implicit — a reporting period without a `report` object is due. There is no `due` status in the database. This avoids needing background jobs to create "due" records and keeps the source of truth in the waste records.
- Deleting a report removes the `report` object from the period, reverting it to due automatically (assuming waste records still exist and the period has ended).
- The single `GET /reports/{year}/{cadence}/{period}` endpoint serves both preview and retrieval — if no report exists it generates the aggregated data on the fly; if a report exists it returns the stored snapshot. This simplifies the API surface by removing the separate `/details` endpoint.
- Period filtering (only showing ended periods) means users cannot create reports for the current in-progress period.
