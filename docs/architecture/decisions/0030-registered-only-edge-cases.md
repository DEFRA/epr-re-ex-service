# 30. Registered-only operator edge cases

Date: 2026-03-27

## Status

Proposed

## Context

During 3 amigos for the registered-only epic (PAE-735), the team identified four edge cases that could affect summary log uploads for non-accredited operators:

1. Suspension of an accreditation and the impact on summary log uploads
2. Cancellation of an accreditation and the impact on summary log uploads
3. Movement from registered-only to accredited and the impact on summary log uploads
4. Non-mandatory fields on registered-only summary log uploads and the positions an operator can get themselves into

This document records what the investigation found for each case. The investigation covered the backend validation pipeline, the domain model, the frontend gating logic, and the relevant table schemas.

### Background: how the system classifies operators

The system classifies operators into two categories based on whether the registration has a linked accreditation with an `accreditationNumber`:

- **Accredited**: registration has an `accreditationId` linking to an `Accreditation` with a non-null `accreditationNumber` (status `approved` or `suspended`). Must use accredited templates: `REPROCESSOR_INPUT`, `REPROCESSOR_OUTPUT`, or `EXPORTER`.
- **Registered-only**: registration has no `accreditationId`, or the linked accreditation has no `accreditationNumber`. Must use registered-only templates: `REPROCESSOR_REGISTERED_ONLY` or `EXPORTER_REGISTERED_ONLY`.

This classification is enforced by `isRegisteredOnlyMismatch` in `src/application/summary-logs/validations/processing-type.js`. A mismatch between the operator class and the uploaded template type produces a fatal `PROCESSING_TYPE_MISMATCH` error.

---

## Findings

### 1. Suspension of an accreditation

**Current behaviour**

When a registration is suspended, `applyRegistrationStatusToLinkedAccreditations` (`repositories/organisations/schema/status-transition.js`) cascades the suspension to the linked accreditation. The accreditation retains its `accreditationNumber` — the `AccreditationApproved` typedef covers both `approved` and `suspended` status.

Consequently, a suspended accredited operator is still classified as accredited. They must continue using the accredited template. There is no upload-initiation guard on status — a suspended operator can still call the `POST /summary-logs` endpoint and upload a file.

The waste balance handles suspension correctly. `isAccreditedAtDates` (`src/common/helpers/dates/accreditation.js`) checks `isSuspendedAtDate` against the accreditation's status history. Rows whose dates fall within a suspension period are classified as `IGNORED`, meaning they do not contribute to the waste balance but are still persisted.

**Assessment**

No action required. The system already handles this correctly. Suspension does not affect the operator's ability to submit data, and waste balance automatically discards rows from the suspension period.

---

### 2. Cancellation of an accreditation

**Current behaviour**

Cancellation cascades from the registration to the linked accreditation in the same way as suspension. The accreditation's status becomes `cancelled` but its `accreditationNumber` and `validTo` date are not cleared from the document.

Because `accreditationNumber` is still present, the operator is still classified as accredited and must use the accredited template. Post-cancellation rows have dates beyond `validTo`, which `isWithinAccreditationDateRange` (`accreditation.js`) will mark as `IGNORED`.

There is no upload guard on `cancelled` status. A cancelled operator can initiate and submit uploads.

**Two issues identified**

1. **Policy gap**: Whether a cancelled accredited operator should be permitted to upload is a regulatory policy question that the code does not currently address. The current behaviour (uploads permitted, post-cancellation rows ignored for waste balance) may be intentional if operators need to submit historical data after cancellation, or it may be an oversight.

2. **Type definition gap**: The `AccreditationOther` typedef in `src/domain/organisations/accreditation.js` lists status values as `'created'|'rejected'|'archived'` but does not include `'cancelled'`, even though `REG_ACC_STATUS` in `src/domain/organisations/model.js` defines `cancelled` as a valid status. This is a minor inconsistency that could cause confusion.

**Assessment**

Two follow-up items:

- A policy decision is needed on whether cancelled operators should be blocked from uploading. Until resolved, the existing behaviour (permit uploads, ignore post-cancellation rows in waste balance) is not actively harmful.
- The `AccreditationOther` typedef should be corrected to include `'cancelled'`.

---

### 3. Movement from registered-only to accredited

**Current behaviour**

When a registered-only registration gains an approved accreditation (acquiring an `accreditationNumber`), `isRegisteredOnlyMismatch` immediately requires the accredited template. Any subsequent upload using the registered-only template is rejected with `PROCESSING_TYPE_MISMATCH`.

**Row continuity across the template change**

The row continuity check (`src/application/summary-logs/validations/row-continuity.js`) loads all existing waste records for the registration via `findByRegistration`, which is scoped to `(organisationId, registrationId)` regardless of processing type. It compares records by the composite key `type:rowId`, where `type` is `wasteRecordType` (e.g. `received`, `sentOn`) rather than `processingType`.

