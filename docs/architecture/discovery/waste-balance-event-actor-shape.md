# Waste Balance Event Actor Shape — Render Parity with the System Log

## Status

Accepted — the recommended expansion has shipped in `epr-backend`. The waste-balance event actor is now a single open record, `{ id, name?, email? }`, populated only with the real values each write path carries. This note records the comparison with the System Log actor and the landed decision.

## Context

[ADR 0036](../decisions/0036-event-sourced-waste-balance-stream.md) defines the event-sourced waste-balance stream. Its §Actor vs cause specifies the event provenance as `createdBy: { id, name }`, "stamped from the SubmitUser at submit time", uniform across every event kind.

The same submit action also writes a **submit system-log audit**. The admin **System Logs** view (`epr-re-ex-admin-frontend`, `src/server/routes/system-logs`) renders that audit's actor as three distinct fields — **User ID**, **User email** and **User roles** — filterable by the "Summary log" event type (`index.njk` lines 102–112: `systemLog.user.{id,email,scope}`).

So two persisted records describe the same submitting actor, and they carry different fidelity. This note compares the two shapes and records the decision to expand the event actor so that, once the stream is the canonical source, submitter information can be rendered with the same fidelity the System Logs view already offers.

## The two actor shapes

The submit audit's actor is produced by `extractUserDetails` (`epr-backend`, `src/auditing/helpers.js`) and is **discriminated by actor type**:

| Actor | Shape produced | Source |
|-------|----------------|--------|
| Human | `{ id, email, scope }` | `request.auth.credentials.{id,email,scope}` |
| Machine | `{ id, name }` | `request.auth.credentials.{id,name}` |

Before this change the event actor (`StreamUserSummary` / `userSummarySchema`, `src/waste-balances/repository/stream-schema.js`) was a single shape with **both fields required**:

```js
const userSummarySchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required()
})
```

Reducing the audit actor to that shape lost three distinctions:

1. **Email was conflated into `name`.** For a human submitter the email was the only label captured, so the event-write sites set `name = email`. The event then asserted that a person's *name* was an email address.
2. **Scope (roles) had no slot.** The human actor's `scope` could not be carried by `{ id, name }`.
3. **The human-vs-machine shape was lost.** `{ id, email, scope }` versus `{ id, name }` collapsed to one undiscriminated `{ id, name }`, so a reader could no longer tell a person from a service account.

## Where the loss happened

Before the fix, `name = email` was written at every site that stamped a **summary-log submitter** onto the stream — both the live write path and the historical recovery path. The data needed for the richer shape was already present at the live write sites and simply discarded. `SubmitUser` (`src/domain/summary-logs/worker/port.js`) carries `id`, `email` and `scope`; the live write collapsed `email` into `name` and threw `scope` away.

As landed, the summary-log submit path writes each value to its own slot. `update-via-stream.js:61` stamps:

```js
createdBy: {
  id: user.id,
  ...(user.name && { name: user.name }),
  email: user.email
}
```

— `email` in `email`, a real `name` only when present, never email-as-name. The old `calculator.js` live write site no longer exists (the live write path was consolidated into `update-via-stream.js`). On the recovery path, `toStreamActor` reduces to `{ id, name?, email? }` — no `name = email` fallback. The rebuild's `actorOf` (`compute-rebuilt-stream.js`) carries `name`/`email` from upstream records where they exist, else `BACKFILL_ACTOR`.

### The PRN write path stamps its own actor

PRN stream events are stamped through `appendPrnStreamEvent` (`src/waste-balances/repository/helpers-prn.js`) via a `createdBy` actor that is built **upstream in the routes**, not at the repository boundary. Each route assembles the best view its credentials carry and threads it down:

| PRN write | Route | Actor stamped |
|-----------|-------|---------------|
| Live human status transition | `routes/status.js:109` | `{ id, name, email }` (email present whenever the human credential carries one) |
| Live RPD status transition | `routes/external-transition-handler.js:88` | `{ id, name: 'RPD' }` — `RPD` is a genuine service name from the machine credential (`plugins/auth/external-api-auth-plugin.js:67`), no email |
| PRN creation | `routes/post.js:155` | `{ id, name }` |

So the PRN actor is **not** `{ id }`-only: human transitions carry `{ id, name, email }`, and RPD transitions carry `{ id, name: 'RPD' }`. The id is never duplicated into `name`. (Migration of historical RPD transitions currently lands id-only; aligning that with the live `{ id, name: 'RPD' }` shape is tracked separately.)

