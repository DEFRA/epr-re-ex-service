# Waste Balance Event Actor Shape — Render Parity with the System Log

## Status

Proposed — recommendation settled toward expand; implementation tracked separately, to land before the ledger cutover promotion runs.

## Context

[ADR 0036](../decisions/0036-event-sourced-waste-balance-stream.md) defines the event-sourced waste-balance stream. Its §Actor vs cause specifies the event provenance as `createdBy: { id, name }`, "stamped from the SubmitUser at submit time", uniform across every event kind.

The same submit action also writes a **submit system-log audit**. The admin **System Logs** view (`epr-re-ex-admin-frontend`, `src/server/routes/system-logs`) renders that audit's actor as three distinct fields — **User ID**, **User email** and **User roles** — filterable by the "Summary log" event type (`index.njk` lines 102–112: `systemLog.user.{id,email,scope}`).

So two persisted records describe the same submitting actor, and they carry different fidelity. This note compares the two shapes and recommends whether the event actor should be expanded so that, once the ledger is the canonical source, submitter information can be rendered with the same fidelity the System Logs view already offers.

## The two actor shapes

The submit audit's actor is produced by `extractUserDetails` (`epr-backend`, `src/auditing/helpers.js`) and is **discriminated by actor type**:

| Actor | Shape produced | Source |
|-------|----------------|--------|
| Human | `{ id, email, scope }` | `request.auth.credentials.{id,email,scope}` |
| Machine | `{ id, name }` | `request.auth.credentials.{id,name}` |

The event actor (`StreamUserSummary` / `userSummarySchema`, `src/waste-balances/repository/stream-schema.js`) is a single shape with **both fields required**:

```js
const userSummarySchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required()
})
```

Reducing the audit actor to this shape loses three distinctions:

1. **Email is conflated into `name`.** For a human submitter the email is the only label captured, so the event-write sites set `name = email`. The event then asserts that a person's *name* is an email address.
2. **Scope (roles) is dropped.** The human actor's `scope` has no slot in `{ id, name }`.
3. **The human-vs-machine shape is lost.** `{ id, email, scope }` versus `{ id, name }` collapses to one undiscriminated `{ id, name }`, so a reader can no longer tell a person from a service account.

## Where the loss happens

`name = email` is written at every site that stamps a **summary-log submitter** onto the stream — both the live write path and the historical recovery path:

| Site | Code | Path |
|------|------|------|
| `src/waste-balances/application/calculator.js:59` | `createdBy: { id: user.id, name: user.email }` | live |
| `src/waste-balances/application/update-via-stream.js:61` | `createdBy: { id: user.id, name: user.email }` | live |
| `src/waste-balances/application/summary-log-submitters.js` (`toStreamActor`) | `name = createdBy.name ?? createdBy.email` | historical recovery (PR #1251) |

Crucially, the data needed for the richer shape is already present at the live write sites and simply discarded. `SubmitUser` (`src/domain/summary-logs/worker/port.js`) is:

```js
/**
 * @typedef {Object} SubmitUser
 * @property {string} id
 * @property {string} email
 * @property {string[]} scope
 */
```

Both `email` and `scope` are in hand at submit time; the write collapses `email` into `name` and throws `scope` away. The rebuild's `actorOf` (`compute-rebuilt-stream.js`) reads `actor.name` from upstream records, inheriting whatever those carry.

### The PRN write path is a separate actor stamp

The summary-log submit path is not the only thing that stamps an actor onto the stream. PRN stream events are stamped by `appendPrnStreamEvent` (`src/waste-balances/repository/helpers-prn.js:86`) as `createdBy: { id: userId, name: userId }` — the id duplicated into `name`. This is not an email-as-name violation, but it does put the id value in the `name` property, which the wrong-property invariant below forbids just as firmly. The PRN repository boundary carries only a `userId` string, with no email, scope, or real name available there at all, so under the recommended shape the PRN actor simply becomes `{ id }` — no `name`, because there is no name to put there. Widening the event actor therefore cannot deliver "invalid state unrepresentable" by fixing the summary-log sites alone; the PRN write site is part of the same change.

## Why it matters for rendering

The System Logs view renders the audit actor field-by-field — User ID, User email, User roles. A renderer that consumed the event actor and trusted `name` would print an email where a name belongs, and would have no `scope` to show for User roles. The event actor therefore cannot today reproduce the System Logs fidelity: it carries strictly less, and what it does carry is mislabelled.

## Recommendation

**Expand the event actor to carry the best view of whatever identity we have — as many of `id`, `name`, `email`, `scope` as the source actually provides — dropping the email-as-name conflation.**

Carrying an email in a `name` field is a defect, not a stylistic choice: it is a semantic lie that any downstream renderer trusting `name` will propagate. The governing invariant is broader than email-as-name:

> **A value must never be written to the wrong property.** An email goes only in `email`, an id only in `id`, a name only in `name`, scopes only in `scope`. A slot for which we have no real value is left absent — never filled with a value that belongs to a different slot.

Each piece of identity lives in its own slot, populated only when there is a real value for it.

Recommended target shape — a single open actor record rather than a discriminated human/machine union:

```
{ id, name?, email?, scope? }
```

- `id` required — every actor has one.
- `name`, `email`, `scope` each optional — present when the source supplies a real value, **absent otherwise**. Never synthesise one field from another (no `name = email`, no `name = id`).

A single "best view" record is preferred over a `{ id, email, scope }` / `{ id, name }` discriminated union because it does not force a human-vs-machine classification onto data that may carry any subset. Each write site simply records what it has:

| Source | Carries | Actor |
|--------|---------|-------|
| `SubmitUser` (live summary-log submit) | `id, email, scope` | `{ id, email, scope }` |
| Submit audit, human (recovery) | `id, email, scope` | `{ id, email, scope }` |
| Submit audit, machine (recovery) | `id, name` | `{ id, name }` |
| PRN write (`helpers-prn.js`) | `userId` only | `{ id }` |

This makes the email-as-name state unrepresentable (no path can stamp an email as a name) and gives render parity with System Logs wherever the data exists, because `email` and `scope` flow into their own slots. Where a source has only an id (PRN today), the actor honestly carries just `{ id }` rather than a placeholder `name`.

### Resolving the open question

The prior open question — whether rendering submitter info from the ledger is a requirement at all, or whether System Logs remains the sole render surface with the event actor kept attribution-only — does not change the recommendation. Even an attribution-only actor must not store an email as a name. The open `{ id, name?, email?, scope? }` shape both satisfies that floor and leaves the ledger able to render with System Logs fidelity should it become the render surface, at no extra cost in captured data.

## Decision

Expand the event actor to a single open record, `{ id, name?, email?, scope? }`: `id` required, `name` / `email` / `scope` each present only when the source has a real value, absent otherwise. A value is never written to the wrong property — no email-as-name, no id-as-name; an unknown slot is left absent.

**Timing — no data migration needed.** The ledger feature flag is off and the submitter recovery is read-only diagnostic, so no email-as-name events have been persisted. The change must land **before** the cutover promotion runs, while the stream is still empty of such events; done then, it needs no backfill or migration. Sequenced ahead of the embedded-path retirement and flag removal.

Implementation — the `userSummarySchema` / `StreamUserSummary` widening, the three summary-log write-site fixes, `actorOf`, the PRN write path (`helpers-prn.js`, which currently has only a `userId`), and the admin render wiring — is tracked separately.
