# DLQ Investigation

This guide covers monitoring and investigating messages in the backend commands dead-letter queue (DLQ).

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
- [consumer.js](https://github.com/DEFRA/epr-backend/blob/main/src/server/queue-consumer/consumer.js) — error handling and retry logic
- [permanent-error.js](https://github.com/DEFRA/epr-backend/blob/main/src/server/queue-consumer/permanent-error.js) — permanent error class
- [config.js](https://github.com/DEFRA/epr-backend/blob/main/src/config.js) — queue configuration

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
| Transient infrastructure failure (MongoDB, network) | Errors reference connection timeouts or MongoDB errors; issues have since resolved | Fix root cause, purge DLQ, affected users retry |
| Consumer crash or restart during processing | Messages failed during a deployment; consumer is now healthy | Purge DLQ, affected users retry |
| Sustained downstream failure | Errors ongoing; same failure on every retry | Fix the downstream issue first, then purge DLQ |

**Note**: permanent errors (e.g. invalid data, business rule violations) are acknowledged immediately by the consumer and never reach the DLQ. If you see messages in the DLQ, the root cause is always a transient failure.

## Why redriving does not help

The consumer marks the summary log as failed on the final transient attempt, **before** the message moves to the DLQ. By the time a message is dead-lettered, the summary log is already in a failed state. Redriving would re-run the command against an already-failed summary log, which achieves nothing.

Instead, the DLQ serves as an **investigation tool** — it tells you which summary logs were affected and preserves the message for root cause analysis.

## Record affected summary logs

Extract the `summaryLogId` from each DLQ message (see [Inspect DLQ messages](#inspect-dlq-messages)). Record these for follow-up:

- Identify the affected users from the `user` field in the message body
- Confirm the summary logs are in a failed state
- Communicate to affected users that they need to retry their operation

## Purge the DLQ

Once investigation is complete and affected summary logs have been recorded, purge the DLQ:

```bash
# Get the queue URL
aws sqs get-queue-url --queue-name epr_backend_commands-deadletter

# Purge all messages
aws sqs purge-queue --queue-url <dlq-url>
```

**Warning**: this permanently deletes all messages in the queue. Ensure you have recorded all affected `summaryLogId` values before purging.

## Escalation

Escalate if:

- The DLQ keeps growing (root cause unresolved)
- The consumer is not processing messages from the main queue
- You cannot identify the root cause from application logs
- The number of affected summary logs is large enough to impact users

Raise with the team via the usual channels and include:

- Number of DLQ messages and affected `summaryLogId` values
- Time range of failures
- Sample error messages from the logs
- Any infrastructure incidents that coincide with the failures
