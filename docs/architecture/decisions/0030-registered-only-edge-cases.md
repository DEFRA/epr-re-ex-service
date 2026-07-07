# 30. Registered-only operator edge cases

Date: 2026-03-27

Revised: 2026-07-07

## Status

Rejected.

Retained as a historical record of the original spike, not as a living specification. Subsequent analysis of the registered-only to accredited transition (and of switching operators between the two) has moved beyond what is captured here and is now the source of truth. Rather than keep this document continuously in sync with the code, we treat it as a point-in-time record and reject it as a standing ADR: the findings below are accurate as at the revision date but should not be read as the authoritative decision. See the revision history for what changed and why.

## Revision history

- **2026-03-27** — original spike findings recorded.
- **2026-07-07** — revised to reconcile with code that changed after the original draft. Two things shifted the picture materially: reporting and cadence classification moved from a simple `Boolean(registration.accreditationId)` check to a status-based `isRegistrationAccredited` check (approved/suspended only), and diagnostics plus a warning log were added for the silent report data loss. The template-validation axis was left unchanged, so the two axes now diverge for cancelled operators. Findings 2, 3 and 4 are updated below to match; the underlying risks are unchanged, but two of the specific failure modes are now different from what was first recorded.

## Executive summary

Three findings require no immediate code change: suspension is already handled correctly (Finding 1), cancellation is low-risk while policy is pending (Finding 2), and report completeness gating is awaiting a policy decision (Finding 5). Two carry real risk if left unaddressed: silent data loss after a registered-only → accredited transition (Finding 3) and incorrect cadence rules for mid-quarter transitions and cancellations (Finding 4).

### Impact of doing nothing

- **Data silently disappears from reports.** If a registered-only operator gains accreditation, all waste records they submitted before the transition are excluded from every report generated afterwards. The data still stops appearing, but it is no longer completely silent: a `diagnostics.wasteReceivedRecordsExcluded` count and a `warn`-level log were added (in [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040)) to surface the dropped records. This is the most serious finding (Finding 3).
- **Cadence rules are wrong for edge cases.** An operator accredited mid-quarter gets the right monthly periods going forward, but their pre-accreditation months in that quarter show empty reports (same root cause as above). Cancellation now flips the reporting classification the other way: a cancelled operator reverts to quarterly immediately, whereas the business rule is that they should stay monthly until the end of the current quarter (Finding 4).
- **Cancelled operators can keep uploading.** No guard exists. Post-cancellation rows are ignored in waste balance only when dated after `validTo`; rows dated within the original accreditation window still count, because the waste-balance check excludes suspended periods but not cancelled ones. The practical risk is still low but higher than first recorded, and it may not match regulatory intent (Finding 2).
- **Sparse registered-only rows have no classification mechanism at upload time, so they are not surfaced to the user for review.** Registered-only schemas lack the `classifyForWasteBalance` function that accredited schemas use to flag `MISSING_REQUIRED_FIELD` issues on the check page. Incomplete rows are silently accepted (Finding 5).

### Questions for the business

1. **Should cancelled operators be blocked from uploading?** The system currently permits it (post-cancellation data is ignored in waste balance). Is this intentional to allow late historical submissions, or should uploads be blocked after cancellation?
2. **How should pre-transition data appear in reports after an operator gains accreditation?** Options: (a) show it under the registered-only category alongside the new accredited data, (b) migrate it to the accredited format, or (c) accept it won't appear (and document that decision).
3. **Is incomplete data better than no data?** The regulator wants to block report creation when mandatory fields are missing. The team flags that this incentivises fake data. Which risk does the business prefer to carry?
4. **When an operator is accredited mid-quarter, should pre-accreditation months in that quarter appear as monthly reports?** The wiki says yes (the whole quarter becomes monthly), but the data for those months may only exist at monthly granularity — meaning the reports would show the right periods but potentially miss records.

## Context

During 3 amigos for the registered-only epic (PAE-735), the team identified three edge cases that could affect summary log uploads for non-accredited operators:

1. Suspension of an accreditation and the impact on summary log uploads
2. Cancellation of an accreditation and the impact on summary log uploads
3. Movement from registered-only to accredited and the impact on summary log uploads

