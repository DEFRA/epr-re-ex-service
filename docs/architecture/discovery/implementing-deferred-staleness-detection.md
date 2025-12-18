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

## Summary of Changes

### Remove

- [ ] Upload blocking check (check for `submitting` status before allowing upload)
- [ ] Supersede logic on CDP callback (transitioning other logs to `superseded`)
- [ ] `superseded` state (or repurpose for other uses)

### Add

- [ ] `validatedAgainstLogId` field on summary log schema
- [ ] Record `validatedAgainstLogId` at validation start (CDP callback)
- [ ] Staleness check at confirmation time
- [ ] Concurrent submission handling (count check after transition)
- [ ] Optional: staleness indicator on GET summary log

### Modify

- [ ] Confirm endpoint: add staleness check and concurrent submission handling
- [ ] State machine: remove `superseded` transitions from upload/validation flow

---

## Implementation Steps

### 1. Add `validatedAgainstLogId` to Schema

Add a new field to track which submission state the preview was generated against.

```javascript
// In summary log schema
{
  // ... existing fields
  validatedAgainstLogId: {
    type: Schema.Types.ObjectId,
    ref: 'SummaryLog',
    default: null
  }
}
```

**Why**: This field records the ID of the last submitted summary log at the time validation began. If this changes before confirmation, the preview is stale.

### 2. Record Baseline at CDP Callback

When the CDP callback arrives and we transition from `preprocessing` to `validating`, record the current submission baseline.

**Find**: The code that handles CDP callback and transitions to `validating`.

**Change**:

```javascript
// At CDP callback: transition to validating and record baseline
const latestSubmitted = await SummaryLog.findOne({
  organisationId,
  registrationId,
  status: 'submitted'
}).sort({ submittedAt: -1 })

const result = await SummaryLog.findOneAndUpdate(
  { _id: logId, status: 'preprocessing' },
  {
    $set: {
      status: 'validating',
      validatedAgainstLogId: latestSubmitted?._id ?? null
    }
  },
  { returnDocument: 'after' }
)

if (!result) {
  // Log is no longer in preprocessing state
  return { error: 'Upload state changed unexpectedly' }
}
```

### 3. Remove Supersede Logic on Upload

**Find**: Code that supersedes existing `validating`/`validated` logs when a new upload arrives.

**Remove**: The entire supersede operation. Multiple validated logs can now coexist.

```javascript
// REMOVE this code (or similar)
await SummaryLog.updateMany(
  {
    organisationId,
    registrationId,
    _id: { $ne: logId },
    status: { $in: ['validating', 'validated'] }
  },
  { $set: { status: 'superseded' } }
)
```

### 4. Remove Upload Blocking

**Find**: Code that checks for `submitting` status before allowing upload/validation.

**Remove**: This check. Uploads should never be blocked.

```javascript
// REMOVE this code (or similar)
const submitting = await SummaryLog.findOne({
  organisationId,
  registrationId,
  status: 'submitting'
})
if (submitting) {
  throw Boom.conflict('A submission is in progress. Please wait.')
}
```

### 5. Update Confirm Endpoint

This is the most significant change. The confirm endpoint must:

1. Atomically transition to `submitting`
2. Check we're the only one submitting (handle concurrent confirms)
3. Check staleness (compare `validatedAgainstLogId` to current latest)
4. Revert if either check fails

**Replace** the existing confirm logic with:

