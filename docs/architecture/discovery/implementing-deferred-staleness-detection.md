# Implementing Deferred Staleness Detection

This document guides developers through implementing the simplified "deferred staleness detection" design for summary log preview integrity. It assumes familiarity with [Summary Log Preview Integrity](./summary-log-preview-integrity.md).

## Overview

The existing implementation uses eager superseding and upload blocking. We're replacing this with a simpler approach:

| What changes            | From                    | To                          |
| ----------------------- | ----------------------- | --------------------------- |
| Upload blocking         | Block during submission | Never block                 |
| Superseding             | On upload               | Never                       |
| Staleness detection     | State transition        | Runtime check at submission |
| Multiple validated logs | Not allowed             | Allowed                     |

## Current State (Post-PAE-753)

Following PAE-753 "Defer Summary Log creation until file upload completes":

- Summary logs are created when the CDP callback arrives, not at upload initiation
- Upload initiation calls `checkForSubmittingLog()` to block uploads during submission
- CDP callback supersedes pending logs and creates the new summary log

## Summary of Changes

### Repository Contract: Remove

- [ ] `supersedePendingLogs(organisationId, registrationId, excludeId)` - no longer needed
- [ ] `checkForSubmittingLog(organisationId, registrationId)` - no longer needed

### Repository Contract: Add

- [ ] `findLatestSubmittedForOrgReg(organisationId, registrationId)` - find the most recently submitted log
- [ ] `transitionToSubmittingExclusive(logId, version, organisationId, registrationId)` - atomically transition to submitting, failing if another log for the same org/reg is already submitting

### Schema: Add

- [ ] `validatedAgainstLogId` field on summary log - tracks which submission the preview was generated against

### Routes: Modify

- [ ] Upload initiation (`summary-logs/post.js`): remove blocking check
- [ ] CDP callback (`upload-completed/post.js`): remove supersede logic, record baseline
- [ ] Confirm endpoint (`submit/post.js`): add staleness check and concurrent submission handling

### State Machine: Modify

- [ ] Remove `superseded` transitions from upload/validation flow (state can remain for backwards compatibility)

---

## Implementation Steps

### 1. Update Repository Contract

Update the repository port to reflect the new interface:

```javascript
// src/repositories/summary-logs/port.js

/**
 * @typedef {Object} SummaryLogsRepository
 * @property {(id: string, summaryLog: Object) => Promise<void>} insert
 * @property {(id: string, version: number, summaryLog: Object) => Promise<void>} update
 * @property {(id: string) => Promise<SummaryLogVersion|null>} findById
 * @property {(organisationId: string, registrationId: string) => Promise<SummaryLogVersion|null>} findLatestSubmittedForOrgReg
 * @property {(logId: string, version: number, organisationId: string, registrationId: string) => Promise<{success: boolean, summaryLog?: Object, version?: number}>} transitionToSubmittingExclusive
 */
```

**Removed:**

- `supersedePendingLogs` - no longer superseding logs
- `checkForSubmittingLog` - no longer blocking uploads

**Added:**

- `findLatestSubmittedForOrgReg` - returns the most recently submitted log for staleness checking
- `transitionToSubmittingExclusive` - atomically transitions to `submitting` only if no other log for the same org/reg is already submitting. Returns `{success: true, summaryLog, version}` if transitioned, `{success: false}` if blocked by another submission. Throws if log not found or not in `validated` status.

### 2. Add `validatedAgainstLogId` to Schema

Add a new field to track which submission state the preview was generated against.

```javascript
// In summary log schema validation
{
  // ... existing fields
  validatedAgainstLogId: Joi.string().allow(null).optional()
}
```

**Why**: This field records the ID of the last submitted summary log at the time the summary log was created. If this changes before confirmation, the preview is stale.

### 3. Implement New Repository Methods

Each repository adapter (MongoDB, in-memory, etc.) must implement the new methods.

#### `findLatestSubmittedForOrgReg`

Returns the most recently submitted summary log for an organisation/registration pair, or `null` if none exists.

**Contract behaviour:**

