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

Create `regulatory-reports` collection to store pre-aggregated reporting data.

## Data Flow

```
Summary Log (submitted) ──┐
                          ├──> Waste Records ──┐
PRN/PERN (issued) ────────┤                    ├──> Monthly Report
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
    ORGANISATION ||--o{ REGULATORY_REPORT : generates
    SUMMARY_LOG ||--o{ WASTE_RECORD : contains
    WASTE_RECORD }o--|| WASTE_BALANCE : updates
    REGULATORY_REPORT }o--o{ WASTE_RECORD : aggregates
    REGULATORY_REPORT }o--o{ SUMMARY_LOG : references
    REGULATORY_REPORT }o--o{ PRN_PERN : aggregates
    PRN_PERN }o--|| WASTE_BALANCE : debits
    REGULATORY_REPORT ||--o| RECYCLING_ACTIVITY : "reprocessor"
    REGULATORY_REPORT ||--o| WASTE_SENT : "exporter"
    REGULATORY_REPORT ||--o| PRN_DATA : "prnData"
    REGULATORY_REPORT ||--|| SOURCE_DATA : "sourceData"
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

    REGULATORY_REPORT {
        ObjectId _id PK
        number version
        number schemaVersion
        ObjectId organisationId UK
        ObjectId registrationId UK
        ObjectId accreditationId
        number year UK
        enum period UK "1-12 for months, 1-4 for quarters, 1 for yearly"
        enum cadence UK "monthly|quarterly|annual"
        enum status "ready_to_create|overdue|in_progress|ready_to_submit|submitted i.e what about new SL uploads"
        date startDate
        date endDate
        string material
        string wasteProcessingType
        string siteAddress
        RECYCLING_ACTIVITY recyclingActivity
        EXPORT_ACTIVITY exportActivity
        WASTE_SENT wasteSent
        PRN_DATA prnData
        boolean isSummaryLogUpToDate
        string supportingInformation
        SOURCE_DATA sourceData
        USER createdBy
        ISO8601 createdAt
        USER approvedBy
        ISO8601 approvedAt
        ISO8601 submittedAt
        USER submittedBy
    }

    USER {
      string fullName
      string email
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
        string[] summaryLogIds
        string[] prnIds
        ISO8601 lastAggregatedAt
    }


```