## Why it matters for rendering

The System Logs view renders the audit actor field-by-field — User ID, User email, User roles. Before the fix a renderer that consumed the event actor and trusted `name` would have printed an email where a name belongs. The landed `{ id, name?, email? }` shape removes that mislabelling: `id`, `name` and `email` each render from their own slot.

`scope` (User roles) is the one System Logs field the event actor deliberately does **not** carry. It is observed only — rendered by System Logs from the submit audit, and counted pre-cutover (`AttributionCounts.scope`) so render fidelity is visible before the stream becomes canonical — but it is not stamped onto the event. Render parity for roles from the event actor, if it is wanted once the stream is the render surface, is a separate decision; it is intentionally out of the shape that shipped.

## Recommendation

**Expand the event actor to carry the best view of the identity each write path has — as many of `id`, `name`, `email` as the source actually provides — dropping the email-as-name conflation.**

Carrying an email in a `name` field is a defect, not a stylistic choice: it is a semantic lie that any downstream renderer trusting `name` will propagate. The governing invariant is broader than email-as-name:

> **A value must never be written to the wrong property.** An email goes only in `email`, an id only in `id`, a name only in `name`. A slot for which we have no real value is left absent — never filled with a value that belongs to a different slot.

Each piece of identity lives in its own slot, populated only when there is a real value for it.

Target shape — a single open actor record rather than a discriminated human/machine union:

```
{ id, name?, email? }
```

- `id` required — every actor has one.
- `name`, `email` each optional — present when the source supplies a real value, **absent otherwise**. Never synthesise one field from another (no `name = email`, no `name = id`).

`scope` is intentionally **not** a slot on the event actor. It is observed only — rendered by System Logs from the submit audit and counted pre-cutover for render-fidelity visibility — and is deliberately not carried onto the event. See *Why it matters for rendering* above.

A single "best view" record is preferred over a `{ id, email, scope }` / `{ id, name }` discriminated union because it does not force a human-vs-machine classification onto data that may carry any subset. Each write site simply records what it has:

| Source | Carries | Actor |
|--------|---------|-------|
| `SubmitUser` (live summary-log submit) | `id, name?, email` | `{ id, name?, email }` |
| Submit audit, human (recovery) | `id, email` | `{ id, email }` |
| Submit audit, machine (recovery) | `id, name` | `{ id, name }` |
| Live human PRN transition | `id, name, email` | `{ id, name, email }` |
| Live RPD PRN transition | `id, name: 'RPD'` | `{ id, name: 'RPD' }` |

This makes the email-as-name state unrepresentable (no path can stamp an email as a name) and gives render parity with System Logs for `id`, `name` and `email` wherever the data exists, because each flows into its own slot. Where a source has only an id, the actor honestly carries just `{ id }` rather than a placeholder `name`.

### Resolving the open question

The prior open question — whether rendering submitter info from the stream is a requirement at all, or whether System Logs remains the sole render surface with the event actor kept attribution-only — does not change the shape. Even an attribution-only actor must not store an email as a name. The open `{ id, name?, email? }` shape satisfies that floor and renders `id`/`name`/`email` with System Logs fidelity should the stream become the render surface. Role (`scope`) parity is the one piece left out, by decision, and would be a separate change.

## Decision

The event actor is a single open record, `{ id, name?, email? }`: `id` required, `name` / `email` each present only when the source has a real value, absent otherwise. A value is never written to the wrong property — no email-as-name, no id-as-name; an unknown slot is left absent. `scope` is not carried (observed-only; see *Why it matters for rendering*).

**Timing — no data migration needed.** The change landed while the stream feature flag was off and the submitter recovery was read-only diagnostic, so no email-as-name events had been persisted; it needed no backfill or migration. It is sequenced ahead of the embedded-path retirement and flag removal, before the cutover promotion runs.

**As shipped** (`epr-backend`): `userSummarySchema` / `StreamUserSummary` widened to `{ id, name?, email? }`; the live summary-log write (`update-via-stream.js`) stamps `{ id, name?, email }` with the old `calculator.js` site removed; `toStreamActor` and `actorOf` reduce to the same shape on the recovery/rebuild paths; and the PRN actor is built upstream in the routes (`status.js`, `external-transition-handler.js`, `post.js`) and threaded through `appendPrnStreamEvent` — `{ id, name, email }` for live human transitions, `{ id, name: 'RPD' }` for RPD.
