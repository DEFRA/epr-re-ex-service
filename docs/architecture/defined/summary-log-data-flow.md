# Data Flow and Invalidation

This document maps how changes to entities ripple through the system. Its purpose is to make clear: **when something changes, what becomes stale, and how (or whether) the system corrects it.**

For detailed implementation, see the related LLDs:

- [Summary Log Validation LLD](summary-log-validation-lld.md)
- [Summary Log Row Validation Classification](summary-log-row-validation-classification.md)
- [Summary Log Submission LLD](summary-log-submission-lld.md)
- [Summary Log Processing Failure Handling](summary-log-processing-failure-handling.md)

## System Overview

The system has a clear data flow direction: upstream entities influence how downstream entities are created, but downstream entities do not feed back upstream.

```mermaid
flowchart LR
    classDef source fill:#4a90d9,color:#fff,stroke:none
    classDef core fill:#f5f5f5,stroke:#333
    classDef downstream fill:#51cf66,color:#000,stroke:none
    classDef reference fill:#e8daef,stroke:#333

    SL["Summary Log\n(spreadsheet)"]:::source
    PRN["PRN / PERN"]:::source

    REG["Registration\n(processing type,\nmaterial, site)"]:::reference
    ACC["Accreditation\n(date range,\nsuspension history)"]:::reference
    ORS["Overseas\nReprocessing\nSites"]:::reference
    ORG["Organisation\n(name, address)"]:::reference

    WR["Waste Records"]:::core
    WB["Waste Balance"]:::downstream
    RPT["Reports"]:::downstream

    SL -->|"creates and\nupdates"| WR
    WR -->|"classified rows\nbecome transactions"| WB
    PRN -->|"debits and\nringfences"| WB
    WR -->|"aggregated by\nperiod"| RPT
    PRN -->|"issuance\ntonnage"| RPT

    ACC -.->|"date range and\nsuspension affect\nrow classification"| WR
    REG -.->|"processing type\nand material\nselect schemas"| SL
    REG -.->|"suspension\ncascades"| ACC
    REG -.->|"site address\ndenormalised\ninto response"| RPT
    ORS -.->|"approval date\naffects classification;\nsite names captured\nat upload time"| WR
    ORG -.->|"name and trading\nname snapshotted\nat creation"| PRN
    ACC -.->|"details snapshotted\nat creation"| PRN
    ACC -.->|"accredited vs\nregistered-only\nsets cadence"| RPT
```

## What Reads What

Before looking at invalidation, it helps to know what data each entity actually uses from other entities.

### Summary Log Validation reads

| Source | Data used | Purpose |
| --- | --- | --- |
| **Registration** | `registrationNumber` | Compared against spreadsheet metadata (FATAL if mismatch) |
| **Registration** | `wasteProcessingType`, `reprocessingType` | Selects which table schemas and validation rules apply |
| **Registration** | `material`, `glassRecyclingProcess` | Compared against spreadsheet metadata (FATAL if mismatch) |
| **Accreditation** | `accreditationNumber` | Compared against spreadsheet metadata (FATAL if mismatch) |
| **Accreditation** | `validFrom`, `validTo` | Used to mark rows as IGNORED if dates fall outside the period |
| **Accreditation** | `statusHistory` | Used to mark rows as IGNORED if accreditation was suspended at the load date |
| **Existing Waste Records** | `type`, `rowId` | Row continuity check — previously submitted rows must not be removed |
| **Feature flags** | `isRegisteredOnlyEnabled` | Controls whether registered-only template variants are accepted |
| **Template version thresholds** | Minimum per processing type | Rejects spreadsheets using outdated template versions |

### Waste Balance calculation reads

| Source | Data used | Purpose |
| --- | --- | --- |
| **Accreditation** | `validFrom`, `validTo` | Date range for row classification (INCLUDED vs IGNORED) |
| **Accreditation** | `statusHistory` | Suspension check at each load date |
| **Waste Record data** | Required fields per table | Missing required fields → row EXCLUDED from balance |
| **Waste Record data** | `WERE_PRN_OR_PERN_ISSUED_ON_THIS_WASTE` | If "Yes" → row EXCLUDED (already accounted for) |
| **Waste Record data** | `ADD_PRODUCT_WEIGHT` (reprocessor output only) | If not "Yes" → row EXCLUDED |
| **Waste Record data** | `DID_WASTE_PASS_THROUGH_AN_INTERIM_SITE` (exporter only) | Switches which tonnage field is used |
| **Waste Record data** | Tonnage field (varies by table) | The actual credit or debit amount |
| **ORS approval data** (exporter only) | ORS `validFrom` date matched against export date | VAL014: if the ORS was not yet approved at the date of export → row EXCLUDED from balance |
| **Existing balance** | Prior transactions per rowId | Delta mechanism — only creates a transaction if the target amount differs from what was previously credited |

