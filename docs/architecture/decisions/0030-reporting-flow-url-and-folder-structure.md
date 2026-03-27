# 30. URL and Folder Structure for the Four Reporting Flows

Date: 2026-03-27

## Status

Proposed

## Context

The reporting journey serves four distinct user types based on organisation category (exporter vs reprocessor) and accreditation status (accredited vs registered-only):

| Flow | Org type    | Accreditation   | Cadence   | `{cadence}` URL segment |
| ---- | ----------- | --------------- | --------- | ----------------------- |
| 1    | Exporter    | Accredited      | Monthly   | `monthly`               |
| 2    | Exporter    | Registered-only | Quarterly | `quarterly`             |
| 3    | Reprocessor | Accredited      | Monthly   | `monthly`               |
| 4    | Reprocessor | Registered-only | Quarterly | `quarterly`             |

The existing URL structure already encodes the cadence distinction:

```
/organisations/{organisationId}/registrations/{registrationId}/reports/{year}/{cadence}/{period}
```

The exporter/reprocessor distinction is implicit — it is derived at runtime from the registration data for `registrationId`. It does not appear in the URL.

The four flows share the same base pages (list, detail, CYA, created, submitted, delete) but diverge in the additional data-entry pages inserted between the "agree to proceed" action and the check-your-answers page. These pages were confirmed from the Figma designs (see `jira/Exporter accredited.pdf`, `jira/Exporter registered only.pdf`, `jira/Reprocessor accredited.pdf`, `jira/Reprocessor registered only.pdf`).

## Decision

### URL structure

The base path remains unchanged. No additional URL segment for org type is needed — the `registrationId` already uniquely identifies which flow applies.

`{base}` = `/organisations/{organisationId}/registrations/{registrationId}/reports/{year}/{cadence}/{period}`

**Pages shared by all four flows:**

| Method   | Path                            | Page                                                       |
| -------- | ------------------------------- | ---------------------------------------------------------- |
| GET      | `{base}`                        | Report detail — summary log data / "agree to proceed" view |
| POST     | `{base}`                        | Create in-progress report                                  |
| GET/POST | `{base}/supporting-information` | Supporting information question (optional)                 |
| GET/POST | `{base}/check-your-answers`     | Check your answers                                         |
| GET      | `{base}/created`                | Confirmation — report is ready to submit                   |
| GET      | `{base}/submitted`              | Submitted confirmation                                     |
| GET/POST | `{base}/delete`                 | Delete report                                              |

**Reprocessor only (both cadences):**

| Method   | Path                         | Page                                                         |
| -------- | ---------------------------- | ------------------------------------------------------------ |
| GET/POST | `{base}/tonnes-recycled`     | How many tonnes did you recycle in [period]?                 |
| GET/POST | `{base}/tonnes-not-recycled` | How many tonnes did you receive but not recycle in [period]? |

**Accredited only (both org types, `{cadence}` = `monthly`):**

| Method   | Path                 | Page                                                                            |
| -------- | -------------------- | ------------------------------------------------------------------------------- |
| GET/POST | `{base}/prn-summary` | PRN/PERN summary — displays read-only tonnage issued; user enters total revenue |
| GET/POST | `{base}/free-prns`   | Reprocessor: free PRNs tonnage                                                  |
| GET/POST | `{base}/free-perns`  | Exporter: free PERNs tonnage                                                    |

Note: reprocessors and exporters issue different instruments (PRNs vs PERNs). The `prn-summary` path is shared; the free-tonnage page differs (`free-prns` vs `free-perns`).

### Page sequence per flow

**Flow 1 — Exporter accredited (monthly):**

```
detail
  → [Use this data]
  → prn-summary
  → free-perns
  → supporting-information
  → check-your-answers
  → created
  → [Review and submit]
  → submitted
```

**Flow 2 — Exporter registered-only (quarterly):**

```
detail
  → [Use this data]
  → supporting-information
  → check-your-answers
  → created
  → [Review and submit]
  → submitted
```

**Flow 3 — Reprocessor accredited (monthly):**

```
detail
  → [Use this data]
  → tonnes-recycled
  → tonnes-not-recycled
  → prn-summary
  → free-prns
  → supporting-information
  → check-your-answers
  → created
  → [Review and submit]
  → submitted
```

**Flow 4 — Reprocessor registered-only (quarterly):**

```
detail
  → [Use this data]
  → tonnes-recycled
  → tonnes-not-recycled
  → supporting-information
  → check-your-answers
  → created
  → [Review and submit]
  → submitted
```