- Filter by `organisationId`, `registrationId`, and `status = 'submitted'`
- Sort by submission time (most recent first)
- Return the first match, or `null`

#### `transitionToSubmittingExclusive`

Atomically transitions a summary log to `submitting` status, but only if no other log for the same organisation/registration pair is already submitting. This prevents concurrent submissions.

**Contract behaviour:**

- Verify the log exists and is in `validated` status (throw if not)
- Check if any other log for the same org/reg is in `submitting` status
- If another is submitting: return `{success: false}`
- If none submitting: transition to `submitting` and return `{success: true, summaryLog, version}`
- The check and transition must be atomic (no race window)

**Implementation notes:**

- MongoDB: Use a transaction, or a unique partial index on `(organisationId, registrationId)` where `status = 'submitting'`
- In-memory: Use a simple check-and-set with appropriate locking

### 4. Remove Old Repository Methods

Remove `supersedePendingLogs` and `checkForSubmittingLog` from:

- Repository port (`port.js`)
- Contract tests (`port.contract.js`)
- All adapters (MongoDB, in-memory)

### 5. Update Upload Initiation

**File**: `src/routes/v1/organisations/registrations/summary-logs/post.js`

**Remove** the call to `checkForSubmittingLog()`. Uploads should never be blocked.

```javascript
// REMOVE this code
await summaryLogsRepository.checkForSubmittingLog(
  organisationId,
  registrationId
)
```

### 6. Update CDP Callback

**File**: `src/routes/v1/organisations/registrations/summary-logs/upload-completed/post.js`

#### Remove supersede logic

**Remove** the entire `handlePendingLogsOnValidation` function and its call. Multiple validated logs can now coexist.

#### Record baseline at creation

When creating the summary log, record the current submission baseline:

```javascript
// Before inserting the summary log, find the latest submitted log
const latestSubmitted =
  await summaryLogsRepository.findLatestSubmittedForOrgReg(
    organisationId,
    registrationId
  )

const summaryLog = {
  // ... existing fields
  validatedAgainstLogId: latestSubmitted?.summaryLog?._id ?? null
}

await summaryLogsRepository.insert(summaryLogId, summaryLog)
```

**Note**: The baseline is recorded at summary log creation time, which happens when the CDP callback arrives with a successful scan result.

### 7. Update Confirm Endpoint

**File**: `src/routes/v1/organisations/registrations/summary-logs/submit/post.js`

This is the most significant change. The confirm endpoint must:

1. Atomically transition to `submitting` (fails if another submission in progress)
2. Check staleness (compare `validatedAgainstLogId` to current latest)
3. Revert if staleness check fails

```javascript
async function confirmSummaryLog(
  summaryLogsRepository,
  logId,
  organisationId,
  registrationId
) {
  // Step 1: Atomically transition to submitting
  // This fails if another log for the same org/reg is already submitting
  const result = await summaryLogsRepository.transitionToSubmittingExclusive(
    logId,
    version,
    organisationId,
    registrationId
  )

  if (!result.success) {
    throw Boom.conflict('Another submission is in progress. Please try again.')
  }

  const { summaryLog, version: newVersion } = result

  try {
    // Step 2: Check staleness
    const currentLatest =
      await summaryLogsRepository.findLatestSubmittedForOrgReg(
        organisationId,
        registrationId
      )

    const baseline = summaryLog.validatedAgainstLogId ?? null
    const current = currentLatest?.summaryLog?._id ?? null

    if (baseline !== current) {
      throw Boom.conflict(
        'Waste records have changed since preview was generated. Please re-upload.'
      )
    }

    // Step 3: Proceed with submission (delegate to worker)
    return { proceed: true }
  } catch (error) {
    // Step 4: Revert to validated on staleness failure
    await summaryLogsRepository.update(logId, newVersion, {
      ...summaryLog,
      status: 'validated'
    })
    throw error
  }
}
```

### 8. Optional: Add Staleness Indicator to GET

For better UX, indicate staleness when the user views a summary log.

**File**: `src/routes/v1/organisations/registrations/summary-logs/get.js`

