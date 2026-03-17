# Regulatory Reporting Data Model

## Status

Proposed

## Context

Reprocessors and exporters must submit monthly (accredited) or quarterly (registered) reports to regulatory agencies containing:

- Tonnage data (received, recycled/exported, sent on)
- Supplier and destination facility details
- PRN/PERN issuance and financial data

Current system has operational collections (`summary-logs`, `waste-records`, `waste-balances`, `packaging-recycling-notes`) but needs optimized reporting collection for regulatory exports.

## Decision

Create two collections:

- `periodic-reports` — lean period identity anchor; composite unique key; holds pointers to current and previous report submissions.
- `reports` — standalone submission documents containing all field data and full status audit trail.

## Data Flow

```
Summary Log (submitted) ──┐
                          ├──> Waste Records ──┐
PRN/PERN (issued) ────────┤                    ├──> Periodic Report
                          │                    │    (aggregated)
Organisation Data ────────┴────────────────────┘
```

**Aggregation triggers**:

- Summary log submission
- PRN/PERN issuance
- Manual regeneration

**Source collections**:

- `waste-records` (type: received/sentOn/exported)
- `packaging-recycling-notes` (status: accepted)
- `epr-organisations` (denormalized)

## Entity Relationship Diagram

```mermaid
erDiagram
    ORGANISATION ||--o{ SUMMARY_LOG : submits
    ORGANISATION ||--o{ PERIODIC_REPORTS : "has periods"
    SUMMARY_LOG ||--o{ WASTE_RECORD : contains
    WASTE_RECORD }o--|| WASTE_BALANCE : updates
    PERIODIC_REPORTS }o--o{ WASTE_RECORD : aggregates
    PERIODIC_REPORTS }o--o{ SUMMARY_LOG : references
    PERIODIC_REPORTS }o--o{ PRN_PERN : aggregates
    PRN_PERN }o--|| WASTE_BALANCE : debits
    PERIODIC_REPORTS ||--o| REPORTS : "currentReportId"
    PERIODIC_REPORTS ||--o{ REPORTS : "previousReportIds"
    REPORTS ||--o| RECYCLING_ACTIVITY : "recyclingActivity"
    REPORTS ||--o| EXPORT_ACTIVITY : "exportActivity"
    REPORTS ||--o| WASTE_SENT : "wasteSent"
    REPORTS ||--o| PRN_DATA : "prnData"
    REPORTS ||--|| SOURCE_DATA : "sourceData"
    REPORTS ||--o{ STATUS_HISTORY : "statusHistory"
    RECYCLING_ACTIVITY ||--o{ SUPPLIER : "suppliers"
    WASTE_SENT ||--o{ FINAL_DESTINATION : "finalDestinations"

    ORGANISATION {
        ObjectId _id PK
        number orgId UK
        string name
        object[] registrations
        object[] accreditations
    }

    SUMMARY_LOG {
        string _id PK
        string organisationId FK
        string status
    }

    WASTE_RECORD {
        string organisationId FK
        string accreditationId FK
        string type
        object data
    }

    WASTE_BALANCE {
        string _id PK
        string accreditationId UK
        object[] transactions
    }

    PRN_PERN {
        ObjectId _id PK
        string prnNumber UK
        number tonnage
    }

    PERIODIC_REPORTS {
        ObjectId   _id               PK
        ObjectId   organisationId    "UK (composite)"
        ObjectId   registrationId    "UK (composite)"
        ObjectId   accreditationId   "UK (composite)"
        number     year              "UK (composite)"
        enum       period            "UK (composite) — 1-12 | 1-4 | 1"
        enum       cadence           "UK (composite) — monthly|quarterly|annual"
        date       startDate
        date       endDate
        ObjectId   currentReportId   "FK to reports; null until first submission"
        ObjectId[] previousReportIds "FK[] to reports; empty on first; newest first"
    }

    REPORTS {
        ObjectId            _id                   PK
        number              version               "incremented on every write"
        number              schemaVersion
        enum                status                "in_progress|ready_to_submit|submitted|superseded"
        STATUS_HISTORY[]    statusHistory
        string              material
        string              wasteProcessingType
        string              siteAddress
        RECYCLING_ACTIVITY  recyclingActivity
        EXPORT_ACTIVITY     exportActivity
        WASTE_SENT          wasteSent
        PRN_DATA            prnData
        string              supportingInformation
        SOURCE_DATA         sourceData
    }

    STATUS_HISTORY {
        enum         status    "in_progress|ready_to_submit|submitted|superseded"
        USER-SUMMARY changedBy
        ISO8601      changedAt
    }

    USER-SUMMARY {
        ObjectId id
        string name
        string position
    }

    RECYCLING_ACTIVITY {
        SUPPLIER[] suppliers
        decimal totalTonnageReceived
        decimal tonnageRecycled
        decimal tonnageNotRecycled
    }

    OVERSEAS_REPROCESSING_SITES {
        string siteName
        number orsId
        decimal tonnageExported
    }

    EXPORT_ACTIVITY {
        OVERSEAS_REPROCESSING_SITES[] overseasSites
        decimal totalTonnageReceivedForExporting
        decimal tonnageReceivedNotExported
        decimal tonnageRefusedAtRecepientDestination
        decimal tonnageStoppedDuringExport
        decimal tonnageRepatriated
    }

    WASTE_SENT {
        decimal tonnageSentToReprocessor
        decimal tonnageSentToExporter
        decimal tonnageSentToAnotherSite
        FINAL_DESTINATION[] finalDestinations
    }

    SUPPLIER {
        string supplierName
        string facilityType
        object address
        string phone
        string email
        decimal tonnageReceived
    }

    FINAL_DESTINATION {
        string recipientName
        string facilityType
        object address
        string phone
        string email
        decimal tonnageSentOn
    }

    PRN_DATA {
        decimal tonnageIssued
        decimal totalRevenue
        decimal averagePricePerTonne
    }

    SOURCE_DATA {
        ObjectId summaryLogId
    }
```

## Resubmission Flow

1. Insert new `REPORTS` document (status `in_progress`; first `STATUS_HISTORY` entry)
2. Set old `REPORTS` status → `superseded` (append entry to `statusHistory`)
3. Update `PERIODIC_REPORTS` atomically:
   - `previousReportIds = [currentReportId, ...previousReportIds]`
   - `currentReportId = new report _id`