This document records what the investigation found for each case. The investigation covered the backend validation pipeline, the domain model, the frontend gating logic, and the relevant table schemas.

A subsequent review against the team wiki revealed two further gaps not covered by the original spike:

4. Cadence transition rules — the business rules governing when an operator switches between quarterly and monthly reporting, and when they revert
5. Report completeness gating — whether the system should block report creation when mandatory fields are missing from uploaded data

### Background: how the system classifies operators

There are now **two independent classification axes**, and they use different signals. This distinction was not present when the spike was first written and is central to the revised findings below.

**Template axis (which template must the operator upload?)** — decided by whether the registration has a linked accreditation with an `accreditationNumber`:

- **Accredited**: registration has an `accreditationId` linking to an `Accreditation` with a non-null `accreditationNumber` (in practice this includes operators whose accreditation is `approved`, `suspended`, or `cancelled`, because none of those states clear `accreditationNumber`). Must use accredited templates: `REPROCESSOR_INPUT`, `REPROCESSOR_OUTPUT`, or `EXPORTER`.
- **Registered-only**: registration has no `accreditationId`, or the linked accreditation has no `accreditationNumber`. Must use registered-only templates: `REPROCESSOR_REGISTERED_ONLY` or `EXPORTER_REGISTERED_ONLY`.

This axis is enforced by `isRegisteredOnlyMismatch` in `src/application/summary-logs/validations/processing-type.js` (it tests `!registration.accreditation?.accreditationNumber`). A mismatch between the operator class and the uploaded template type produces a fatal `PROCESSING_TYPE_MISMATCH` error.

**Reporting axis (which category, date fields and cadence apply to reports?)** — decided by the accreditation's _status_, via `isRegistrationAccredited` in `src/domain/organisations/registration-utils.js`. This returns true only when `registration.accreditation.status` is in `ACTIVE_ACCREDITATION_STATUSES` (`approved` or `suspended`). Presence of an `accreditationId` or `accreditationNumber` is not sufficient. `getOperatorCategory` (`src/reports/domain/operator-category.js`) and the cadence selection in `src/reports/routes/get.js` both use this.

**The two axes diverge for cancelled operators.** A cancelled accreditation keeps its `accreditationNumber` (so the template axis still classes it as accredited) but its status is `cancelled` (so the reporting axis classes it as registered-only). The consequences of this divergence are drawn out in Findings 2, 3 and 4.

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

Cancellation cascades from the registration to the linked accreditation in the same way as suspension (`applyRegistrationStatusToLinkedAccreditations` in `src/repositories/organisations/schema/status-transition.js`). The accreditation's status becomes `cancelled` but its `accreditationNumber` and `validTo` date are not cleared from the document.

The two classification axes now split (see Background). Because `accreditationNumber` is still present, the **template axis** still classes the operator as accredited, so they must keep using the accredited template. But the **reporting axis** keys on status, so `isRegistrationAccredited` returns false and the operator is treated as registered-only for report category and cadence. A cancelled operator is therefore required to upload accredited-template data (daily date fields) while their reports are generated with the registered-only category (which looks up the monthly date field): the same mismatch that drives Finding 3, but in the opposite direction.

Waste balance handles post-cancellation rows only partially. `isAccreditedAtDates` (`src/common/helpers/dates/accreditation.js`) marks a row `IGNORED` when its date falls outside `validFrom`..`validTo`, so rows dated **after** `validTo` are correctly excluded. However, its suspension check (`isSuspendedAtDate`) only looks for `suspended` status in the history, not `cancelled`. Rows dated **within** the original accreditation window but uploaded after cancellation are therefore still treated as accredited and still contribute to the waste balance. The "post-cancellation rows are harmlessly ignored" summary holds only for rows dated beyond `validTo`.

There is no upload guard on `cancelled` status. A cancelled operator can initiate and submit uploads.

**Three issues identified**

1. **Policy gap**: Whether a cancelled accredited operator should be permitted to upload is a regulatory policy question that the code does not currently address. The current behaviour (uploads permitted, post-cancellation rows ignored for waste balance) may be intentional if operators need to submit historical data after cancellation, or it may be an oversight.

