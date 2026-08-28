# Glass: what it is, how it is stored, and where the two disagree

Date: 2026-08-27
Status: Findings supporting ADR-0047. The model is settled; how the code should express it is proposed there.
Repos: `epr-backend`, `epr-frontend`, `epr-re-ex-admin-frontend`, `epr-re-ex-journey-tests`
Relates to: [ADR-0047](../decisions/0047-glass-as-two-material-types.md), PAE-837 (glass material type handling), PAE-844, PAE-939

## Why this document exists

Glass has been discussed at least six times and the outcome has never been written
down. Each time, the conclusion lived in a ticket comment or a closed task, and the
next person to touch glass re-derived the model from the code — which does not agree
with itself. This document is the statement that was missing.

## The model

Glass is the only packaging material that sub-divides, and the sub-division is a
**transition**, not a permanent pairing of a material with a qualifier.

1. An organisation applies for a registration for **glass**, and specifies the
   recycling processes separately.
2. That produces a temporary registration document carrying glass plus one or both
   processes.
3. It is then split into specific glass materials. Where both processes were applied
   for, the registration is **duplicated in its entirety** and one process is kept on
   each copy, so a single application can result in two registrations.
4. From that point on, glass re-melt and glass other are **completely separate
   material types**, not glass carrying a process.

An **accreditation is always in the settled state**: there is never an accreditation
for plain glass, only for glass re-melt or glass other.

A **registration** is also in the settled state, except for a short time after
application.

Written as the entities the service really has: there is initially `reg:glass`, which
becomes either or both of `reg:glass-remelt` and `reg:glass-other`; and there is only
ever `acc:glass-remelt` or `acc:glass-other`.

## The store does not express that model

This is the gap that everything else follows from.

`material` is validated against the seven material values — aluminium, fibre, glass,
paper, plastic, steel, wood — in both
`epr-backend/src/repositories/organisations/schema/registration.js:88` and
`schema/accreditation.js:72`. **Neither `glass_re_melt` nor `glass_other` is a
permitted material value.**

So in the database:

- Every glass registration is stored as `material: 'glass'`.
- Every glass accreditation is stored as `material: 'glass'` — the state the model
  says never exists.
- The precise material type lives only in `glassRecyclingProcess`, an array validated
  with `.min(1)` when the material is glass, and no maximum
  (`schema/registration.js:104`, `schema/accreditation.js:83`).

The precise material types exist in code only as a **derived view**:
`TONNAGE_MONITORING_MATERIALS` (`epr-backend/src/domain/organisations/model.js:157`),
built by removing glass from the material list and adding the two processes. It is a
projection, never a stored value.

The domain says two material types. The storage says one material plus a qualifier.
Every reader has to bridge that gap, and they bridge it differently.

## Where the split happens

At **ingest**, not at approval.

`epr-backend/src/forms-submission-data/parsing-common/split-glass-submissions.js`
is applied to registrations (`registration/transform-registration.js:123`) and to
accreditations (`accreditation/transform-accreditation.js:103`). It fires only when a
submission carries **both** processes: `splitIntoRemeltAndOther` clones the whole
submission, keeps the original id for the re-melt copy, and mints a new id for the
other copy.

Two things follow that are easy to get wrong:

- **The split does not change `material`.** Both copies keep `material: 'glass'` and
  differ only in a one-element `glassRecyclingProcess`.
- **A single-process submission is never split**, because there is nothing to split.
  It is already in the settled state as far as the storage can express it.

There is **no approval-time split** and **no migration that splits stored records**.
The one-off migration that renumbered legacy glass records with `GR`/`GO` suffixes has
been removed; `epr-backend/package.json:18` and `jsconfig.json:15` still alias
`#glass-migration/*` to a directory that no longer exists.

The only producer of a two-element array is the "Both" answer on the application form
(`parsing-common/form-data-mapper.js:168`). The journey-test generator never emits it,
so the split path has no end-to-end coverage.

## What each consumer does with it

