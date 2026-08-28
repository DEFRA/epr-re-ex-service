# 47. Glass as two material types

Date: 2026-08-28

## Status

Proposed.

## Context

### The model

Glass is the only packaging material that sub-divides, and the sub-division is a **transition**, not a
permanent pairing of a material with a qualifier.

An organisation applies for a registration for glass and states the recycling processes separately. That
produces a temporary registration carrying glass plus one or both processes. It is then split into specific
glass materials: where both processes were applied for, the registration is duplicated in its entirety and
one process is kept on each copy, so a single application can produce two registrations. From that point,
glass re-melt and glass other are separate material types, not glass carrying a process.

An **accreditation is always in the settled state**: there is no accreditation for plain glass, only for
glass re-melt or glass other. A **registration** is also in the settled state, except briefly after
application.

### The store does not express that model

`material` is validated against the seven material values in both the registration and the accreditation
schema. Neither `glass_re_melt` nor `glass_other` is a permitted value. So every glass registration and
every glass accreditation is stored as `material: 'glass'`, with the precise type held separately in a
`glassRecyclingProcess` array. The precise types exist in code only as a derived list,
`TONNAGE_MONITORING_MATERIALS`, built by removing glass from the material list and adding the two processes:
a projection, never a stored value.

The domain says two material types. The store says one material and a qualifier. Every reader bridges that
gap itself, and they bridge it differently.

### What that costs today

Seven functions across `epr-backend` and `epr-frontend` collapse the two fields into one value, and they
disagree at the edges. A glass record carrying no process passes straight through in one, throws and 500s
the page in another, renders as "Glass" in a third, and is silently dropped from an aggregate in a fourth. A
record carrying both processes is read as its first entry in five places and joined into
`Glass-remelt-other` on the public register.

Two HTTP contracts over the same underlying record point in opposite directions: the registration response
schema forbids plain glass, while the PRN schemas permit only plain glass and forbid both processes. The
admin UI holds three display maps with three different behaviours on plain glass, and two of its templates
render the raw lowercase value with no map at all. The same name is spelled three ways across the services.

The split itself runs at **ingest**, not at approval, and only when a submission carries both processes. A
single-process submission is never touched, and nothing splits a stored record afterwards, so anything that
arrived unsplit stays unsplit.

### It has left the service

`external-manage-prns.yaml` publishes both fields to a consuming team: `material`, with plain `glass` in the
enum, and an optional `glassRecyclingProcess` beside it. Each consumer collapses them itself, by whatever
rule it invents. The internal API definition carries three different material enums, one of which includes
the display string `Glass-remelt-other`.

### Why this is being written down

The model has been agreed repeatedly and never recorded. Each time the outcome lived in a ticket comment,
and the next person to touch glass re-derived it from code that does not agree with itself. In January 2026
the constraint went from exactly one process, to a maximum of two, to a split-on-approval deferred until a
migration that was never built; three problems were closed by correcting data by hand; and the epic closed
as fully implemented. The evidence behind this ADR is set out in
[Glass: what it is, how it is stored, and where the two disagree](../discovery/glass-material-model.md).

## Decision

**Glass re-melt and glass other become material types in their own right, and `glassRecyclingProcess`
becomes an ingest-only concept** — it exists inside the forms-submission layer of `epr-backend`, and
nowhere else.

### 1. Ingest resolves the material

The existing glass split extends to every glass submission, not only those carrying both processes. It
lifts the process into `material` and stops emitting `glassRecyclingProcess`. Where both processes were
applied for, it continues to duplicate the whole submission, one material per copy.

This is the only place in the service that understands "glass plus a process", and it is there because the
application form asks the two questions separately and allows "Both". That constraint is external; the rest
of this decision follows from confining it.

### 2. The store holds the settled material

`glass_re_melt` and `glass_other` join the permitted `material` values on the registration and accreditation
schemas, and `glassRecyclingProcess` is no longer written. Plain glass remains valid only for a submission
in flight, before the split.

Stored registrations, accreditations, and the accreditation snapshots held on PRNs are migrated once. Every
stored glass record carries at least one process today, so every one can be resolved.

### 3. Nothing downstream knows glass has a subtype

The seven collapse functions, the derived `TONNAGE_MONITORING_MATERIALS` list in both `epr-backend` and
`epr-frontend`, and the admin UI's three display maps are removed. Glass re-melt and glass other become two
ordinary entries in the one material display map each surface already has.

Everything that keys on material — the Annex II process map, summary-log material matching, the
registration-to-accreditation match rule, submission natural keys, tonnage aggregation, waste balances —
keys on the material alone.

### 4. The published external contract is held by one adapter

`external-manage-prns.yaml` does not change and the consuming team is not asked for a coordinated release.
The external PRN mapper reverses the resolution on the way out, emitting `material: 'glass'` with the
matching `glassRecyclingProcess`. When that team is ready to take the two material values, the adapter and
the two fields in the specification go together.

The internal API definition is corrected to one material enum.

## Considered and rejected

**Collapse on read in the organisations repository.** Both repository adapters share a single read mapper,
so the two fields could be resolved there with no migration and no storage change. Rejected: the replace
path feeds that same mapped document back into the write, so the write schema has to accept the resolved
value regardless; the stored data stays ambiguous, so the "one process per record" invariant remains
unenforced; and a record carrying two processes silently loses the second on every read rather than being
dealt with.

**Leave the storage alone and standardise the collapse in one shared helper.** The cheapest option, and it
would end the disagreement between the seven functions. Rejected: it keeps one fact spelled in two fields,
which is what produced the divergence in the first place, and it leaves the external contract exposing the
ambiguity to another team.

## Consequences

- A storage change and a one-off migration are required. This is the substance of the decision, not a side
  effect: there is no version of this that both shrinks the surface and leaves the store untouched.
- Four repositories change, though most of the change is deletion.
- The journey tests gain a case for a both-processes application, which today has no end-to-end coverage
  because the data generator never produces one.
- The public register stops being able to emit `Glass-remelt-other`.
- Reports, waste balances and PRNs distinguish glass re-melt from glass other wherever they distinguish any
  other material, without each deciding for itself what to do with the process array.

## Open questions for the team

1. **What happens to a stored registration or accreditation that carries both processes?** Splitting it
   during the migration applies the model late, and is what the model says should have happened at ingest.
   The alternative is to flag those records for manual correction, as similar cases have been handled
   before. The answer affects the migration, not the target model.
2. **Is anything other than a submission in flight allowed to hold plain glass?** This ADR says no. Summary
   logs, waste balances, PRNs and the public register all key on material, and each would need to agree.