2. **Type definition gap**: The `AccreditationOther` typedef in `src/domain/organisations/accreditation.js` lists status values as `'created'|'rejected'|'archived'` but does not include `'cancelled'`, even though `REG_ACC_STATUS` in `src/domain/organisations/model.js` defines `cancelled` as a valid status. This is a minor inconsistency that could cause confusion.

3. **Cadence reversion on cancellation**: Per the business rules, cancellation does not immediately revert the operator to quarterly reporting. The current (cancelled) quarter remains monthly, and the operator reverts to quarterly only for the first full quarter after cancellation. See Finding 4 for the gap this creates.

**Assessment**

Three follow-up items:

- A policy decision is needed on whether cancelled operators should be blocked from uploading. Until resolved, the existing behaviour (permit uploads, ignore post-cancellation rows in waste balance) is not actively harmful.
- The `AccreditationOther` typedef should be corrected to include `'cancelled'`. **Done** — fixed in [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040), using `Extract<RegAccStatus, ...>` to stay in sync with the domain model.
- The cadence reversion logic for cancelled operators is unimplemented — see Finding 4.

---

### 3. Movement from registered-only to accredited

**Current behaviour**

When a registered-only registration gains an approved accreditation (acquiring an `accreditationNumber`), `isRegisteredOnlyMismatch` immediately requires the accredited template. Any subsequent upload using the registered-only template is rejected with `PROCESSING_TYPE_MISMATCH`.

**Row continuity across the template change**

The row continuity check (`src/application/summary-logs/validations/row-continuity.js`) loads all existing waste records for the registration via `findByRegistration`, which is scoped to `(organisationId, registrationId)` regardless of processing type. It compares records by the composite key `type:rowId`, where `type` is `wasteRecordType` (e.g. `received`, `sentOn`) rather than `processingType`.

This means that after the transition, the operator's first accredited upload must include all rowIds from their previous registered-only uploads or the upload is rejected. Both template types share the same `wasteRecordType` values and ROW_ID ranges for the received and sentOn tables, so the operator can carry over their existing rowIds into the accredited template. This is correct data integrity behaviour.

**Date granularity change**

The registered-only received-loads table uses a monthly date field (`MONTH_RECEIVED_FOR_REPROCESSING` / `MONTH_RECEIVED_FOR_EXPORT`) stored as `YYYY-MM`. The accredited received-loads table uses a daily date field (`DATE_RECEIVED_FOR_REPROCESSING` / `DATE_RECEIVED_FOR_EXPORT`) stored as `YYYY-MM-DD`. When the operator carries over a previously submitted row, the date field changes from monthly to daily granularity. The system does not guard against this; the row is updated in place with the new, more precise date.

**Reporting category change and historical record visibility**

The `getOperatorCategory` function in `src/reports/domain/operator-category.js` derives the operator category via `isRegistrationAccredited`, which returns true only when the linked accreditation's status is `approved` or `suspended`. Once the accreditation reaches an active status, all subsequent reports for that registration use the accredited category. Historical registered-only records retain their `processingType: 'REPROCESSOR_REGISTERED_ONLY'` (or `EXPORTER_REGISTERED_ONLY`), so there is a period of mixed processing types within a single registration's waste record history.

This creates a concrete data loss path in report aggregation. The `aggregateReportDetail` function in `src/reports/domain/aggregation/aggregate-report-detail.js` filters waste records by looking up `wasteRecord.data[dateField]`, where `dateField` is resolved from `SECTION_DATE_FIELDS_BY_OPERATOR_CATEGORY` (`src/reports/domain/aggregation/fields-by-operator-category.js`) using the current operator category. After gaining accreditation, the category becomes `REPROCESSOR` (or `EXPORTER`), so the date field looked up is `DATE_RECEIVED_FOR_REPROCESSING`. Historical registered-only records only have `MONTH_RECEIVED_FOR_REPROCESSING`. The date field is absent, so those records are excluded from every aggregated report.