Seven functions collapse a glass material and its process into one value, and they
behave differently at the edges.

| Function                                                                                  | With no process                                                   | With two processes                   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `epr-backend` `domain/organisations/registration-utils.js:105` `resolveDetailedMaterial`  | returns `'glass'`                                                 | returns `[0]`, discarding the second |
| `epr-backend` `common/helpers/formatters.js:78` `formatMaterial`                          | returns `'Glass'`                                                 | joins to `'Glass-remelt-other'`      |
| `epr-backend` `application/common/material-aggregation.js:23` `effectiveMaterial`         | yields `null`, and the row is silently dropped from the aggregate | takes `[0]`                          |
| `epr-frontend` `common/helpers/materials/get-display-material.js:69` `getDisplayMaterial` | **throws**, 500ing the page                                       | takes `[0]`                          |
| `epr-frontend` `organisations/details/build-view-model.js:48` `toMaterialName`            | passes `'glass'` through                                          | takes `[0]`                          |
| `epr-backend` `packaging-recycling-notes/routes/post.js:57` `snapshotAccreditation`       | omits the field from the snapshot                                 | takes `[0]`                          |
| `epr-backend` `forms-submission-data/submission-keys.js:51` natural key                   | omits the discriminator                                           | omits the discriminator              |

Which of these a client meets depends on the route it reads:

- Routes that collapse — the registration resource at
  `GET /v1/organisations/{organisationId}/registrations/{registrationId}` — emit
  `glass_re_melt` or `glass_other` and never plain glass.
- Routes that do not — `GET /v1/organisations/{organisationId}` (the whole stored
  document), `GET /v1/organisations/{organisationId}/overview`, and every PRN route —
  emit plain `glass`.

## Where the code disagrees with itself

1. **Is plain glass legal on the wire?**
   `routes/v1/organisations/registrations/response.schema.js:50` forbids it, by
   validating against `TONNAGE_MONITORING_MATERIALS`.
   `routes/v1/prn-tonnage/response.schema.js:13` and
   `packaging-recycling-notes/repository/schema.js:34` permit **only** plain glass and
   forbid both processes. Two HTTP contracts over the same underlying record, in
   opposite directions.

2. **A resolver can emit a value its own schema rejects.** `resolveDetailedMaterial`
   returns the literal `'glass'` when the process array is empty, and
   `registrations/get.js:118` feeds that straight into a schema that does not permit
   it. The store's `.min(1)` is what stops this happening in practice, so the
   guarantee is real but nothing states it.

3. **Four behaviours for a process-less glass record**: pass through, throw a 500,
   return `'Glass'`, or vanish from an aggregate.

4. **Four behaviours for a two-process record**: take `[0]`, join both, drop the
   discriminator from the natural key, or "this cannot exist".

5. **The store permits what every consumer says is impossible.** `.min(1)` with no
   maximum and no uniqueness means `['glass_re_melt','glass_other']` and
   `['glass_other','glass_other']` are both valid stored states, contradicting the
   comments at `registration-utils.js:97` and `response.schema.js:46` that assert one
   process per record.

6. **Two shapes for one field.** The organisations store holds an array; the PRN store
   holds a scalar string (`packaging-recycling-notes/repository/schema.js:42`).
   `application/external-prn-mapper.js:67` copies the value through unchanged, so the
   output shape depends on which store the accreditation came from.

7. **Non-glass records disagree about absence.** `valid(null).optional()` in the
   organisations store, `forbidden()` in the PRN store, and unconstrained in the admin
   UI's JSON schema, where a plastic registration may carry a glass process.

8. **The admin UI's write schema is looser than the backend's.**
   `epr-re-ex-admin-frontend/src/server/common/schemas/organisation.json` types
   `glassRecyclingProcess` as `["array","null"]` with `minItems: 1` and `null` in the
   items enum, and does not gate it on the material — so `null` and `[null]` both
   pass. The backend's Joi is the real gate and rejects them, so the invariant holds,
   but only because the looser schema sits in front of a stricter one.

