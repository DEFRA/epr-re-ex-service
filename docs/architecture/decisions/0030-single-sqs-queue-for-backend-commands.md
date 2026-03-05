# 30. Single SQS Queue for Backend Commands

Date: 2026-03-04

## Status

Proposed

## Context

The backend processes asynchronous commands via an SQS queue (`epr_backend_commands`). Commands currently include `VALIDATE` and `SUBMIT` for summary log operations.

Two upcoming features -- overseas reprocessing sites and waste-balance recalculation -- also intend to use queue-based processing, which will further increase the number of command types flowing through the queue.

As the number of command types grows, we need to decide whether to continue routing all commands through a single queue or to split them into separate queues per command type.

### Current Implementation

PR #905 introduced a generalised command consumer with a handler dispatch pattern. The consumer:

1. Reads messages from a single SQS queue
2. Validates the message envelope (extracting the `command` field) against registered handlers
3. Validates the command-specific payload against the matched handler's Joi schema
4. Dispatches to the appropriate handler's `execute` function
5. On terminal failure, calls the handler's `onFailure` function to mark the entity as failed

New command types are added by registering a `CommandHandler` object with `command`, `payloadSchema`, `execute`, `onFailure`, and `describe` properties. The consumer itself requires no modification.

A single redrive policy governs all command types, sending failed messages to a shared dead-letter queue (DLQ) after exhausting retries.

### Throughput Profile

Summary log operations are low-throughput: operators submit summary logs periodically, and each log triggers a validate and (if valid) a submit command. The RECALCULATE_BALANCE command will be triggered on submission and is similarly infrequent. There is no expectation of high-volume bursts for any command type in the foreseeable future.

## Decision

We will continue using a **single SQS queue with handler dispatch** for all backend commands.

### Rationale

At current and projected throughput levels, the simplicity of a single queue outweighs the isolation benefits of multiple queues.

**Single queue (current approach):**

- Simpler infrastructure -- one queue, one DLQ, one consumer process
- Single redrive policy applies uniformly to all command types
- The handler dispatch pattern (PR #905) makes adding new command types a code-only change with no infrastructure provisioning
- One place to monitor queue depth, consumer health, and DLQ accumulation
- Fewer moving parts reduce operational risk in a small team

**Multiple queues (rejected for now):**

- Independent scaling per command type -- unnecessary at current throughput
- Per-queue redrive policies allowing different retry counts per command type -- all current commands have similar failure characteristics
- Per-command DLQ enabling clearer failure triage -- at low volume, a shared DLQ with structured log messages is sufficient
- More infrastructure to provision, configure, and monitor per queue
- Each queue requires its own consumer setup and health checks

### Trade-offs Accepted

- **Head-of-line blocking**: A slow or high-volume command type could delay processing of other command types. At current throughput this is not a concern, but it would become one if a command type were to process large batches or experience sustained high volume.
- **Shared retry policy**: All command types share the same `maxReceiveCount`. If a future command type needs significantly fewer or more retries, this would require either a compromise value or a queue split.
- **Mixed DLQ**: Failed messages of different types land in the same DLQ. The structured logging and message body (which includes the `command` field) provide sufficient context for triage at current volumes.

### Revisit Criteria

Split into multiple queues if any of the following arise:

1. A command type requires a materially different retry policy (e.g. more retries for an idempotent operation, fewer for a fast-failing one)
2. Throughput for one command type increases to the point where it delays others
3. DLQ triage becomes difficult due to mixed message types at higher volumes
4. A command type needs independent scaling (e.g. separate consumer with different concurrency settings)

## Consequences

### Positive

- **Operational simplicity** -- single queue, single DLQ, single consumer to provision and monitor
- **Code extensibility** -- adding a new command type requires only a new `CommandHandler` registration, no infrastructure changes
- **Uniform behaviour** -- all commands benefit from the same retry policy, timeout handling, and error logging
- **Lower infrastructure cost** -- fewer SQS queues and associated CloudWatch alarms

### Negative

- **No per-command isolation** -- one command type's behaviour (slow processing, high volume, or frequent failures) affects all others
- **Single retry policy** -- cannot tailor `maxReceiveCount` to individual command characteristics
- **Mixed DLQ** -- requires inspecting message bodies to determine which command type failed, rather than reading from a dedicated queue

## References

- [ADR 0021 - Idempotent Operations and Retry Mechanisms](0021-idempotent-operations-and-retry-mechanisms.md) -- establishes the queue-based retry approach this decision builds upon
- PR #905 (`epr-backend`) -- introduces the generalised command consumer with handler dispatch
- PAE-1143 -- adds `RECALCULATE_BALANCE` as a new command type
