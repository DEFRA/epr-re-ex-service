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

| Method | Path                                         | Description                                                                                                                                                                                                                                      |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/reports`                                   | List all reports — both persisted (from DB) and due (computed). Each item includes `year`, `period`, `startDate`, `endDate`, `status`, and `id` (null when due).                                                                                 |
| GET    | `/reports/{year}/{cadence}/{period}`         | Get a specific report object from the database. Returns the report metadata and status. 404 if no persisted report exists for this period.                                                                                                       |
| GET    | `/reports/{year}/{cadence}/{period}/details` | Get the aggregated report data for a period. Computes tonnage, supplier, destination, and PRN data from waste records and PRNs. Used to preview data before creating a report, or to view the stored snapshot after creation.                    |
| POST   | `/reports/{year}/{cadence}/{period}`         | Create a report for the given period. Generates the aggregated data (same as `/details`) and persists it in the database with status `in_progress`. Returns 201 with the created report. Returns 409 if a report already exists for this period. |
| DELETE | `/reports/{year}/{cadence}/{period}`         | Delete (soft-delete) a report. Sets status to `deleted`, archives `currentReportId` to `previousReportIds`, and clears the slot. The period reverts to "due" status on the list endpoint.                                                        |

### Changes from Current Implementation

The current API has two endpoints:

- `GET /reports` — returns `{ cadence, periods }` computed from waste records
- `GET /reports/{year}/{cadence}/{period}` — returns aggregated report detail (computed)

These are replaced by the five endpoints above. Key changes:

1. **`GET /reports`** now returns a merged list of due and persisted reports with status, not just computed periods
2. **`GET /reports/{year}/{cadence}/{period}`** now returns the persisted report object, not computed data
3. **`GET /reports/{year}/{cadence}/{period}/details`** takes over the role of the old detail endpoint (aggregated data)
4. **`POST /reports/{year}/{cadence}/{period}`** is new — creates a report and snapshots the aggregated data
5. **`DELETE /reports/{year}/{cadence}/{period}`** is new — soft-deletes a report

### List Endpoint Behaviour

The `GET /reports` endpoint merges two data sources:

1. **Computed periods** from `discoverPeriods()` — periods where waste records exist and the period has ended
2. **Persisted reports** from `reportsRepository.findPeriodicReports()` — periods with stored reports

Merge logic for each period:

- Period has waste records + no persisted report + period has ended = `{ status: 'due', id: null }`
- Period has a persisted report = `{ status: report.status, id: report.id }`
- Period has not ended yet = excluded from response

Response shape:

```json
{
  "cadence": "quarterly",
  "reports": [
    {
      "year": 2026,
      "period": 1,
      "startDate": "2026-01-01",
      "endDate": "2026-03-31",
      "status": "due",
      "id": null
    },
    {
      "year": 2026,
      "period": 2,
      "startDate": "2026-04-01",
      "endDate": "2026-06-30",
      "status": "in_progress",
      "id": "uuid-here"
    }
  ]
}
```

## Consequences

- The "due" concept is computed, not stored — there is no `due` status in the database. This avoids needing background jobs to create "due" records and keeps the source of truth in the waste records.
- Deleting a report returns the period to "due" status automatically (assuming waste records still exist and the period has ended).
- The `/details` endpoint can be called before or after report creation — before creation it computes live; after creation it could return the stored snapshot.
- Period filtering (only showing ended periods) means users cannot create reports for the current in-progress period.