```javascript
async function confirmSummaryLog(logId, organisationId, registrationId) {
  // Step 1: Atomic transition to submitting
  const log = await SummaryLog.findOneAndUpdate(
    { _id: logId, status: 'validated' },
    { $set: { status: 'submitting' } },
    { returnDocument: 'after' }
  )

  if (!log) {
    throw Boom.conflict('Summary log is no longer in a confirmable state')
  }

  try {
    // Step 2: Check we're the only one submitting for this org/reg
    const submittingCount = await SummaryLog.countDocuments({
      organisationId,
      registrationId,
      status: 'submitting'
    })

    if (submittingCount > 1) {
      throw Boom.conflict('Another submission started. Please try again.')
    }

    // Step 3: Check staleness
    const currentLatest = await SummaryLog.findOne({
      organisationId,
      registrationId,
      status: 'submitted'
    }).sort({ submittedAt: -1 })

    const baseline = log.validatedAgainstLogId?.toString() ?? null
    const current = currentLatest?._id?.toString() ?? null

    if (baseline !== current) {
      throw Boom.conflict(
        'Waste records have changed since preview was generated. Please re-upload.'
      )
    }

    // Step 4: Proceed with submission
    await updateWasteRecords(log)

    // Step 5: Mark as submitted
    await SummaryLog.findOneAndUpdate(
      { _id: logId },
      { $set: { status: 'submitted', submittedAt: new Date() } }
    )

    return { success: true }
  } catch (error) {
    // Revert to validated on any error
    await SummaryLog.findOneAndUpdate(
      { _id: logId, status: 'submitting' },
      { $set: { status: 'validated' } }
    )
    throw error
  }
}
```

### 6. Optional: Add Staleness Indicator to GET

For better UX, indicate staleness when the user views a summary log.

**Find**: The GET summary log endpoint.

**Add**:

```javascript
async function getSummaryLog(logId) {
  const log = await SummaryLog.findById(logId)

  if (!log || log.status !== 'validated') {
    return log
  }

  // Check if preview is stale
  const currentLatest = await SummaryLog.findOne({
    organisationId: log.organisationId,
    registrationId: log.registrationId,
    status: 'submitted'
  }).sort({ submittedAt: -1 })

  const isStale =
    (log.validatedAgainstLogId?.toString() ?? null) !==
    (currentLatest?._id?.toString() ?? null)

  return {
    ...log.toObject(),
    isStale
  }
}
```

The frontend can then display a warning if `isStale` is true.

### 7. Add TTL Index for Cleanup

Without superseding, validated logs will accumulate. Add a TTL index for cleanup.

```javascript
// Add TTL index on validated logs
summaryLogSchema.index(
  { validatedAt: 1 },
  {
    expireAfterSeconds: 86400, // 24 hours
    partialFilterExpression: { status: 'validated' }
  }
)
```

**Note**: Also add TTL for `preprocessing` logs (already may exist).

---

## Testing Considerations

### Scenarios to Test

1. **Happy path**: Upload → validate → confirm → success
2. **Stale preview**: User A confirms while User B has a validated preview → User B's confirm fails with staleness error
3. **Concurrent confirms (different logs)**: Two users confirm simultaneously → one succeeds, one gets "another submission started"
4. **Concurrent confirms (same log)**: Two tabs confirm same log → one succeeds, one fails
5. **Upload during submission**: User uploads while another submission in progress → upload succeeds, preview generated, confirm fails (stale)
6. **First submission for org/reg**: `validatedAgainstLogId` is null, no prior submissions → should succeed

### Edge Cases

- Confirm when log is already `submitting` (should fail atomic transition)
- Confirm when log is `superseded` (if state still exists) or other non-`validated` state
- Network failure during submission (should revert to `validated`)

---

## Migration Notes

### If `superseded` State Still Exists

The `superseded` state can be left in place for backwards compatibility with existing logs, but new code should not create logs in this state.

Alternatively, run a migration to transition old `superseded` logs to a terminal state or delete them.

### Existing Validated Logs

Existing `validated` logs won't have `validatedAgainstLogId`. Handle this:

```javascript
// In staleness check
const baseline = log.validatedAgainstLogId?.toString() ?? null

// If baseline is null and there are submitted logs, treat as stale
// (conservative approach for migrated data)
if (baseline === null && currentLatest !== null) {
  throw Boom.conflict(
    'Preview was generated before tracking was enabled. Please re-upload.'
  )
}
```

Or, more permissively, allow null baseline to match any state (risky but simpler migration).

---

## Summary

The key insight of this design is that **staleness is checked at submission time, not enforced via state transitions**. This simplifies the state machine and eliminates upload blocking while maintaining data integrity.

The `validatedAgainstLogId` field is the linchpin - it records the submission baseline at validation time, and any change to that baseline before confirmation means the preview is stale.
