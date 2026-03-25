# PAE-1235: Response Shape Alignment (C1 + D5)

**Date:** 2026-03-24
**Status:** Draft
**Review ref:** `docs/plans/1235-pr-review.md` items C1, D5

---

## Problem

The report detail endpoint returns two incompatible response shapes depending on whether a stored report exists:

- **Stored report** — DB shape: `recyclingActivity`, `exportActivity`, `wasteSent`
- **Computed report** — sections shape: `sections.wasteReceived`, `sections.wasteExported`, `sections.wasteSentOn`

Additionally, `createReport` returns only an ID, forcing a read-back query to get the full object (D5).

## Decision

- The DB shape is the canonical shape. The API returns exactly what is in the DB.
- `aggregateReportDetail` is changed to return the DB shape directly — no intermediate mapper.
- `createReport` returns the full report object, matching the PRN `create()` pattern.
- The frontend controller maps from the API shape to what the template needs (as it already does for the sections shape).
- No mapper between API and DB for now. The design supports adding one later if the two diverge.

## Scope

### Step 1 — ADR and API definition

Update ADR 0028 to document the DB shape as the API contract. Flesh out the `ReportDetail` definition in `internal-api.yaml` with the full structure:

```yaml
ReportDetail:
  type: object
  description: Report detail — stored or computed
  properties:
    id:
      type: string
      description: Present only when a stored report exists
    version:
      type: integer
    status:
      type: string
      enum: [in_progress, ready_to_submit, submitted, superseded, deleted]
    statusHistory:
      type: array
      items:
        type: object
        properties:
          status: { type: string }
          changedBy:
            type: object
            properties:
              id: { type: string }
              name: { type: string }
              position: { type: string }
          changedAt: { type: string, format: date-time }
    material: { type: string }
    wasteProcessingType: { type: string }
    siteAddress: { type: string }
    recyclingActivity:
      type: object
      properties:
        suppliers:
          type: array
          items:
            type: object
            properties:
              supplierName: { type: string }
              facilityType: { type: string }
              address: { type: string }
              phone: { type: string }
              email: { type: string }
              tonnageReceived: { type: number }
        totalTonnageReceived: { type: number }
        tonnageRecycled: { type: number, nullable: true }
        tonnageNotRecycled: { type: number, nullable: true }
    exportActivity:
      type: object
      description: Present only for exporters
      properties:
        overseasSites:
          type: array
          items:
            type: object
            properties:
              siteName: { type: string }
              orsId: { type: string }
              tonnageExported: { type: number }
        totalTonnageReceivedForExporting: { type: number }
        tonnageReceivedNotExported: { type: number, nullable: true }
        tonnageRefusedAtRecepientDestination: { type: number, nullable: true }
        tonnageStoppedDuringExport: { type: number, nullable: true }
        tonnageRepatriated: { type: number, nullable: true }
    wasteSent:
      type: object
      properties:
        tonnageSentToReprocessor: { type: number }
        tonnageSentToExporter: { type: number }
        tonnageSentToAnotherSite: { type: number }
        finalDestinations:
          type: array
          items:
            type: object
            properties:
              recipientName: { type: string }
              facilityType: { type: string }
              address: { type: string }
              phone: { type: string }
              email: { type: string }
              tonnageSentOn: { type: number }
    prnData:
      type: object
      properties:
        tonnageIssued: { type: number }
        totalRevenue: { type: number }
        averagePricePerTonne: { type: number }
    supportingInformation: { type: string }
    details:
      type: object
      description: Registration details appended by the route handler
      properties:
        material: { type: string }
        site: { type: object }
```

Manual entry fields (`tonnageRecycled`, `tonnageNotRecycled`, etc.) should be `null` when not yet entered, not `0`. This also addresses review item C5.

### Step 2 — JSDoc types (backend)

Add types to `repository/port.js` (or a dedicated domain types file):

- `Supplier` — `{ supplierName, facilityType, address, phone, email, tonnageReceived }`
- `OverseasSite` — `{ siteName, orsId, tonnageExported }`
- `FinalDestination` — `{ recipientName, facilityType, address, phone, email, tonnageSentOn }`
- `RecyclingActivity` — `{ suppliers, totalTonnageReceived, tonnageRecycled, tonnageNotRecycled }`
- `ExportActivity` — `{ overseasSites, totalTonnageReceivedForExporting, tonnageReceivedNotExported, tonnageRefusedAtRecepientDestination, tonnageStoppedDuringExport, tonnageRepatriated }`
- `WasteSent` — `{ tonnageSentToReprocessor, tonnageSentToExporter, tonnageSentToAnotherSite, finalDestinations }`
- `PrnData` — `{ tonnageIssued, totalRevenue, averagePricePerTonne }`
- `StatusHistoryEntry` — `{ status, changedBy, changedAt }`
- `Report` — full report type referencing the above

### Step 3 — `aggregateReportDetail` returns DB shape

Change `aggregate-report-detail.js` to return:

```js
{
  recyclingActivity: {
    suppliers: [{ supplierName, tonnageReceived }],
    totalTonnageReceived,
    tonnageRecycled: null,
    tonnageNotRecycled: null
  },
  exportActivity: {                          // optional
    overseasSites: [{ siteName, orsId }],
    totalTonnageReceivedForExporting,
    tonnageReceivedNotExported: null,
    tonnageRefusedAtRecepientDestination: null,
    tonnageStoppedDuringExport: null,
    tonnageRepatriated: null
  },
  wasteSent: {
    tonnageSentToReprocessor,
    tonnageSentToExporter,
    tonnageSentToAnotherSite,
    finalDestinations: [{ recipientName, tonnageSentOn }]
  }
}
```

Manual entry fields initialised to `null` (not `0`).

The function also continues to return context fields (`operatorCategory`, `cadence`, `year`, `period`, `startDate`, `endDate`, `lastUploadedAt`) which the route handler uses.

Update all `aggregate-report-detail.test.js` assertions.

### Step 4 — `createReport` returns full object (D5)

In `repository/mongodb.js`, change `performCreateReport` to return the full `reportDoc` after `insertOne` instead of just the `reportId`. Update the port type from `Promise<string>` to `Promise<Report>`.

### Step 5 — Route handler cleanup

**`post.js`:**

- Delete `buildReportData` — no longer needed; `aggregateReportDetail` already returns the DB shape.
- Pass aggregated fields directly to `createReport`.
- Use the returned report object directly — no `findReportById` read-back.

**`get-detail.js`:**

- No structural change needed. Both paths (stored and computed) now return the same shape.

### Step 6 — Frontend changes (`lib/epr-frontend`)

**`src/server/reports/helpers/fetch-report-detail.js`:**

- Update `ReportDetailResponse` JSDoc typedef to match the DB shape.

**`src/server/reports/detail-controller.js`:**

- Update destructuring from `reportDetail.sections.wasteReceived` etc. to `reportDetail.recyclingActivity` etc.
- Update field name mappings in `buildSupplierRows`, `buildDestinationRows`, `buildOverseasSiteRows`.

**`detail.njk`:**

- No change expected — the controller continues to pass the same view model to the template.

**`detail-controller.test.js`:**

- Update mock response data to use the DB shape.

---

## Out of scope

- Two-collection → single-collection migration (D2, C3)
- `FAR_FUTURE` workaround (D3)
- Application service layer extraction (D1, D6)
- Period filter backward compatibility (C2)

These are independent concerns documented in the review and can be addressed separately.