```javascript
async function getSummaryLog(
  summaryLogsRepository,
  logId,
  organisationId,
  registrationId
) {
  const existing = await summaryLogsRepository.findById(logId)

  if (!existing || existing.summaryLog.status !== 'validated') {
    return existing
  }

  // Check if preview is stale
  const currentLatest =
    await summaryLogsRepository.findLatestSubmittedForOrgReg(
      organisationId,
      registrationId
    )

  const baseline = existing.summaryLog.validatedAgainstLogId ?? null
  const current = currentLatest?.summaryLog?._id ?? null
  const isStale = baseline !== current

  return {
    ...existing,
    isStale
  }
}
```

The frontend can then display a warning if `isStale` is true.

---

## Contract Tests

Update the repository contract tests to cover the new methods:

### `findLatestSubmittedForOrgReg`

1. Returns `null` when no submitted logs exist
2. Returns the submitted log when one exists
3. Returns the most recent when multiple submitted logs exist
4. Only returns logs for the specified org/reg pair
5. Does not return logs in other statuses (validated, submitting, etc.)

### `transitionToSubmittingExclusive`

1. Returns `{success: true, summaryLog, version}` when no other log is submitting
2. Returns `{success: false}` when another log for same org/reg is already submitting
3. Throws when log not found
4. Throws when log is not in `validated` status
5. Only considers logs for the specified org/reg pair (different org/reg can submit concurrently)
6. Updates the log's version on successful transition
7. Handles concurrent calls correctly (only one succeeds)

### Remove old contract tests

- Remove tests for `supersedePendingLogs`
- Remove tests for `checkForSubmittingLog`

---

## Testing Considerations

### Scenarios to Test

1. **Happy path**: Upload → validate → confirm → success
2. **Stale preview**: User A confirms while User B has a validated preview → User B's confirm fails with staleness error
3. **Concurrent confirms (different logs)**: Two users confirm simultaneously → `transitionToSubmittingExclusive` ensures only one succeeds, other gets "another submission in progress"
4. **Concurrent confirms (same log)**: Two tabs confirm same log → one succeeds, one fails (log no longer in `validated` status)
5. **Upload during submission**: User uploads while another submission in progress → upload succeeds, preview generated, confirm fails (stale)
6. **First submission for org/reg**: `validatedAgainstLogId` is null, no prior submissions → should succeed
7. **Different org/reg pairs**: Submissions for different org/reg pairs can proceed concurrently (no blocking)

### Edge Cases

- Confirm when log is already `submitting` (should fail status check)
- Confirm when log is `superseded` (if state still exists) or other non-`validated` state
- Network failure during submission (should revert to `validated`)

---

## Migration Notes

### `superseded` State

The `superseded` state can be left in place for backwards compatibility with existing logs, but new code should not create logs in this state.

Alternatively, run a migration to transition old `superseded` logs to a terminal state or delete them.

### Existing Validated Logs

Existing `validated` logs won't have `validatedAgainstLogId`. Handle this conservatively:

```javascript
// In staleness check
const baseline = summaryLog.validatedAgainstLogId ?? null

// If baseline is null and there are submitted logs, treat as stale
// (conservative approach for migrated data)
if (baseline === null && currentLatest !== null) {
  throw Boom.conflict(
    'Preview was generated before tracking was enabled. Please re-upload.'
  )
}
```

This ensures old previews can't accidentally submit against a changed baseline.

---

## Summary

The key insight of this design is that **staleness is checked at submission time, not enforced via state transitions**. This simplifies the state machine and eliminates upload blocking while maintaining data integrity.

The `validatedAgainstLogId` field is the linchpin - it records the submission baseline when the summary log is created, and any change to that baseline before confirmation means the preview is stale.

### Repository Contract Changes

| Method                            | Change |
| --------------------------------- | ------ |
| `supersedePendingLogs`            | Remove |
| `checkForSubmittingLog`           | Remove |
| `findLatestSubmittedForOrgReg`    | Add    |
| `transitionToSubmittingExclusive` | Add    |