9. **Three display maps in the admin front end alone**, with three behaviours on plain
   glass: `common/helpers/format-material-name.js:21` throws,
   `routes/waste-balance-availability/formatters.js:16` throws, and
   `routes/prn-tonnage/formatters.js:6` maps it to `'Glass'`. The PRN pipeline emits
   plain glass, so the tolerant one is the one that receives it. Two templates
   (`organisation-overview/index.njk:53`, `registration-overview/index.njk:25`) render
   the raw lowercase slug with no map at all.

10. **Three spellings of one name**: `Glass-remelt` in the backend, `Glass remelt` in
    the operator front end, `Glass re-melt` in the admin front end. The journey tests
    assert two of the three, in different suites.

11. **R5 is keyed on plain glass** (`common/helpers/formatters.js:24`,
    `packaging-recycling-notes/domain/get-process-code.js:20`), so
    `application/public-register/public-register-transformer.js` emits a collapsed
    `packagingWasteCategory` beside an un-collapsed `annexIIProcess` derived from the
    same record.

12. **Match rules disagree on whether the process is part of the material.**
    `domain/organisations/validation/rules/material-mismatch.js:26` compares `material`
    only, so a re-melt registration linked to an other accreditation raises nothing.
    `forms-submission-data/submission-keys.js:64` does include the process, but only
    when the array holds exactly one element.

13. **Summary-log matching uses `includes`.**
    `application/summary-logs/validations/material-type.js:53` accepts an upload if the
    registration's process array _contains_ the spreadsheet's process, so a
    two-process registration accepts both a re-melt and an other spreadsheet — and
    every downstream consumer then attributes both to `[0]`.

14. **The operator front end duplicates the derived list and never uses it.**
    `epr-frontend/src/domain/organisations/model.js:116` defines
    `TONNAGE_MONITORING_MATERIALS` identically to the backend; the only reference in
    the repo is the definition. It relies on a separately built list instead.
    `common/helpers/prns/get-recovery-code.js` maps glass to R5 and is never called.

## The history, and why it kept reopening

| When                  | What was decided                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| 20 Jan 2026 (PAE-844) | The schema enforces exactly one process; both together rejected; "Both" removed from the form mapper. |
| 23 Jan 2026 (PAE-939) | Reverted to a maximum of two on all statuses, because the forms submit two.                           |
| 23 Jan 2026           | Split-on-approval deferred "until the one-off migration is complete". Never built.                    |
| 27 Jan 2026           | An unsplit dual-process registration closed as manually entered data.                                 |
| 29 Jan 2026           | A status-reset bug in the splitter closed as rectified by hand.                                       |
| 2 Feb 2026            | PAE-837 closed as "glass material type handling fully implemented".                                   |

Nothing in that trail states what a glass record is allowed to be. The constraint went
from one, to two, to deferred; three problems were closed by fixing data by hand; and
the epic closed as done.

There is also no architecture documentation of the model. The last written version, in
the forms-data logical data model, declared material and recycling process as
independent enums with no cardinality at all — the opposite of the invariant today's
code comments assert.

## Where this goes

These findings are the evidence behind
[ADR-0047: Glass as two material types](../decisions/0047-glass-as-two-material-types.md), which proposes
that `glass_re_melt` and `glass_other` become material types in their own right and that
`glassRecyclingProcess` is confined to the forms-submission layer. The alternative — keeping the two stored
fields and resolving them at a single named boundary — is recorded there as a considered and rejected
option.

Until that decision is taken, any new resource carrying a material has to state which side of it the
resource is on, because the wire is where the two representations meet:

- A response schema built on `TONNAGE_MONITORING_MATERIALS` asserts the settled model, and refuses a record
  that has not reached it.
- A response schema built on the seven material values asserts the storage model, and cannot express the
  precise glass types at all.
- A resource carrying both `material` and `glassRecyclingProcess` passes the ambiguity to its clients, which
  is what produced the divergent collapses catalogued above.
