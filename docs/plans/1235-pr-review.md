# PAE-1235 PR Review — `PAE-1235-reporting-api-lifecycle`

**Date:** 2026-03-24
**Reviewers:** Duncan, Claude
**Branch:** `PAE-1235-reporting-api-lifecycle` (backend)

---

## Section 1: Duncan's Observations

### D1 — Domain logic in route handlers

The detail route handler contains repository navigation and conditional branching (`findPeriodicReports` → `findCurrentReportId` → `findReportById`) that constitutes domain/application logic. The `findCurrentReportId` utility sits in `routes/shared.js` despite being a domain concern — it navigates the periodic-reports slot structure, which is repository-internal knowledge.

**Comparison:** The PRN module places equivalent orchestration in an application layer (`application/update-status.js`). Routes stay thin.

### D2 — Redundant repository queries

Both the detail and list handlers make multiple sequential repository calls where one should suffice: `findPeriodicReports` to locate the slot, then `findReportById` to fetch the report. A single repository method (e.g. `findReportForPeriod(org, reg, year, cadence, period)`) would encapsulate the slot navigation and return the report directly.

### D3 — `FAR_FUTURE` workaround (`post.js:15`)

```javascript
const allPeriods = generateReportingPeriods(cadence, year, FAR_FUTURE)
const periodInfo = allPeriods.find((p) => p.period === period)
```

`generateReportingPeriods` was designed to filter by current date (for the list endpoint). The POST route defeats this filter with a far-future date to access all periods. A cleaner approach: extract `generateAllPeriodsForYear(cadence, year)` without date filtering, and have `generateReportingPeriods` call it internally.

### D4 — Conflict check via `findCurrentReportId` (`post.js:145`)

```javascript
if (findCurrentReportId(periodicReports, year, cadence, period)) {
  throw Boom.conflict(...)
}
```

The function name suggests a lookup, but the intent is an existence check. Either rename to express intent (e.g. `reportExistsForPeriod`) or push the conflict check into the repository — `createReport` could enforce uniqueness and throw the conflict itself.

### D5 — Create-then-read pattern (`post.js:164-177`)

```javascript
const reportId = await reportsRepository.createReport({ ... })
const createdReport = await reportsRepository.findReportById(reportId)
```

Two database operations where one should suffice. The PRN module's `create()` returns the full object directly. The reports `createReport()` returns only the ID, forcing a read-back. The repository should be updated to return the full created report, matching the established pattern.

### D6 — `buildReportData` placement (`post.js:79-105`)

This function maps computed aggregation data into the persistence model shape. It's a data transformation concern that belongs in the domain or application layer, not in a route handler. The route should delegate to a service that handles period validation, aggregation, mapping, and persistence.

---

## Section 2: Claude's Observations

### C1 — Detail endpoint returns two incompatible response shapes ⚠️ _overlaps D1_

The ADR states: "Returns the same shape in both cases." The implementation returns the computed shape (`sections.wasteReceived`, `sections.wasteSentOn`) when no report exists, and the raw persistence model (`recyclingActivity`, `wasteSent`) when a stored report exists. Different field names, different structure, different nesting.

The computed shape is the stronger API contract: it groups data under `sections`, uses names aligned with GOV.UK page headings, and is what the frontend currently consumes. The persistence model can include additional fields (manual entry values for accredited operators) but these can be added as optional fields within the existing structure.

**Recommendation:** Add a `mapStoredReportToResponse` function in the GET handler that normalises stored reports back to the computed shape. Nest report metadata under a `report` key.

### C2 — Breaking change to `generateReportingPeriods` filter ⚠️ _partially overlaps D3_

Filter changed from `startDate <= now` to `dayAfterEnd <= now`. On March 20 with monthly cadence, the list goes from 3 periods to 2 (current month excluded). This aligns with the ADR but is backward-incompatible with the current frontend. Deploying this backend change independently will cause the current month to disappear from the list.

### C3 — N+1 query in list endpoint (`get.js:47-54`) ⚠️ _overlaps D2_

```javascript
await Promise.all(
  reportIds.map(async (reportId) => {
    const report = await reportsRepository.findReportById(reportId)
    reportStatusMap.set(reportId, report.status)
  })
)
```

For monthly cadence with reports on all 12 periods, this makes 12 separate `findReportById` calls. Consider a batch method or storing status on the periodic-report slot.

### C4 — `FAR_FUTURE` hack ⚠️ _same as D3_

Covered in D3.

### C5 — Manual entry fields initialised to 0 (`post.js:87-88`)

```javascript
tonnageRecycled: 0,
tonnageNotRecycled: 0
```

Zero means "0 tonnes recycled". Null means "not yet entered". These are semantically different and will matter when the frontend distinguishes "operator entered 0" from "not yet entered". Initialise to `null`.

### C6 — POST test doesn't verify response shape (`post.test.js:76-79`)

Tests check `payload.id`, `payload.status`, `payload.details` but not the data sections or field names. The shape divergence (C1) is not visible in the test suite.

### C7 — `extractChangedBy` defaults position to `'User'` (`shared.js:58`)

Minor. The string `'User'` appears in the audit trail. Worth confirming this is the intended default.

### C8 — `c8 ignore` comment (`get.js:36`)

Coverage ignore on an optional chain fallback that "never hits". If it never hits, the optional chain isn't needed. If it is needed, it should be tested.

### C9 — Detail test for stored report is thin (`get-detail.test.js:849-873`)

Only asserts `payload.id`, `payload.status`, `payload.material`, `payload.details`. Doesn't verify the data sections, so the shape divergence (C1) isn't caught by tests.

---

## Overlap Summary

| Duncan | Claude | Topic                                              |
| ------ | ------ | -------------------------------------------------- |
| D1     | C1     | Domain logic in routes / response shape divergence |
| D2     | C3     | Redundant/N+1 repository queries                   |
| D3     | C2, C4 | `FAR_FUTURE` hack / period filter breaking change  |
| D4     | —      | Conflict check naming/placement                    |
| D5     | —      | Create-then-read anti-pattern                      |
| D6     | —      | `buildReportData` placement                        |
| —      | C5     | Manual entry fields initialised to 0               |
| —      | C6, C9 | Thin test coverage on response shape               |
| —      | C7     | `extractChangedBy` default position                |
| —      | C8     | `c8 ignore` comment                                |

---

## Verdict

**Not ready to approve.** The branch introduces solid foundations — `mergeReportingPeriods` is well designed with thorough tests, the POST validation logic is sound, and the shared utilities are a good extraction. However, several issues need addressing before merge:

**Must fix:**

- **Response shape consistency (C1)** — The detail endpoint must return the same shape regardless of whether data is computed or stored. This is the most impactful issue.
- **Create-then-read pattern (D5)** — `createReport` should return the full object, matching the PRN `create()` pattern.

**Should fix:**

- **Route handler weight (D1, D6)** — Extract orchestration into a domain/application service. Routes should delegate, not orchestrate.
- **Repository encapsulation (D2, C3)** — Add a `findReportForPeriod` method to eliminate slot navigation in route handlers and reduce query count.
- **`FAR_FUTURE` workaround (D3)** — Extract `generateAllPeriodsForYear` to eliminate the hack.
- **Backward compatibility (C2)** — The period filter change needs coordinating with a frontend update or a backward-compatible approach.
- **Null vs zero for manual fields (C5)** — Initialise to `null`, not `0`.

**Nice to fix:**

- Conflict check naming (D4), thin tests (C6/C9), `extractChangedBy` default (C7), `c8 ignore` (C8).