### PRN operations read

| Source | Data used | Purpose |
| --- | --- | --- |
| **Waste Balance** | `availableAmount` | Checked at PRN creation — must have sufficient available tonnage |
| **Waste Balance** | `amount` | Checked at PRN issue — must have sufficient total tonnage |
| **Accreditation** | `status` | Checked at PRN issue — cannot issue if accreditation is suspended |
| **Accreditation** | Number, year, material, glass process, site address | Snapshotted into the PRN at creation (never updated) |
| **Organisation** | `name`, `tradingName` | Snapshotted into the PRN at creation (never updated) |

### Reports read

| Source | Data used | Purpose |
| --- | --- | --- |
| **Waste Records** | Date fields (varies by operator category) | Determines which records fall in which reporting period |
| **Waste Records** | Tonnage fields | Summed for received, exported, sent-on totals |
| **Waste Records** | `SUPPLIER_NAME`, `ACTIVITIES_CARRIED_OUT_BY_SUPPLIER` | Listed in recycling activity section |
| **Waste Records** | `OSR_ID`, `OSR_NAME` | Listed as overseas sites in export activity section |
| **Waste Records** | `FINAL_DESTINATION_NAME`, `FINAL_DESTINATION_FACILITY_TYPE` | Listed in waste sent section, categorised by facility type |
| **PRNs** (accredited only) | Tonnage of PRNs with `status.issued.at` in period | PRN issuance data in report |
| **Registration** | `accreditationId` (present or absent) | Determines cadence: monthly (accredited) or quarterly (registered-only) |
| **Registration** | `wasteProcessingType` | Determines operator category and which report sections apply |
| **Registration** | `material`, `site.address` | Appended to report response |

## Invalidation Map

Each section below answers: **when this changes, what breaks, and how is it fixed?**

```mermaid
flowchart LR
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none
    classDef blocked fill:#333,color:#fff,stroke:none

    subgraph Legend
        direction TB
        L1["Auto-corrected"]:::auto
        L2["Stale until\noperator acts"]:::stale
        L3["Requires operator\nor regulator action"]:::manual
        L4["Operation\nblocked"]:::blocked
    end
```

### New Summary Log submitted

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    T["Summary Log\nsubmitted"]:::trigger

    T --> WR["Waste Records\nupdated with\nnew versions"]:::auto
    T --> WB["Waste Balance\nrecalculated via\ndelta mechanism"]:::auto
    T --> PREV["Previous unsubmitted\nSummary Logs for\nsame Registration\nbecome superseded"]:::stale
    T --> RPT_C["Computed Reports\nautomatically reflect\nnew data on next read"]:::auto
    T --> RPT_P["Persisted Reports\nfor affected periods\nnow contain\noutdated tonnages"]:::stale

    PREV --> PREV_FIX["Operator must\nre-upload"]:::manual
    RPT_P --> RPT_FIX["Delete and recreate\naffected Report"]:::manual
```

### PRN lifecycle changes

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    subgraph Creation ["PRN created (DRAFT → AWAITING AUTHORISATION)"]
        T1["PRN created"]:::trigger
        T1 --> WB1["Available balance\nreduced\n(tonnage ringfenced)"]:::auto
        T1 --> CHECK1["Checks available\nbalance is sufficient\n(409 Conflict if not)"]:::auto
    end

    subgraph Issue ["PRN issued (AWAITING AUTHORISATION → AWAITING ACCEPTANCE)"]
        T2["PRN issued"]:::trigger
        T2 --> WB2["Total balance\nreduced"]:::auto
        T2 --> CHECK2["Checks total balance\nis sufficient and\nAccreditation not\nsuspended"]:::auto
        T2 --> RPT2["Persisted Reports\nfor affected period\nhave outdated\nPRN data"]:::stale
        RPT2 --> RPT2_FIX["Delete and recreate\nReport"]:::manual
    end

    subgraph Cancel ["PRN cancelled"]
        T3["PRN cancelled"]:::trigger
        T3 --> WB3["Balance restored\n(available and/or total\ndepending on whether\nPRN was issued)"]:::auto
        T3 --> RPT3["Persisted Reports\nhave outdated\nPRN data"]:::stale
        RPT3 --> RPT3_FIX["Delete and recreate\nReport"]:::manual
    end
```