The exclusion is no longer completely silent. `aggregateReportDetail` counts excluded received records in `diagnostics.wasteReceivedRecordsExcluded`, and the report-detail route (`src/reports/routes/get-detail.js`) emits a `warn`-level log referencing this ADR whenever that count is greater than zero (both added in [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040)). The records are still dropped from the report; the diagnostics only surface that it happened.

In other words: any data the operator submitted under the registered-only template before accreditation will not appear in any report generated after the transition.

**Assessment**

The mechanical transition works for uploads, but historical data is silently lost from report aggregation. Three follow-up items are identified:

- **Date granularity**: The implicit change from monthly to daily dates when re-submitting carried-over rows is not explained to the user and is not documented anywhere. It is likely correct behaviour but should be confirmed with the business.
- **Historical record visibility**: Report aggregation is broken for registrations with mixed processing type history. Historical registered-only records are silently excluded after the operator category transitions. A dedicated story is needed to define how pre-transition data should be handled in reports. Diagnostics tracking excluded record counts (`diagnostics.wasteReceivedRecordsExcluded`) and a warning log at the GET report-detail route were added in [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040) to surface this silently-dropped data; the underlying fix still requires a business decision.
- **Mid-quarter accreditation cadence**: Per the business rules, if an operator is accredited at any point in a quarter, the entire quarter is treated as monthly — including months before the accreditation date. See Finding 4 for the gap this creates.

---

### 4. Cadence transition rules

**Business rules (from team wiki)**

The following rules govern the transition between quarterly and monthly reporting:

- **Registered-only**: reports quarterly.
- **Accredited**: reports monthly and can issue PRNs.
- **Mid-quarter accreditation**: if an operator is accredited at any point in a quarter, the entire quarter is treated as monthly — including months before the accreditation date. This prevents operators from having to submit both a monthly and a quarterly report for the same quarter.
- **Accreditation suspension**: reporting cadence is unchanged. The operator continues monthly reporting.
- **Accreditation cancellation**: monthly reporting continues for the remainder of the current quarter. The operator reverts to quarterly only at the start of the first full quarter without accreditation.

**Current behaviour**

The reporting calendar is generated in `src/reports/routes/get.js` with a simple binary check:

```js
const cadence = isRegistrationAccredited(registration)
  ? CADENCE.monthly
  : CADENCE.quarterly
```

`isRegistrationAccredited` returns true only for `approved` or `suspended` status. This is a single point-in-time decision that implements none of the transition rules above:

- **Mid-quarter accreditation**: an operator accredited in February would correctly receive monthly periods for the full year. However, January data already submitted under the registered-only template uses `MONTH_RECEIVED_FOR_REPROCESSING` (YYYY-MM), not the `DATE_RECEIVED_FOR_REPROCESSING` (YYYY-MM-DD) that monthly report aggregation expects. January data would be absent from the January monthly report (see Finding 3 for the mechanism, and the diagnostics that now surface it).
- **Cancellation reversion**: this is now wrong in the _opposite_ direction to what was first recorded. Because the check keys on status, a cancelled operator (status `cancelled`, not in the active set) flips to quarterly immediately. The business rule is that they should stay monthly for the remainder of the current quarter and revert to quarterly only at the start of the first full non-accredited quarter. There is still no concept of "revert to quarterly after one full non-accredited quarter"; the code now reverts too early rather than never.
- **Suspension**: handled correctly. Suspension keeps the accreditation in the active set, so the check returns monthly for a suspended operator, which matches the business rule that cadence is unchanged during suspension.

There is also no concept of a registration determination date in the system. Pete Spink's clarification (25 March 2026) confirms there is no expectation that operators report data from before their registration or accreditation determination date. The codebase does not enforce this — uploads for dates before accreditation `validFrom` are accepted and simply classified as `IGNORED` by `isWithinAccreditationDateRange`. This is currently sufficient, but the service should be able to support case-by-case exceptions where pre-determination data is requested.

**Assessment**

The cadence logic is significantly under-specified. Implementing the full business rules will require:

- Tracking the accreditation start date to determine which quarter it falls in, so that the correct retroactive monthly periods can be generated.
- Implementing the cancellation reversion rule — a mechanism to detect that one full non-accredited quarter has passed and switch back to quarterly.
- Deciding how to handle historical registered-only data in the context of retroactively monthly periods (see Finding 3).

