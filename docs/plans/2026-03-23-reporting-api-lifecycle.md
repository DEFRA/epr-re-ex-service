# Reporting API Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full report lifecycle API from ADR 0028 — update GET /reports to merge persisted reports, update GET detail to return stored reports, add POST (create) and DELETE (soft-delete) endpoints.

**Architecture:** The existing `GET /reports/calendar` and `GET /reports/{year}/{cadence}/{period}` endpoints only compute data on the fly from waste records. ADR 0028 requires merging with persisted reports from the `periodic-reports` collection, plus new POST and DELETE endpoints. The repository layer (`createReport`, `deleteReport`, `findPeriodicReports`, `findReportById`) is already fully implemented — this plan focuses on the route handlers and domain merge logic.

**Tech Stack:** Hapi.js, MongoDB (via repository pattern), Joi validation, Vitest

**Reference docs:**

- ADR: `docs/architecture/decisions/0028-reporting-api-and-due-rules.md`
- API spec: `docs/architecture/api-definitions/internal-api.yaml`

---

## File Structure

| File                                                                    | Action | Responsibility                                                                   |
| ----------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `lib/epr-backend/src/reports/domain/generate-reporting-periods.js`      | Modify | Add period-ended filter; only include periods where the day after endDate <= now |
| `lib/epr-backend/src/reports/domain/generate-reporting-periods.test.js` | Modify | Update tests for new filter behaviour                                            |
| `lib/epr-backend/src/reports/domain/merge-reporting-periods.js`         | Create | Pure function to merge computed periods with persisted report slots              |
| `lib/epr-backend/src/reports/domain/merge-reporting-periods.test.js`    | Create | Unit tests for merge logic                                                       |
| `lib/epr-backend/src/reports/routes/get.js`                             | Modify | Keep `/reports/calendar` path, add reportsRepository, merge persisted data       |
| `lib/epr-backend/src/reports/routes/get.test.js`                        | Modify | Update tests for new list behaviour with merged reports                          |
| `lib/epr-backend/src/reports/routes/get-detail.js`                      | Modify | Check for stored report before computing on the fly                              |
| `lib/epr-backend/src/reports/routes/get-detail.test.js`                 | Modify | Add tests for stored report retrieval                                            |
| `lib/epr-backend/src/reports/routes/post.js`                            | Create | POST handler — create report                                                     |
| `lib/epr-backend/src/reports/routes/post.test.js`                       | Create | Tests for POST handler                                                           |
| `lib/epr-backend/src/reports/routes/delete.js`                          | Create | DELETE handler — soft-delete report                                              |
| `lib/epr-backend/src/reports/routes/delete.test.js`                     | Create | Tests for DELETE handler                                                         |
| `lib/epr-backend/src/reports/routes/index.js`                           | Modify | Export new route handlers                                                        |
| `lib/epr-backend/src/test/create-test-server.js`                        | Modify | Add reportsRepository to repositoryConfigs                                       |

---

### Task 1: Register reportsRepository in test server

The test server doesn't include `reportsRepository` in its repository configs. All subsequent tasks need this.

**Files:**

- Modify: `lib/epr-backend/src/test/create-test-server.js`

- [ ] **Step 1: Write the failing test**

No new test file needed — the existing test server test verifies plugin registration. We just need to add the import and config entry. First, verify that importing the in-memory plugin works by reading the current imports.

- [ ] **Step 2: Add reportsRepository to create-test-server.js**

Add the import at the top of the file:

```javascript
import { createInMemoryReportsRepositoryPlugin } from '#reports/repository/inmemory.plugin.js'
```

Add to the `repositoryConfigs` array (after the existing entries, before the closing `]`):

```javascript
  {
    name: 'reportsRepository',
    createDefault: createInMemoryReportsRepositoryPlugin
  }
```

This matches the existing pattern — all `createDefault` entries are functions that return a Hapi plugin object.

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `cd lib/epr-backend && npx vitest run src/test/create-test-server.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/epr-backend/src/test/create-test-server.js
git commit -m "feat(reports): register reportsRepository in test server"
```

---

### Task 2: Change period filter to only show ended periods

ADR 0028 says: "The current date is after the last day of the period." The current `generateReportingPeriods` filters by `startDate <= now` (includes the in-progress period). Change to only include periods where the entire last day has passed — i.e., the day after endDate must be <= now.

**Files:**

- Modify: `lib/epr-backend/src/reports/domain/generate-reporting-periods.js:49`
- Test: `lib/epr-backend/src/reports/domain/generate-reporting-periods.test.js`

- [ ] **Step 1: Update the test to expect the new filter behaviour**

In `generate-reporting-periods.test.js`, the test "returns periods up to and including the current month" uses `march20` (2026-03-20). With the new filter, March hasn't ended yet, so only January and February should appear (length 2, not 3).

Update the monthly test:

```javascript
it('returns only periods that have ended', () => {
  const periods = generateReportingPeriods(CADENCE.monthly, 2026, march20)

  expect(periods).toHaveLength(2)
  expect(periods[0].period).toBe(1)
  expect(periods[1].period).toBe(2)
})
```