### Accreditation dates changed

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    T["Regulator changes\nAccreditation\ndate range"]:::trigger

    T --> CLASS["Row classification\nchanges: rows may\nmove between\nIncluded and Ignored"]:::stale
    T --> WB["Waste Balance is\nstale (based on old\ndate boundaries)"]:::stale
    T --> PRN_BAL["PRN balance checks\nuse stale balance\n(may allow or reject\nPRNs incorrectly)"]:::stale
    T --> RPT_C["Computed Reports\npick up current dates\non next read"]:::auto
    T --> RPT_P["Persisted Reports\nfor affected periods\nnow outdated"]:::stale
    T --> PRN_SNAP["Existing PRNs retain\nold Accreditation\nsnapshot"]:::stale

    WB --> WB_FIX["Corrected on next\nSummary Log\nsubmission"]:::manual
    RPT_P --> RPT_FIX["Delete and recreate\naffected Reports"]:::manual
```

### Accreditation or Registration suspended

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none
    classDef blocked fill:#333,color:#fff,stroke:none

    T1["Registration\nsuspended"]:::trigger
    T2["Accreditation\nsuspended"]:::trigger

    T1 -->|"cascades to\nlinked Accreditation"| T2

    T2 --> CLASS["Rows during suspended\nperiod become Ignored\n(no balance effect)"]:::stale
    T2 --> WB["Waste Balance is stale\n(credits for suspended\nperiod not yet reversed)"]:::stale
    T2 --> PRN_BLOCK["PRN issuance blocked\nwhile suspended\n(creation still allowed)"]:::blocked
    T2 --> RPT_P["Persisted Reports\nfor suspended period\nnow outdated"]:::stale

    WB --> WB_FIX["Corrected on next\nSummary Log\nsubmission"]:::manual
    RPT_P --> RPT_FIX["Delete and recreate\naffected Reports"]:::manual
```

### Accreditation granted or removed

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    T["Registration becomes\nAccredited\n(or loses Accreditation)"]:::trigger

    T --> CADENCE["Reporting cadence\nswitches between\nMonthly and Quarterly"]:::auto
    T --> WB_NEW["Waste Balance created\n(or no longer maintained\nif removed)"]:::auto
    T --> SCHEMA["Validation schemas\nchange (different\nrequired fields for\nRegistered-Only)"]:::stale
    T --> RPT["Existing persisted\nReports under old\ncadence remain as\nhistorical record"]:::auto

    SCHEMA --> SCHEMA_FIX["Operator must upload\nnew Summary Log\nusing correct template"]:::manual
```

### Registration details changed (material, processing type, site address)

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    T["Regulator changes\nRegistration details"]:::trigger

    T --> VAL["Next Summary Log\nvalidation checks\nagainst new values\n(material, processing\ntype mismatches\nwill be rejected)"]:::auto
    T --> RPT_ADDR["Report responses\nshow current site\naddress (read live\nfrom Registration)"]:::auto
    T --> PRN_SNAP["Existing PRNs retain\nold Accreditation\nsnapshot including\nold material and\nsite address"]:::stale
    T --> WR["Existing Waste Records\nunaffected (store only\nIDs, not Registration\ndetails)"]:::auto
```

### Organisation details changed (name, trading name)

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none

    T["Organisation name\nor trading name\nchanged"]:::trigger

    T --> PRN["Existing PRNs retain\nold organisation name\n(snapshotted at\ncreation)"]:::stale
    T --> WR["Waste Records\nunaffected\n(store only IDs)"]:::auto
    T --> RPT["Reports unaffected\n(store only IDs)"]:::auto