These are design decisions that go beyond the scope of this spike. A separate story is required.

---

### 5. Report completeness gating

**Business requirement (from team wiki)**

> "Report cannot be created unless all supplier data is complete."

The regulator's preferred option is to prohibit creation or submission of reports where mandatory fields are missing. A second, less desirable option is to warn the user but allow submission. The Defra team has flagged the risk that blocking submission incentivises operators to enter fake data rather than submitting late.

**Mandatory fields per template type**

The wiki specifies which fields are mandatory for each template type:

- **Accredited reprocessor (input/output)**: supplier fields (`SUPPLIER_NAME`, `SUPPLIER_ADDRESS`, `SUPPLIER_POSTCODE`, `SUPPLIER_EMAIL`, `SUPPLIER_PHONE_NUMBER`, `ACTIVITIES_CARRIED_OUT_BY_SUPPLIER`) are mandatory for received-loads rows where `DATE_RECEIVED_FOR_REPROCESSING` falls within the reporting period.
- **Non-accredited reprocessor**: the equivalent supplier fields are mandatory for rows where `MONTH_RECEIVED_FOR_REPROCESSING` falls within the reporting period.
- **Accredited exporter and non-accredited exporter**: mandatory field lists are pending definition (marked "xxxxx" in the wiki).

**Current behaviour**

Report creation (`POST /reports/{year}/{cadence}/{period}` in `src/reports/application/report-service.js`) performs no data completeness check. A report can be created from any waste records, regardless of whether mandatory fields are populated.

The upload-time `classifyForWasteBalance` mechanism in accredited schemas does surface rows with `MISSING_REQUIRED_FIELD` issues on the check page, but this does not block upload or report creation.

Registered-only schemas have no `classifyForWasteBalance`, so sparse rows receive no issue classification at upload time.

**Assessment**

The report completeness requirement is a policy question not yet resolved. The Defra team have flagged the tension between enforcement (risk of fake data) and permissiveness (risk of incomplete data in reports). Until policy is agreed, the current permissive behaviour should be retained. When policy is resolved, the likely implementation is to gate `POST /reports` on whether any waste records for the period have `MISSING_REQUIRED_FIELD` classification outcomes.

---

## Decision

The five findings have materially different risk profiles:

1. **Suspension** — no action required. The system handles this correctly.
2. **Cancellation** — three follow-up items: a policy decision on upload permissions, a minor typedef fix (done — [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040)), and cadence reversion logic (see Finding 4).
3. **Template transition (reg-only to accredited)** — no code change required for the transition mechanics, but historical data is lost from report aggregation after the transition (now surfaced by diagnostics, not yet fixed), and mid-quarter cadence rules are not implemented.
4. **Cadence transition rules** — high complexity. The full business rules (mid-quarter accreditation, cancellation reversion) are not implemented; cancellation currently reverts to quarterly immediately rather than at the start of the first full non-accredited quarter. A separate design story is required before implementation.
5. **Report completeness gating** — policy not yet resolved. No code change until agreed.

## Consequences

The following follow-up tickets are created:

- **Tech / minor bug**: Fix `AccreditationOther` typedef to include `'cancelled'` status. **Done** — implemented in [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040).
- **Policy decision**: Determine whether cancelled accredited operators should be blocked from uploading (no code change until decision is made)
- **Bug / data loss**: Historical registered-only waste records are silently excluded from report aggregation after an operator transitions to accredited, because the accredited operator category looks up a different date field name. Needs design work to decide how pre-transition data should be represented in reports. Diagnostics and warning logging to surface excluded records were added in [epr-backend#1040](https://github.com/DEFRA/epr-backend/pull/1040); the underlying fix still requires a design decision.
- **Story / design spike**: Implement cadence transition rules — mid-quarter accreditation makes the full quarter monthly; cancellation reverts to quarterly only after one full non-accredited quarter. Requires a design decision on how to handle mixed-cadence history in the reporting calendar.
- **Policy decision**: Determine whether report creation should be blocked when mandatory supplier fields are missing. Implement gating on `POST /reports` once policy is agreed.