Similarly update any quarterly tests that assert on length for the current period. A date of March 20 means Q1 (Jan-Mar) hasn't ended, so quarterly should return 0 periods for 2026. If a test uses a date in April, Q1 would be included.

Review all tests in the file and update expected lengths accordingly. The key change: a period is included only when the day after its `endDate` has arrived (the entire last day must have passed).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd lib/epr-backend && npx vitest run src/reports/domain/generate-reporting-periods.test.js`
Expected: FAIL — lengths don't match yet

- [ ] **Step 3: Update the filter in generate-reporting-periods.js**

In `lib/epr-backend/src/reports/domain/generate-reporting-periods.js`, line 49, change:

```javascript
return allPeriods.filter((p) => new Date(p.startDate) <= now)
```

to (ensuring the entire last day has passed — "after the last day" per ADR 0028):

```javascript
return allPeriods.filter((p) => {
  const dayAfterEnd = new Date(p.endDate)
  dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1)
  return dayAfterEnd <= now
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd lib/epr-backend && npx vitest run src/reports/domain/generate-reporting-periods.test.js`
Expected: PASS

- [ ] **Step 5: Fix any broken dependent tests**

The GET /reports/calendar route test (`get.test.js`) asserts on period counts based on the current date. These will need updating to match the new filter. Run the full reports test suite:

Run: `cd lib/epr-backend && npx vitest run src/reports/`
Expected: Fix any failures caused by the filter change.

- [ ] **Step 6: Commit**

```bash
git add lib/epr-backend/src/reports/domain/generate-reporting-periods.js lib/epr-backend/src/reports/domain/generate-reporting-periods.test.js
git commit -m "feat(reports): filter periods to only show ended periods per ADR 0028"
```

---

### Task 3: Create merge-reporting-periods domain function

Pure function that merges computed periods from `generateReportingPeriods()` with persisted periodic-report slots from the repository. This is the core of the new `GET /reports` list behaviour.

**Files:**

- Create: `lib/epr-backend/src/reports/domain/merge-reporting-periods.js`
- Create: `lib/epr-backend/src/reports/domain/merge-reporting-periods.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/epr-backend/src/reports/domain/merge-reporting-periods.test.js`:

```javascript
import { describe, expect, it } from 'vitest'
import { mergeReportingPeriods } from './merge-reporting-periods.js'

describe('mergeReportingPeriods', () => {
  const computedPeriods = [
    {
      year: 2026,
      period: 1,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dueDate: '2026-02-20',
      report: null
    },
    {
      year: 2026,
      period: 2,
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      dueDate: '2026-03-20',
      report: null
    }
  ]

  it('returns computed periods unchanged when no persisted reports exist', () => {
    const result = mergeReportingPeriods(computedPeriods, [], 'monthly')

    expect(result).toHaveLength(2)
    expect(result[0].report).toBeUndefined()
    expect(result[1].report).toBeUndefined()
  })

  it('merges persisted report into matching period', () => {
    const periodicReports = [
      {
        organisationId: 'org-1',
        registrationId: 'reg-1',
        year: 2026,
        version: 1,
        reports: {
          monthly: {
            1: {
              startDate: '2026-01-01',
              endDate: '2026-01-31',
              dueDate: '2026-02-20',
              currentReportId: 'report-uuid-1',
              previousReportIds: []
            }
          }
        }
      }
    ]

    const statusMap = new Map([['report-uuid-1', 'in_progress']])
    const result = mergeReportingPeriods(
      computedPeriods,
      periodicReports,
      'monthly',
      statusMap
    )

    expect(result[0].report).toEqual({
      id: 'report-uuid-1',
      status: 'in_progress'
    })
    expect(result[1].report).toBeUndefined()
  })

  it('excludes report field when currentReportId is null (deleted)', () => {
    const periodicReports = [
      {
        organisationId: 'org-1',
        registrationId: 'reg-1',
        year: 2026,
        version: 1,
        reports: {
          monthly: {
            1: {
              startDate: '2026-01-01',
              endDate: '2026-01-31',
              dueDate: '2026-02-20',
              currentReportId: null,
              previousReportIds: ['old-report-id']
            }
          }
        }
      }
    ]

    const result = mergeReportingPeriods(
      computedPeriods,
      periodicReports,
      'monthly',
      new Map()
    )

    expect(result[0].report).toBeUndefined()
  })

  it('includes persisted periods not in computed set (report exists but no waste records)', () => {
    const periodicReports = [
      {
        organisationId: 'org-1',
        registrationId: 'reg-1',
        year: 2026,
        version: 1,
        reports: {
          monthly: {
            3: {
              startDate: '2026-03-01',
              endDate: '2026-03-31',
              dueDate: '2026-04-20',
              currentReportId: 'report-uuid-3',
              previousReportIds: []
            }
          }
        }
      }
    ]

    const statusMap = new Map([['report-uuid-3', 'in_progress']])
    const result = mergeReportingPeriods(
      computedPeriods,
      periodicReports,
      'monthly',
      statusMap
    )

    expect(result).toHaveLength(3)
    const period3 = result.find((p) => p.period === 3)
    expect(period3.report).toEqual({
      id: 'report-uuid-3',
      status: 'in_progress'
    })
    expect(period3.startDate).toBe('2026-03-01')
  })
})
```

**Note on the `status` field:** The merge function accepts a `reportStatusMap` (`Map<reportId, status>`) that the route handler pre-fetches by looking up each `currentReportId` via `findReportById`. The `periodic-reports` collection only stores `currentReportId`, not the status itself.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lib/epr-backend && npx vitest run src/reports/domain/merge-reporting-periods.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement merge-reporting-periods.js**

Create `lib/epr-backend/src/reports/domain/merge-reporting-periods.js`:

```javascript
/**
 * Merges computed reporting periods with persisted periodic-report slots.
 *
 * - Computed periods come from generateReportingPeriods() (periods with ended dates)
 * - Persisted reports come from reportsRepository.findPeriodicReports()
 * - reportStatusMap maps reportId -> status string (fetched from reports collection)
 *
 * For each period:
 * - If a persisted report exists with a non-null currentReportId, include report: { id, status }
 * - If no persisted report or currentReportId is null, omit the report field
 * - Periods with persisted reports that aren't in the computed set are included
 *   (e.g. waste records deleted but report still exists)
 *
 * @param {Array<{year: number, period: number, startDate: string, endDate: string, dueDate: string}>} computedPeriods
 * @param {import('../repository/port.js').PeriodicReport[]} periodicReports
 * @param {string} cadence
 * @param {Map<string, string>} reportStatusMap - Maps reportId to status
 * @returns {Array<{year: number, period: number, startDate: string, endDate: string, dueDate: string, report?: {id: string, status: string}}>}
 */
export function mergeReportingPeriods(
  computedPeriods,
  periodicReports,
  cadence,
  reportStatusMap = new Map()
) {
  // Build a lookup of persisted slots keyed by "year:period"
  const persistedSlots = new Map()

  for (const pr of periodicReports) {
    const cadenceSlots = pr.reports?.[cadence]
    if (!cadenceSlots) continue

    for (const [periodKey, slot] of Object.entries(cadenceSlots)) {
      const key = `${pr.year}:${periodKey}`
      persistedSlots.set(key, {
        ...slot,
        year: pr.year,
        period: Number(periodKey)
      })
    }
  }

  // Start with computed periods, enriching with persisted data
  const merged = new Map()

  for (const cp of computedPeriods) {
    const key = `${cp.year}:${cp.period}`
    const slot = persistedSlots.get(key)

    const entry = {
      year: cp.year,
      period: cp.period,
      startDate: cp.startDate,
      endDate: cp.endDate,
      dueDate: cp.dueDate
    }

    if (slot?.currentReportId) {
      entry.report = {
        id: slot.currentReportId,
        status: reportStatusMap.get(slot.currentReportId) ?? 'in_progress'
      }
    }

    merged.set(key, entry)
  }

  // Add persisted slots that aren't in computed set (report exists but no waste records)
  for (const [key, slot] of persistedSlots) {
    if (merged.has(key)) continue
    if (!slot.currentReportId) continue

    merged.set(key, {
      year: slot.year,
      period: slot.period,
      startDate: slot.startDate,
      endDate: slot.endDate,
      dueDate: slot.dueDate,
      report: {
        id: slot.currentReportId,
        status: reportStatusMap.get(slot.currentReportId) ?? 'in_progress'
      }
    })
  }

  // Sort by year then period
  return Array.from(merged.values()).sort(
    (a, b) => a.year - b.year || a.period - b.period
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lib/epr-backend && npx vitest run src/reports/domain/merge-reporting-periods.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/epr-backend/src/reports/domain/merge-reporting-periods.js lib/epr-backend/src/reports/domain/merge-reporting-periods.test.js
git commit -m "feat(reports): add mergeReportingPeriods domain function"
```

---

### Task 4: Update GET /reports/calendar list endpoint

Keep the existing `/reports/calendar` path. Add reportsRepository dependency. Merge computed periods with persisted report data.

**Files:**

- Modify: `lib/epr-backend/src/reports/routes/get.js`
- Modify: `lib/epr-backend/src/reports/routes/get.test.js`

- [ ] **Step 1: Update tests for the new behaviour**

In `get.test.js` (path stays as `/reports/calendar`):

1. Update `createServer` to also accept and register a `reportsRepository` with optional pre-seeded data
2. Add test: "includes report object for period with persisted report"
3. Add test: "omits report field for period without persisted report"
4. Add test: "includes persisted report period not in computed set"
5. Update period count assertions (periods now only show ended periods)

Key changes to `createServer`:

```javascript
const createServer = async (
  registrationOverrides = {},
  reportsRepositoryFactory
) => {
  // ... existing org/registration setup ...

  const server = await createTestServer({
    repositories: {
      organisationsRepository: organisationsRepositoryFactory,
      ...(reportsRepositoryFactory && {
        reportsRepository: reportsRepositoryFactory
      })
    },
    featureFlags: createInMemoryFeatureFlags({ reports: true })
  })
  // ...
}
```

New test for merged report:

```javascript
it('includes report object when a persisted report exists', async () => {
  const reportsRepositoryFactory = createInMemoryReportsRepository()
  const { server, organisationId, registrationId } = await createServer(
    { wasteProcessingType: 'exporter', accreditationId: undefined },
    reportsRepositoryFactory
  )

  // Create a report for Q1 2026 via the repository
  const reportsRepository = reportsRepositoryFactory()
  await reportsRepository.createReport({
    organisationId,
    registrationId,
    year: 2026,
    cadence: 'quarterly',
    period: 1,
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    dueDate: '2026-04-20',
    changedBy: { id: 'user-1', name: 'Test', position: 'Officer' }
  })

  const response = await makeRequest(server, organisationId, registrationId)
  const payload = JSON.parse(response.payload)

  const q1 = payload.reportingPeriods.find((p) => p.period === 1)
  expect(q1.report).toBeDefined()
  expect(q1.report.id).toBeDefined()
  expect(q1.report.status).toBe('in_progress')
})
```

Import `createInMemoryReportsRepository` from `#reports/repository/inmemory.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/get.test.js`
Expected: FAIL

- [ ] **Step 3: Update the route handler**

In `get.js`, update the path and handler:

```javascript
import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'

import { ROLES } from '#common/helpers/auth/constants.js'
import { getAuthConfig } from '#common/helpers/auth/get-auth-config.js'
import { CADENCE } from '#reports/domain/cadence.js'
import { generateReportingPeriods } from '#reports/domain/generate-reporting-periods.js'
import { mergeReportingPeriods } from '#reports/domain/merge-reporting-periods.js'

export const reportsGetPath =
  '/v1/organisations/{organisationId}/registrations/{registrationId}/reports/calendar'

export const reportsGet = {
  method: 'GET',
  path: reportsGetPath,
  options: {
    auth: getAuthConfig([ROLES.standardUser]),
    tags: ['api'],
    validate: {
      params: Joi.object({
        organisationId: Joi.string().required(),
        registrationId: Joi.string().required()
      })
    }
  },
  handler: async (request, h) => {
    const { organisationsRepository, reportsRepository, params } = request
    const { organisationId, registrationId } = params

    const registration = await organisationsRepository.findRegistrationById(
      organisationId,
      registrationId
    )

    const isAccredited = Boolean(registration.accreditationId)
    const cadence = isAccredited ? CADENCE.monthly : CADENCE.quarterly

    const currentYear = new Date().getUTCFullYear()
    const computedPeriods = generateReportingPeriods(cadence, currentYear)

    const periodicReports = await reportsRepository.findPeriodicReports({
      organisationId,
      registrationId
    })

    // Build status map for all current report IDs
    const reportIds = []
    for (const pr of periodicReports) {
      const cadenceSlots = pr.reports?.[cadence]
      if (!cadenceSlots) continue
      for (const slot of Object.values(cadenceSlots)) {
        if (slot.currentReportId) {
          reportIds.push(slot.currentReportId)
        }
      }
    }

    const reportStatusMap = new Map()
    for (const reportId of reportIds) {
      try {
        const report = await reportsRepository.findReportById(reportId)
        reportStatusMap.set(reportId, report.status)
      } catch {
        // Report may have been hard-deleted; skip
      }
    }

    const reportingPeriods = mergeReportingPeriods(
      computedPeriods,
      periodicReports,
      cadence,
      reportStatusMap
    )

    return h.response({ cadence, reportingPeriods }).code(StatusCodes.OK)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/get.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/epr-backend/src/reports/routes/get.js lib/epr-backend/src/reports/routes/get.test.js
git commit -m "feat(reports): update GET /reports to merge persisted report data"
```

---

### Task 5: Update GET /reports/{year}/{cadence}/{period} to return stored reports

When a persisted report exists for the requested slot, return the stored snapshot. Otherwise, generate on the fly (current behaviour).

**Files:**

- Modify: `lib/epr-backend/src/reports/routes/get-detail.js`
- Modify: `lib/epr-backend/src/reports/routes/get-detail.test.js`

- [ ] **Step 1: Add tests for stored report retrieval**

In `get-detail.test.js`, add a new describe block. Update `createServer` to accept and register a `reportsRepository`:

```javascript
describe('when a stored report exists', () => {
  it('returns the stored report instead of computing', async () => {
    const reportsRepositoryFactory = createInMemoryReportsRepository()
    const { server, organisationId, registrationId } = await createServer(
      { wasteProcessingType: 'reprocessor', accreditationId: undefined },
      [],
      reportsRepositoryFactory
    )

    const reportsRepository = reportsRepositoryFactory()
    await reportsRepository.createReport({
      organisationId,
      registrationId,
      year: 2026,
      cadence: 'quarterly',
      period: 1,
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      dueDate: '2026-04-20',
      changedBy: { id: 'user-1', name: 'Test', position: 'Officer' },
      material: 'plastic',
      wasteProcessingType: 'reprocessor'
    })

    const response = await makeRequest(server, organisationId, registrationId)
    const payload = JSON.parse(response.payload)

    expect(response.statusCode).toBe(StatusCodes.OK)
    expect(payload.id).toBeDefined()
    expect(payload.status).toBe('in_progress')
    expect(payload.material).toBe('plastic')
  })

  it('returns computed data when no stored report exists', async () => {
    const { server, organisationId, registrationId } = await createServer({
      wasteProcessingType: 'reprocessor',
      accreditationId: undefined
    })

    const response = await makeRequest(server, organisationId, registrationId)
    const payload = JSON.parse(response.payload)

    expect(response.statusCode).toBe(StatusCodes.OK)
    expect(payload.id).toBeUndefined()
    expect(payload.sections).toBeDefined()
  })
})
```

Import `createInMemoryReportsRepository` from `#reports/repository/inmemory.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/get-detail.test.js`
Expected: FAIL

- [ ] **Step 3: Update the handler to check for stored report**

In `get-detail.js`, add reportsRepository access. Before computing the aggregation, check if a stored report exists:

```javascript
handler: async (request, h) => {
  const {
    organisationsRepository,
    wasteRecordsRepository,
    reportsRepository,
    params
  } = request
  const { organisationId, registrationId, year, cadence, period } = params

  const registration = await organisationsRepository.findRegistrationById(
    organisationId,
    registrationId
  )

  // Check for a stored report first
  const periodicReports = await reportsRepository.findPeriodicReports({
    organisationId,
    registrationId
  })

  const periodicReport = periodicReports.find((pr) => pr.year === year)
  const slot = periodicReport?.reports?.[cadence]?.[period]

  if (slot?.currentReportId) {
    const storedReport = await reportsRepository.findReportById(
      slot.currentReportId
    )
    return h
      .response({
        ...storedReport,
        details: {
          material: registration.material,
          site: registration.site
        }
      })
      .code(StatusCodes.OK)
  }

  // No stored report — compute on the fly
  const operatorCategory = getOperatorCategory(registration)

  const wasteRecords = await wasteRecordsRepository.findByRegistration(
    organisationId,
    registrationId
  )

  const report = aggregateReportDetail(wasteRecords, {
    operatorCategory,
    cadence,
    year,
    period
  })

  return h
    .response({
      ...report,
      details: {
        material: registration.material,
        site: registration.site
      }
    })
    .code(StatusCodes.OK)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/get-detail.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/epr-backend/src/reports/routes/get-detail.js lib/epr-backend/src/reports/routes/get-detail.test.js
git commit -m "feat(reports): return stored report when available in GET detail"
```

---

### Task 6: Add POST /reports/{year}/{cadence}/{period} endpoint

Creates a report by generating aggregated data, persisting it via the repository, and returning 201. Returns 409 if a report already exists.

**Files:**

- Create: `lib/epr-backend/src/reports/routes/post.js`
- Create: `lib/epr-backend/src/reports/routes/post.test.js`
- Modify: `lib/epr-backend/src/reports/routes/index.js`

- [ ] **Step 1: Write the failing test**

Create `lib/epr-backend/src/reports/routes/post.test.js`:

```javascript
import { ObjectId } from 'mongodb'
import { StatusCodes } from 'http-status-codes'
import { createTestServer } from '#test/create-test-server.js'
import { asStandardUser } from '#test/inject-auth.js'
import { setupAuthContext } from '#vite/helpers/setup-auth-mocking.js'
import { createInMemoryFeatureFlags } from '#feature-flags/feature-flags.inmemory.js'
import { createInMemoryOrganisationsRepository } from '#repositories/organisations/inmemory.js'
import { createInMemoryWasteRecordsRepository } from '#repositories/waste-records/inmemory.js'
import { createInMemoryReportsRepository } from '#reports/repository/inmemory.js'
import {
  buildOrganisation,
  buildRegistration
} from '#repositories/organisations/contract/test-data.js'

describe('POST /v1/organisations/{organisationId}/registrations/{registrationId}/reports/{year}/{cadence}/{period}', () => {
  setupAuthContext()

  const makeUrl = (orgId, regId, year, cadence, period) =>
    `/v1/organisations/${orgId}/registrations/${regId}/reports/${year}/${cadence}/${period}`

  describe('when feature flag is enabled', () => {
    const createServer = async (registrationOverrides = {}) => {
      const registration = buildRegistration(registrationOverrides)
      const org = buildOrganisation({ registrations: [registration] })

      const organisationsRepositoryFactory =
        createInMemoryOrganisationsRepository()
      const organisationsRepository = organisationsRepositoryFactory()
      await organisationsRepository.insert(org)

      const wasteRecordsRepositoryFactory =
        createInMemoryWasteRecordsRepository([])
      const reportsRepositoryFactory = createInMemoryReportsRepository()

      const server = await createTestServer({
        repositories: {
          organisationsRepository: organisationsRepositoryFactory,
          wasteRecordsRepository: wasteRecordsRepositoryFactory,
          reportsRepository: reportsRepositoryFactory
        },
        featureFlags: createInMemoryFeatureFlags({ reports: true })
      })

      return {
        server,
        organisationId: org.id,
        registrationId: registration.id,
        reportsRepositoryFactory
      }
    }

    const makeRequest = (
      server,
      orgId,
      regId,
      year = 2026,
      cadence = 'quarterly',
      period = 1
    ) =>
      server.inject({
        method: 'POST',
        url: makeUrl(orgId, regId, year, cadence, period),
        ...asStandardUser({ linkedOrgId: orgId })
      })

    it('returns 201 with created report', async () => {
      const { server, organisationId, registrationId } = await createServer({
        wasteProcessingType: 'reprocessor',
        accreditationId: undefined
      })

      const response = await makeRequest(server, organisationId, registrationId)

      expect(response.statusCode).toBe(StatusCodes.CREATED)
      const payload = JSON.parse(response.payload)
      expect(payload.id).toBeDefined()
      expect(payload.status).toBe('in_progress')
    })

    it('returns 409 when report already exists', async () => {
      const { server, organisationId, registrationId } = await createServer({
        wasteProcessingType: 'reprocessor',
        accreditationId: undefined
      })

      await makeRequest(server, organisationId, registrationId)
      const response = await makeRequest(server, organisationId, registrationId)

      expect(response.statusCode).toBe(StatusCodes.CONFLICT)
    })

    it('returns 400 when period has not yet ended', async () => {
      const { server, organisationId, registrationId } = await createServer({
        wasteProcessingType: 'reprocessor',
        accreditationId: undefined
      })

      // Use a far-future period that hasn't ended
      const response = await makeRequest(
        server,
        organisationId,
        registrationId,
        2099,
        'quarterly',
        1
      )

      expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('returns 404 when registration not found', async () => {
      const { server, organisationId } = await createServer()
      const unknownRegId = new ObjectId().toString()

      const response = await makeRequest(server, organisationId, unknownRegId)

      expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
    })
  })

  describe('when feature flag is disabled', () => {
    it('returns 404', async () => {
      const organisationId = new ObjectId().toString()
      const registrationId = new ObjectId().toString()

      const server = await createTestServer({
        repositories: {},
        featureFlags: createInMemoryFeatureFlags({ reports: false })
      })

      const response = await server.inject({
        method: 'POST',
        url: makeUrl(organisationId, registrationId, 2026, 'quarterly', 1),
        ...asStandardUser({ linkedOrgId: organisationId })
      })

      expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/post.test.js`
Expected: FAIL — route not found (404 for all)

- [ ] **Step 3: Implement the POST route handler**

Create `lib/epr-backend/src/reports/routes/post.js`:

```javascript
import Boom from '@hapi/boom'
import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'

import { ROLES } from '#common/helpers/auth/constants.js'
import { getAuthConfig } from '#common/helpers/auth/get-auth-config.js'
import { getOperatorCategory } from '#reports/domain/operator-category.js'
import { aggregateReportDetail } from '#reports/domain/aggregate-report-detail.js'
import { generateReportingPeriods } from '#reports/domain/generate-reporting-periods.js'
import { cadenceSchema, periodSchema } from '#reports/repository/schema.js'

const MIN_YEAR = 2024
const MAX_YEAR = 2100

export const reportsPostPath =
  '/v1/organisations/{organisationId}/registrations/{registrationId}/reports/{year}/{cadence}/{period}'

export const reportsPost = {
  method: 'POST',
  path: reportsPostPath,
  options: {
    auth: getAuthConfig([ROLES.standardUser]),
    tags: ['api'],
    validate: {
      params: Joi.object({
        organisationId: Joi.string().required(),
        registrationId: Joi.string().required(),
        year: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).required(),
        cadence: cadenceSchema,
        period: periodSchema
      })
    }
  },
  handler: async (request, h) => {
    const {
      organisationsRepository,
      wasteRecordsRepository,
      reportsRepository,
      params
    } = request
    const { organisationId, registrationId, year, cadence, period } = params

    const registration = await organisationsRepository.findRegistrationById(
      organisationId,
      registrationId
    )

    // Check if a report already exists for this slot
    const periodicReports = await reportsRepository.findPeriodicReports({
      organisationId,
      registrationId
    })

    const periodicReport = periodicReports.find((pr) => pr.year === year)
    const slot = periodicReport?.reports?.[cadence]?.[period]

    if (slot?.currentReportId) {
      throw Boom.conflict(
        `Report already exists for ${cadence} period ${period} of ${year}`
      )
    }

    // Compute period dates — use far-future date to get all periods for the year
    const allPeriods = generateReportingPeriods(
      cadence,
      year,
      new Date('2099-12-31')
    )
    const periodInfo = allPeriods.find((p) => p.period === period)

    if (!periodInfo) {
      throw Boom.badRequest(`Invalid period ${period} for cadence ${cadence}`)
    }

    const { startDate, endDate, dueDate } = periodInfo

    // ADR 0028 Rule 3: period must have ended before a report can be created
    const dayAfterEnd = new Date(endDate)
    dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1)
    if (dayAfterEnd > new Date()) {
      throw Boom.badRequest(
        `Cannot create report for period ${period} — period has not yet ended`
      )
    }

    // Generate the aggregated data
    const operatorCategory = getOperatorCategory(registration)
    const wasteRecords = await wasteRecordsRepository.findByRegistration(
      organisationId,
      registrationId
    )

    const aggregated = aggregateReportDetail(wasteRecords, {
      operatorCategory,
      cadence,
      year,
      period
    })

    const changedBy = {
      id: request.auth.credentials.id,
      name: request.auth.credentials.name ?? request.auth.credentials.email,
      position: request.auth.credentials.position ?? 'User'
    }

    // Persist the report
    const reportId = await reportsRepository.createReport({
      organisationId,
      registrationId,
      year,
      cadence,
      period,
      startDate,
      endDate,
      dueDate,
      changedBy,
      material: registration.material,
      wasteProcessingType: registration.wasteProcessingType,
      siteAddress: registration.site?.address,
      recyclingActivity: aggregated.sections.wasteReceived
        ? {
            suppliers: aggregated.sections.wasteReceived.suppliers,
            totalTonnageReceived:
              aggregated.sections.wasteReceived.totalTonnage,
            tonnageRecycled: 0,
            tonnageNotRecycled: 0
          }
        : undefined,
      exportActivity: aggregated.sections.wasteExported
        ? {
            overseasSites: aggregated.sections.wasteExported.overseasSites,
            totalTonnageReceivedForExporting:
              aggregated.sections.wasteExported.totalTonnage,
            tonnageReceivedNotExported: 0
          }
        : undefined,
      wasteSent: aggregated.sections.wasteSentOn
        ? {
            tonnageSentToReprocessor:
              aggregated.sections.wasteSentOn.toReprocessors,
            tonnageSentToExporter: aggregated.sections.wasteSentOn.toExporters,
            tonnageSentToAnotherSite:
              aggregated.sections.wasteSentOn.toOtherSites,
            finalDestinations: aggregated.sections.wasteSentOn.destinations
          }
        : undefined
    })

    const createdReport = await reportsRepository.findReportById(reportId)

    return h
      .response({
        ...createdReport,
        details: {
          material: registration.material,
          site: registration.site
        }
      })
      .code(StatusCodes.CREATED)
  }
}
```

**Implementation notes:**

- The `changedBy` is derived from `request.auth.credentials`. The credentials have `id` and `email` (from `inject-auth.js`). The `name` may not always be present, so fall back to `email`. The `position` field may not be in credentials — default to `'User'`.
- The mapping from aggregated sections to the repository's `CreateReportParams` shape may need adjustment based on the exact field names. Review `port.js` typedefs to ensure alignment.
- `generateReportingPeriods` is called with a far-future date to get all periods for the year (we need the dates, not the filter).

- [ ] **Step 4: Export the new route in index.js**

Update `lib/epr-backend/src/reports/routes/index.js`:

```javascript
export { reportsGet } from './get.js'
export { reportsGetDetail } from './get-detail.js'
export { reportsPost } from './post.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/post.test.js`
Expected: PASS

- [ ] **Step 6: Run all reports tests**

Run: `cd lib/epr-backend && npx vitest run src/reports/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/epr-backend/src/reports/routes/post.js lib/epr-backend/src/reports/routes/post.test.js lib/epr-backend/src/reports/routes/index.js
git commit -m "feat(reports): add POST endpoint to create reports"
```

---

### Task 7: Add DELETE /reports/{year}/{cadence}/{period} endpoint

Soft-deletes a report by setting status to `deleted`, archiving the currentReportId, and clearing the slot. Returns 204 on success, 404 if no report exists.

**Files:**

- Create: `lib/epr-backend/src/reports/routes/delete.js`
- Create: `lib/epr-backend/src/reports/routes/delete.test.js`
- Modify: `lib/epr-backend/src/reports/routes/index.js`

- [ ] **Step 1: Write the failing test**

Create `lib/epr-backend/src/reports/routes/delete.test.js`:

```javascript
import { ObjectId } from 'mongodb'
import { StatusCodes } from 'http-status-codes'
import { createTestServer } from '#test/create-test-server.js'
import { asStandardUser } from '#test/inject-auth.js'
import { setupAuthContext } from '#vite/helpers/setup-auth-mocking.js'
import { createInMemoryFeatureFlags } from '#feature-flags/feature-flags.inmemory.js'
import { createInMemoryOrganisationsRepository } from '#repositories/organisations/inmemory.js'
import { createInMemoryReportsRepository } from '#reports/repository/inmemory.js'
import {
  buildOrganisation,
  buildRegistration
} from '#repositories/organisations/contract/test-data.js'

describe('DELETE /v1/organisations/{organisationId}/registrations/{registrationId}/reports/{year}/{cadence}/{period}', () => {
  setupAuthContext()

  const makeUrl = (orgId, regId, year, cadence, period) =>
    `/v1/organisations/${orgId}/registrations/${regId}/reports/${year}/${cadence}/${period}`

  describe('when feature flag is enabled', () => {
    const createServer = async (registrationOverrides = {}) => {
      const registration = buildRegistration(registrationOverrides)
      const org = buildOrganisation({ registrations: [registration] })

      const organisationsRepositoryFactory =
        createInMemoryOrganisationsRepository()
      const organisationsRepository = organisationsRepositoryFactory()
      await organisationsRepository.insert(org)

      const reportsRepositoryFactory = createInMemoryReportsRepository()

      const server = await createTestServer({
        repositories: {
          organisationsRepository: organisationsRepositoryFactory,
          reportsRepository: reportsRepositoryFactory
        },
        featureFlags: createInMemoryFeatureFlags({ reports: true })
      })

      return {
        server,
        organisationId: org.id,
        registrationId: registration.id,
        reportsRepositoryFactory
      }
    }

    const makeDeleteRequest = (
      server,
      orgId,
      regId,
      year = 2026,
      cadence = 'quarterly',
      period = 1
    ) =>
      server.inject({
        method: 'DELETE',
        url: makeUrl(orgId, regId, year, cadence, period),
        ...asStandardUser({ linkedOrgId: orgId })
      })

    it('returns 204 when report is deleted', async () => {
      const {
        server,
        organisationId,
        registrationId,
        reportsRepositoryFactory
      } = await createServer({
        wasteProcessingType: 'reprocessor',
        accreditationId: undefined
      })

      // First create a report
      const reportsRepository = reportsRepositoryFactory()
      await reportsRepository.createReport({
        organisationId,
        registrationId,
        year: 2026,
        cadence: 'quarterly',
        period: 1,
        startDate: '2026-01-01',
        endDate: '2026-03-31',
        dueDate: '2026-04-20',
        changedBy: { id: 'user-1', name: 'Test', position: 'Officer' }
      })

      const response = await makeDeleteRequest(
        server,
        organisationId,
        registrationId
      )

      expect(response.statusCode).toBe(StatusCodes.NO_CONTENT)
    })

    it('returns 404 when no report exists for period', async () => {
      const { server, organisationId, registrationId } = await createServer({
        wasteProcessingType: 'reprocessor',
        accreditationId: undefined
      })

      const response = await makeDeleteRequest(
        server,
        organisationId,
        registrationId
      )

      expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
    })
  })

  describe('when feature flag is disabled', () => {
    it('returns 404', async () => {
      const organisationId = new ObjectId().toString()
      const registrationId = new ObjectId().toString()

      const server = await createTestServer({
        repositories: {},
        featureFlags: createInMemoryFeatureFlags({ reports: false })
      })

      const response = await server.inject({
        method: 'DELETE',
        url: makeUrl(organisationId, registrationId, 2026, 'quarterly', 1),
        ...asStandardUser({ linkedOrgId: organisationId })
      })

      expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/delete.test.js`
Expected: FAIL — route not found

- [ ] **Step 3: Implement the DELETE route handler**

Create `lib/epr-backend/src/reports/routes/delete.js`:

```javascript
import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'

import { ROLES } from '#common/helpers/auth/constants.js'
import { getAuthConfig } from '#common/helpers/auth/get-auth-config.js'
import { cadenceSchema, periodSchema } from '#reports/repository/schema.js'

const MIN_YEAR = 2024
const MAX_YEAR = 2100

export const reportsDeletePath =
  '/v1/organisations/{organisationId}/registrations/{registrationId}/reports/{year}/{cadence}/{period}'

export const reportsDelete = {
  method: 'DELETE',
  path: reportsDeletePath,
  options: {
    auth: getAuthConfig([ROLES.standardUser]),
    tags: ['api'],
    validate: {
      params: Joi.object({
        organisationId: Joi.string().required(),
        registrationId: Joi.string().required(),
        year: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).required(),
        cadence: cadenceSchema,
        period: periodSchema
      })
    }
  },
  handler: async (request, h) => {
    const { organisationsRepository, reportsRepository, params } = request
    const { organisationId, registrationId, year, cadence, period } = params

    // Validate registration exists (authorization check)
    await organisationsRepository.findRegistrationById(
      organisationId,
      registrationId
    )

    const changedBy = {
      id: request.auth.credentials.id,
      name: request.auth.credentials.name ?? request.auth.credentials.email,
      position: request.auth.credentials.position ?? 'User'
    }

    await reportsRepository.deleteReport({
      organisationId,
      registrationId,
      year,
      cadence,
      period,
      changedBy
    })

    return h.response().code(StatusCodes.NO_CONTENT)
  }
}
```

- [ ] **Step 4: Export the new route in index.js**

Update `lib/epr-backend/src/reports/routes/index.js`:

```javascript
export { reportsGet } from './get.js'
export { reportsGetDetail } from './get-detail.js'
export { reportsPost } from './post.js'
export { reportsDelete } from './delete.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd lib/epr-backend && npx vitest run src/reports/routes/delete.test.js`
Expected: PASS

- [ ] **Step 6: Run all reports tests**

Run: `cd lib/epr-backend && npx vitest run src/reports/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/epr-backend/src/reports/routes/delete.js lib/epr-backend/src/reports/routes/delete.test.js lib/epr-backend/src/reports/routes/index.js
git commit -m "feat(reports): add DELETE endpoint to soft-delete reports"
```

---

### Task 8: Final integration verification

Run the full test suite and verify all 4 endpoints work together.

**Files:** None (verification only)

- [ ] **Step 1: Run all reports tests**

Run: `cd lib/epr-backend && npx vitest run src/reports/`
Expected: All PASS

- [ ] **Step 2: Run full backend test suite**

Run: `cd lib/epr-backend && npx vitest run`
Expected: All PASS (no regressions from filter change)

- [ ] **Step 3: Verify all 4 routes are registered**

Grep for route paths to confirm all endpoints are registered:

```bash
grep -r "reportsGet\|reportsPost\|reportsDelete\|reportsGetDetail" lib/epr-backend/src/reports/routes/index.js
```

Expected: All 4 exports present.

- [ ] **Step 4: Commit any final fixes**

If any tests broke, fix and commit.