```

### Overseas Reprocessing Site data changed

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef stale fill:#ffa94d,color:#000,stroke:none
    classDef auto fill:#51cf66,color:#000,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    T["ORS approval status,\nname, or details\nchanged"]:::trigger

    T --> CLASS["Row classification\nchanges for exporters:\nORS approval date\nchecked against\nexport date (VAL014)"]:::stale
    T --> WB["Waste Balance may\nbe stale if rows\nare newly included\nor excluded"]:::stale
    T --> WR["Existing Waste Records\nretain old ORS ID\nand name (captured\nfrom spreadsheet\nat upload time)"]:::stale
    T --> RPT_C["Computed Reports show\nstale ORS names\n(derived from\nWaste Records)"]:::stale
    T --> RPT_P["Persisted Reports\ncontain stale\nORS snapshot"]:::stale

    WB --> WB_FIX["Corrected on next\nSummary Log\nsubmission"]:::manual
    WR --> WR_FIX["New Summary Log\nupload captures\ncurrent ORS details"]:::manual
    WR_FIX --> RPT_C_FIX["Computed Reports then\nreflect updated names"]:::auto
    RPT_P --> RPT_P_FIX["Delete and recreate\naffected Reports"]:::manual
```

### Pending Report blocks submission (VAL012)

```mermaid
flowchart TD
    classDef trigger fill:#ff6b6b,color:#fff,stroke:none
    classDef blocked fill:#333,color:#fff,stroke:none
    classDef manual fill:#4a90d9,color:#fff,stroke:none

    T["Report exists in\npending state for\nthis Accreditation"]:::trigger

    T --> BLOCK["Summary Log submission\nblocked entirely\n(regardless of\nrow validity)"]:::blocked

    BLOCK --> FIX["Report must be\napproved or withdrawn\nbefore operator can\nsubmit"]:::manual
```

## Invalidation Summary

| Change | Waste Records | Waste Balance | Computed Reports | Persisted Reports | PRNs |
| --- | --- | --- | --- | --- | --- |
| **Summary Log submitted** | Updated (new versions) | Auto-corrected (delta) | Auto-corrected | **Stale** — recreate | — |
| **PRN created** | — | Auto-corrected (ringfence) | Auto-corrected | — | — |
| **PRN issued** | — | Auto-corrected (debit) | Auto-corrected | **Stale** — recreate | — |
| **PRN cancelled** | — | Auto-corrected (reversal) | Auto-corrected | **Stale** — recreate | — |
| **Accreditation dates changed** | Classification changes | **Stale** until next submission | Auto-corrected | **Stale** — recreate | Retain old snapshot |
| **Accreditation suspended** | Classification changes | **Stale** until next submission | Auto-corrected | **Stale** — recreate | Issuance blocked |
| **Registration suspended** | Via accreditation cascade | Via accreditation cascade | Via cascade | Via cascade | Via cascade |
| **Accreditation granted/removed** | Schema changes | Created or removed | Cadence changes | Historical | — |
| **Registration details changed** | Unaffected (IDs only) | Unaffected | Site address auto-corrected | — | Retain old snapshot |
| **Organisation details changed** | Unaffected (IDs only) | Unaffected | Unaffected | Unaffected | Retain old snapshot |
| **ORS data changed** | Retain old snapshot | **Stale** until next submission (VAL014 classification) | **Stale** (old names) | **Stale** — recreate | — |
| **Pending Report exists** | — | — | — | — | — (submission blocked) |

## Key Architectural Insight

The system has three correction mechanisms, each with different latency:

1. **Immediate** — PRN transactions update the waste balance straight away.
2. **On next submission** — The delta mechanism re-classifies all waste records against the current accreditation state and creates corrective transactions. Changes to accreditation dates or suspension status are **not reflected in the waste balance until the operator uploads a new summary log**.
3. **On read** — Computed reports always aggregate from current waste records, so they self-correct. Persisted reports are snapshots that must be manually deleted and recreated.

**There is no background recalculation.** If a regulator changes accreditation dates and no new summary log is submitted, the waste balance remains incorrect. This also means PRN balance sufficiency checks may use stale figures.

PRNs and waste records deliberately use a **snapshot** pattern for denormalised data (organisation name, accreditation details, ORS names). This preserves what was true at the time of creation for audit purposes, but means these snapshots become stale when upstream entities change.