This means that after the transition, the operator's first accredited upload must include all rowIds from their previous registered-only uploads or the upload is rejected. Both template types share the same `wasteRecordType` values and ROW_ID ranges for the received and sentOn tables, so the operator can carry over their existing rowIds into the accredited template. This is correct data integrity behaviour.

**Date granularity change**

The registered-only received-loads table uses a monthly date field (`MONTH_RECEIVED_FOR_REPROCESSING` / `MONTH_RECEIVED_FOR_EXPORT`) stored as `YYYY-MM`. The accredited received-loads table uses a daily date field (`DATE_RECEIVED_FOR_REPROCESSING` / `DATE_RECEIVED_FOR_EXPORT`) stored as `YYYY-MM-DD`. When the operator carries over a previously submitted row, the date field changes from monthly to daily granularity. The system does not guard against this; the row is updated in place with the new, more precise date.

**Reporting category change**

The `getOperatorCategory` function in `src/reports/domain/operator-category.js` derives the operator category from `registration.accreditationId`. Once the registration gains an `accreditationId`, all subsequent reports for that registration use the accredited category. Historical registered-only records retain their `processingType: 'REPROCESSOR_REGISTERED_ONLY'` (or `EXPORTER_REGISTERED_ONLY`), so there is a period of mixed processing types within a single registration's waste record history.

**Assessment**

The mechanical transition works: the operator is correctly redirected to the accredited template, and row continuity enforces data integrity across the change. However, three follow-up items are identified:

- **User guidance**: There is no user-facing message or notification explaining that the operator must switch to the accredited template after gaining accreditation. The first attempt with the old template will produce a `PROCESSING_TYPE_MISMATCH` error — a confusing experience without context.
- **Date granularity**: The implicit change from monthly to daily dates when re-submitting carried-over rows is not explained to the user and is not documented anywhere. It is likely correct behaviour but should be confirmed with the business.
- **Mixed processing type history**: The reporting layer should be verified to handle a registration that has both registered-only and accredited waste records correctly.

---

### 4. Non-mandatory fields on registered-only uploads

**Current behaviour**

All Joi field schemas in the registered-only table schemas use `.optional()` (see `src/domain/summary-logs/table-schemas/shared/field-schemas.js`). The validation pipeline strips empty and unfilled cells before running Joi validation (`filterToFilled` in `validation-pipeline.js`). Because registered-only schemas have no `classifyForWasteBalance` function, every syntactically valid row receives outcome `EXCLUDED` with no issues, regardless of which fields are populated.

The practical consequence is that a row containing only a `ROW_ID` — with every other field empty — passes validation and is persisted as a waste record.

Contrast with accredited templates: their `classifyForWasteBalance` implementations check a defined set of `WASTE_BALANCE_FIELDS` and return `MISSING_REQUIRED_FIELD` reasons for any row missing those fields. This does not block submission, but it does surface the sparse rows to the user on the check page.

**Positions an operator can get into**

- A row with month and weight but no supplier details is silently accepted.
- A row with no month filled (the dropdown stays on "Choose option") is silently accepted, persisted without a date.
- A completely empty row (ROW_ID only) is accepted and permanently locked in by row continuity — it can never be removed from future uploads.
- Multiple rounds of partly-filled rows accumulate: the operator sees a valid row count on the check page with no indication of sparse data quality.

**Assessment**

There is no "minimum viable row" concept for registered-only uploads. The system accepts and permanently retains sparse rows without surfacing the problem to the user. This is the primary risk from this edge case investigation.

**Recommendation**: Introduce a `classifyForFields` mechanism for registered-only schemas — analogous to `classifyForWasteBalance` in accredited schemas — that identifies rows missing key fields (at minimum: month and weight for received-loads tables) and returns `MISSING_REQUIRED_FIELD` reasons. These would be surfaced on the check page as rows with data quality issues, without blocking submission. This matches the existing pattern and avoids introducing a new validation concept.

---

## Decision

The four edge cases have materially different risk profiles:

1. **Suspension** — no action required. The system handles this correctly.
2. **Cancellation** — two follow-up items: a policy decision on upload permissions, and a minor typedef fix.
3. **Template transition (reg-only to accredited)** — no code change required for the transition mechanics, but user-facing guidance is missing and the reporting layer should be verified.
4. **Non-mandatory fields** — medium risk. A minimum viable row check should be added to registered-only table schemas.

## Consequences

The following follow-up tickets are created:

- **Tech / minor bug**: Fix `AccreditationOther` typedef to include `'cancelled'` status
- **Policy decision**: Determine whether cancelled accredited operators should be blocked from uploading (no code change until decision is made)
- **Story**: Add `classifyForFields` (or equivalent) to registered-only schemas to surface sparse rows on the check page, matching the `MISSING_REQUIRED_FIELD` pattern used in accredited schemas
- **Story**: Add user-facing guidance (error message content or documentation) to explain the template switch required when gaining accreditation
