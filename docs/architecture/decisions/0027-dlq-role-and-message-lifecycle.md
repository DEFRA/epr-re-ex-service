# 27. DLQ as Investigation Tool, Not Recovery Mechanism

Date: 2026-02-13

## Status

Proposed

## Context

[ADR-0021](0021-idempotent-operations-and-retry-mechanisms.md) established idempotent operations with queue-based retry mechanisms as the resilience strategy for data processing. It describes the Dead Letter Queue (DLQ) as a place that "captures operations that exhaust retry attempts for investigation", but does not specify:

- The message lifecycle from transient failure through retries to dead-lettering
- Why redriving messages from the DLQ is ineffective in our particular use of SQS
- What the correct operational response to DLQ messages is

The backend commands queue consumer (`consumer.js`) handles errors as follows:

1. **Permanent errors** — the message is acknowledged immediately and the summary log is marked as failed via `markAsFailed`. The message never reaches the DLQ.
2. **Transient errors** — the message is returned to the queue for retry. SQS retries up to the max receive count (currently 3).
3. **Final transient attempt** — when the consumer detects this is the last retry (receive count equals max), it marks the summary log as failed *before* the message moves to the DLQ. This is deliberate: without it, a summary log whose retries are exhausted would remain in a processing state indefinitely. The user would see their upload stalled with no indication of failure and no way to retry. Marking as failed on the final attempt ensures the user gets clear feedback and can resubmit.

This means that by the time a message arrives in the DLQ, the associated summary log is already in a terminal failed state. The `markAsFailed` call is irreversible — subsequent attempts to process a command against an already-failed summary log raise a `PermanentError` because the status guard rejects the operation.

This behaviour was validated during the idempotency audit of the SQS queue consumer but has not been formalised as an architectural decision.

## Decision

The DLQ is an **investigation and alerting tool**, not a recovery mechanism. Messages must not be redriven.

### Message lifecycle

```
┌─────────────────┐
│  Command queued  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐    success    ┌──────────────┐
│ Consumer picks   ├─────────────►│  Completed    │
│ up message       │              └──────────────┘
└────────┬────────┘
         │ error
         ▼
┌─────────────────┐
│ Classify error   │
└──┬───────────┬──┘
   │           │
   │ permanent │ transient
   ▼           ▼
┌────────┐  ┌──────────────────┐
│ ACK +  │  │ Return to queue  │
│ mark   │  │ (SQS retry)      │
│ failed │  └────────┬─────────┘
└────────┘           │
                     │ max receives reached
                     ▼
              ┌──────────────────┐
              │ Final attempt:   │
              │ mark as failed   │
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │ DLQ              │
              │ (investigation   │
              │  only)           │
              └──────────────────┘
```

### Alternative considered: keep summary logs in a processing state for redrive

An alternative design would skip the `markAsFailed` call on the final attempt, leaving the summary log in its processing state. This would make DLQ messages redrivable — once the transient issue is resolved, an operator could redrive messages and the commands would succeed.

However, this trades user experience for operational convenience:

- **Users see stalled uploads with no feedback.** If the transient issue takes minutes or hours to resolve, the summary log remains in a processing state for that entire period. The user has no indication anything has gone wrong and no ability to act.
- **Recovery depends on operator intervention.** The user's upload only completes when an operator notices the DLQ, investigates the root cause, resolves it, and redrives. Outside working hours or during periods of high load, this could leave users stuck for extended periods.
- **The window for redrive is narrow.** Redriving only helps if the transient issue has been resolved. If it hasn't, the redriven message fails again and returns to the DLQ — the user is still stuck.
- **It conflates two different recovery paths.** Operators must now judge whether to redrive (hoping the issue is resolved) or purge (accepting the messages are unrecoverable). The current design removes this ambiguity: DLQ messages are always for investigation, and recovery always goes through the user.

Marking as failed on the final attempt prioritises clear, immediate feedback to the user over the possibility of silent automated recovery. Users can retry at their convenience rather than waiting for an operator to act.

### Why redriving is ineffective

When a message is redriven from the DLQ back to the main queue:

1. The consumer picks up the message and attempts to process the command
2. The command handler checks the summary log's current status
3. The summary log is already in a failed state (marked on the final attempt)
4. The handler raises a `PermanentError` — the status guard rejects the operation
5. The message is acknowledged and discarded

Redriving therefore achieves nothing. It does not recover the failed operation.

### Correct operational response

When messages appear in the DLQ:

1. **Inspect** — read the message bodies to identify affected `summaryLogId` values
2. **Investigate** — check application logs for the root cause of the transient failures
3. **Record** — document which summary logs were affected and which users are impacted
4. **Purge** — delete DLQ messages once investigation is complete
5. **Communicate** — inform affected users that they need to retry their operation through the normal UI flow

The DLQ's value is in preserving the message payload and metadata (receive count, timestamps) for root cause analysis and in triggering alerts when messages accumulate.

## Consequences

### Positive

- **Clear operational model** — operators know that DLQ messages require investigation and user communication, not automated recovery attempts
- **No false hope of self-healing** — avoids wasted effort attempting redrives that cannot succeed
- **Simpler tooling** — no need to build or maintain redrive automation; the operational runbook covers the investigation workflow
- **Consistent with ADR-0021** — reinforces the idempotent design where each operation has a clear terminal state

### Negative

- **Manual user communication** — when summary logs fail due to transient infrastructure issues, affected users must be individually notified to retry
- **No automated recovery for transient blips** — even if the underlying issue resolves quickly, summary logs that were marked as failed on their final attempt cannot be automatically retried
- **Relies on monitoring** — the DLQ is only useful if alerts are configured to detect messages arriving; without alerting, failures could go unnoticed

## References

- [ADR-0021: Idempotent Operations and Retry Mechanisms](0021-idempotent-operations-and-retry-mechanisms.md)
- Source: [`consumer.js`](https://github.com/DEFRA/epr-backend/blob/main/src/server/queue-consumer/consumer.js) — error handling and retry logic
- Source: [`permanent-error.js`](https://github.com/DEFRA/epr-backend/blob/main/src/server/queue-consumer/permanent-error.js) — permanent error class
- Source: [`mark-as-failed.js`](https://github.com/DEFRA/epr-backend/blob/main/src/server/queue-consumer/mark-as-failed.js) — failure marking logic