### Folder structure

Flow-specific controllers live in `exporter/` and `reprocessor/` sub-directories within `src/server/reports/`:

```
src/server/reports/
  index.js                                      ← route registration for all flows
  constants.js
  en.json
  helpers/
    build-table-rows.js
    create-report.js
    delete-report.js
    derive-submission-status.js
    fetch-report-detail.js
    fetch-reporting-periods.js
    format-period-label.js
    format-submission-status.js
    is-session-match.js
    period-params-schema.js
    update-report-status.js
    update-report.js
    versioned-payload-schema.js
  exporter/
    prn-summary-controller.js
    prn-summary.njk
    free-perns-controller.js
    free-perns.njk
  reprocessor/
    tonnes-recycled-controller.js
    tonnes-recycled.njk
    tonnes-not-recycled-controller.js
    tonnes-not-recycled.njk
    prn-summary-controller.js
    prn-summary.njk
    free-prns-controller.js
    free-prns.njk
  check-controller.js
  check-your-answers.njk
  confirm-delete.njk
  create-controller.js
  created-controller.js
  created.njk
  delete-controller.js
  detail-controller.js
  detail.njk
  list-controller.js
  list.njk
  submitted-controller.js
  submitted.njk
  supporting-information-controller.js
  supporting-information.njk
```

Note: `prn-summary` exists in both `exporter/` and `reprocessor/` because the page content differs — exporter shows PERNs issued and asks for PERN revenue; reprocessor shows PRNs issued and asks for PRN revenue.

### Backend report data type — user-entered fields per flow

The `REPORTS` entity (see `reporting-data-model.md`) already defines all fields. The table below records which fields require user entry during the creation flow, which flow(s) they apply to, and their PATCH key.

| Field                                  | User-entered on            | Applies to                    | PATCH key                                                     |
| -------------------------------------- | -------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `recyclingActivity.tonnageRecycled`    | `tonnes-recycled`          | Reprocessors (flows 3 & 4)    | `tonnageRecycled`                                             |
| `recyclingActivity.tonnageNotRecycled` | `tonnes-not-recycled`      | Reprocessors (flows 3 & 4)    | `tonnageNotRecycled`                                          |
| `prnData.totalRevenue`                 | `prn-summary`              | Accredited only (flows 1 & 3) | `prnRevenue`                                                  |
| `prnData.freeTonnage`                  | `free-perns` / `free-prns` | Accredited only (flows 1 & 3) | `freePernTonnage` (exporter) / `freePrnTonnage` (reprocessor) |
| `supportingInformation`                | `supporting-information`   | All four flows                | `supportingInformation`                                       |

All other `REPORTS` fields (`recyclingActivity.totalTonnageReceived`, `recyclingActivity.suppliers`, `exportActivity.*`, `wasteSent.*`, `prnData.tonnageIssued`) are system-derived at report creation from summary log and PRN/PERN issuance data — they do not require dedicated entry pages. This was confirmed by the Figma designs: the registered-only flows proceed directly from the detail/agree-to-proceed page (which displays all system-derived data) to `supporting-information` without any intermediate data-entry steps.

The `prnData.averagePricePerTonne` field is backend-computed on every PATCH.

### Check-your-answers page — conditional sections

The CYA page renders sections conditionally based on flow:

| Section                                              | Shown for                      |
| ---------------------------------------------------- | ------------------------------ |
| Summary log data                                     | All flows                      |
| Recycling activity (tonnage recycled / not recycled) | Reprocessors (flows 3 & 4)     |
| PRN/PERN summary (revenue, free tonnage, avg price)  | Accredited flows (flows 1 & 3) |
| Supporting information                               | All flows                      |

## Consequences

- The `{cadence}` URL segment (`monthly` / `quarterly`) is the sole flow discriminator in the URL. The org type (exporter/reprocessor) is determined at runtime from the registration, not the URL.
- Route guards must validate that flow-specific pages are only accessible for the correct combination of org type and cadence. A reprocessor requesting `/prn-summary` without `monthly` cadence, or an exporter requesting `/tonnes-recycled`, should be redirected to the reports list.
- The `reprocessor/prn-summary` and `exporter/prn-summary` controllers share the same URL path (`{base}/prn-summary`) but serve different content — the route handler dispatches to the correct controller based on registration type.
- Similarly, `{base}/free-prns` and `{base}/free-perns` are separate paths — the navigation chain ensures only the correct one is reachable for a given registration.
