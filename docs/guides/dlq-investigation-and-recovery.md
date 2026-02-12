# DLQ Investigation and Recovery

This guide covers monitoring, investigating, and recovering messages from the backend commands dead-letter queue (DLQ).

## Overview

| Property | Value |
|----------|-------|
| Main queue | `epr_backend_commands` |
| Dead-letter queue | `epr_backend_commands-deadletter` |
| Max receive count | 3 |
| Visibility timeout | 300 s (5 minutes) |
| Queue type | Standard (not FIFO) |

The consumer processes `validate` and `submit` commands for summary logs. When processing fails, SQS retries the message up to 3 times before moving it to the DLQ.

### How errors are handled

The consumer distinguishes between **permanent** and **transient** errors:

- **Permanent errors** (`PermanentError`) — the message is acknowledged immediately and the summary log is marked as failed. These errors never reach the DLQ because the message is deleted after the first failure.
- **Transient errors** — the message is returned to the queue for retry. If the message reaches the max receive count (3), the consumer marks the summary log as failed on the final attempt, then SQS moves the message to the DLQ.
- **Timeouts** — if a command exceeds 5 minutes, the consumer marks the summary log as failed.

**Key implication**: messages in the DLQ are always from transient failures that exhausted all retries. The summary log will already be marked as failed.

Source files:
- `lib/epr-backend/src/server/queue-consumer/consumer.js` — error handling and retry logic
- `lib/epr-backend/src/server/queue-consumer/permanent-error.js` — permanent error class
- `lib/epr-backend/src/config.js` — queue configuration

## When this applies

- The **EPR SQS DLQ** Grafana alert fires
- The SQS dashboard shows DLQ depth > 0
- A user reports a stuck summary log and logs show repeated transient failures

## Assess severity

1. Open the **epr-backend (service)** dashboard in Grafana and scroll to the SQS Command Queue section
2. Check the DLQ depth — how many messages are dead-lettered?
3. Check the main queue depth and throughput — is the consumer still processing?
4. Check the oldest message age on the DLQ — how long have messages been sitting there?
5. Check consumer health in the application logs — are there ongoing errors?

A small number of messages after a brief infrastructure blip is low severity. A growing DLQ with ongoing consumer errors requires immediate investigation.

## Inspect DLQ messages

Use the AWS CLI via **CDP Terminal** to peek at messages without consuming them:

```bash
# Get the queue URL
aws sqs get-queue-url --queue-name epr_backend_commands-deadletter

# Peek at messages (substitute the queue URL from above)
aws sqs receive-message \
  --queue-url <queue-url> \
  --max-number-of-messages 10 \
  --visibility-timeout 0 \
  --attribute-names All \
  --message-attribute-names All
```

Setting `--visibility-timeout 0` lets you read the message without hiding it from subsequent reads.

Each message body contains:

```json
{
  "command": "validate|submit",
  "summaryLogId": "<id>",
  "user": { "id": "...", "email": "...", "scope": ["..."] }
}
```

The message attributes include `ApproximateReceiveCount` and `ApproximateFirstReceiveTimestamp`, which show how many times the message was attempted.

## Identify root cause

Check the application logs for the `summaryLogId` values found in the DLQ messages. Look for log entries containing `Command failed (transient, will retry)` and `Command failed (transient, final attempt)`.

### Common patterns

| Pattern | Symptoms | Action |
|---------|----------|--------|
| Transient infrastructure failure (MongoDB, network) | Errors reference connection timeouts or MongoDB errors; issues have since resolved | Redrive — the underlying issue is gone |
| Consumer crash or restart during processing | Messages failed during a deployment; consumer is now healthy | Redrive — the new deployment should process successfully |
| Sustained downstream failure | Errors ongoing; same failure on every retry | Fix the downstream issue first, then redrive |

**Note**: permanent errors (e.g. invalid data, business rule violations) are acknowledged immediately by the consumer and never reach the DLQ. If you see messages in the DLQ, the root cause is always a transient failure.

## Redrive messages

Operations are idempotent by design ([ADR-0021](../architecture/decisions/0021-idempotent-operations-and-retry-mechanisms.md)), so replaying messages is safe. The queue is standard (not FIFO), so there are no ordering concerns.

Use the AWS CLI via CDP Terminal:

```bash
# Start the redrive
aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:<region>:<account-id>:epr_backend_commands-deadletter \
  --destination-arn arn:aws:sqs:<region>:<account-id>:epr_backend_commands

# Check redrive progress
aws sqs list-message-move-tasks \
  --source-arn arn:aws:sqs:<region>:<account-id>:epr_backend_commands-deadletter
```

After starting the redrive:

1. Monitor the **main queue depth** on the dashboard — it should increase as messages move back
2. Monitor the **DLQ depth** — it should decrease to 0
3. Watch application logs for successful processing of the redriven messages
4. If messages return to the DLQ after redrive, the root cause has not been resolved

## Purge the DLQ

Only purge if messages are genuinely unprocessable and you have confirmed they cannot be redriven:

```bash
aws sqs purge-queue \
  --queue-url https://sqs.<region>.amazonaws.com/<account-id>/epr_backend_commands-deadletter
```

**Warning**: this permanently deletes all messages in the queue. The affected summary logs will remain in a failed state. Ensure you have recorded the affected `summaryLogId` values before purging.

## Escalation

Escalate if:

- The DLQ keeps growing after a redrive (root cause unresolved)
- The consumer is not processing messages from the main queue
- You cannot identify the root cause from application logs
- The number of affected summary logs is large enough to impact users

Raise with the team via the usual channels and include:

- Number of DLQ messages
- Time range of failures
- Sample error messages from the logs
- Any infrastructure incidents that coincide with the failures
