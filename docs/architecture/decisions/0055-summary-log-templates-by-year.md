# 55. Summary log templates by year

Date: 2026-11-04

## Status

Proposed. One choice is open: how a template states its year. Three options are set out below.

| ADR                                                                            | Title                                                                       | Relationship                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0017](0017-decouple-spreadsheet-data-extraction-from-layout-using-markers.md) | Decouple spreadsheet data extraction from layout using markers              | Builds on: every option states the year through its `__EPR_META_` markers, a new one or the existing version marker.                                                       |
| [0048](0048-dual-multi-year-summary-logs.md)                                   | Dual and multi-year summary logs for registration and accreditation periods | Depends on Part 1: row states, row history and the ledger are scoped by year, and a summary log is compared only with the previous submission for its own year and stream. |
| [0053](0053-address-resources-by-natural-key-and-year.md)                      | Address resources by natural key and year                                   | Builds on: the year in the upload's address is the year the template must match.                                                                                           |

## Context

From 2027 operators upload summary logs on all-new templates, published on GOV.UK. The 2027
templates may differ from the 2026 ones in their sheets, columns and validation rules, so the service
must be able to treat them differently from the outset. The templates in use today must then be
accepted only for 2026 uploads, and the new ones only for 2027 uploads.

ADR 0048 requires one summary log per year for each stream, and ADR 0053 puts the year in the address
an upload is posted to. The year is stored on every summary log. Nothing yet connects that year to the
template in the file:

- Validation does not read the summary log's year.
- A template identifies itself by `__EPR_META_PROCESSING_TYPE` and `__EPR_META_TEMPLATE_VERSION`.
  The version is checked against a minimum for each processing type, with no maximum. A 2027
  template with a higher version would pass on a 2026 upload.
- The definitions that validate, extract and transform a template's tables are held once for each
  processing type, with no notion of year.

## Decision

### How the template states its year

Every template has a year: the reporting year it is for. There are three options for how a file
states it. All three leave the templates in use today unchanged and valid for 2026 only, and the rest
of this decision applies to any of them.

#### Option A: a year marker

Templates from 2027 onwards carry a new metadata marker, `__EPR_META_TEMPLATE_YEAR`, with the year as
a whole number. A file without the marker is a 2026 template. `__EPR_META_TEMPLATE_VERSION` stays the
revision of a template within its year, and each year has its own minimum version.

#### Option B: the year in the template version

Templates from 2027 onwards carry the year as the whole-number part of `__EPR_META_TEMPLATE_VERSION`.
For example, `2027.01` is the first revision of a 2027 template. A version below 2027 is a 2026
template, which is how today's templates are numbered. Each year has its own minimum version within
its range.

#### Option C: a major version for each year

Each year's templates take the next major version of `__EPR_META_TEMPLATE_VERSION`, and only minor
revisions happen within a year. Today the 2026 templates are version 5 for the exporter and
reprocessor templates, and version 2 (from 2.1) for the registered-only ones, so the 2027 templates
would be 6 and 3. Each year's definitions hold the major version for each processing type, and the
year is the one whose definitions hold the file's major version.

These numbers were checked on 4 November 2026 against the latest templates published on
[GOV.UK](https://www.gov.uk/government/publications/summary-log-templates-for-uk-packaging-waste),
last updated 19 May 2026:

| Template                         | Processing type               | Version in the file |
| -------------------------------- | ----------------------------- | ------------------- |
| Accredited reprocessors (input)  | `REPROCESSOR_INPUT`           | 5.1                 |
| Accredited reprocessors (output) | `REPROCESSOR_OUTPUT`          | 5.1                 |
| Accredited exporters             | `EXPORTER`                    | 5.1                 |
| Registered-only reprocessors     | `REPROCESSOR_REGISTERED_ONLY` | 2.1                 |
| Registered-only exporters        | `EXPORTER_REGISTERED_ONLY`    | 2.1                 |

No published template uses major version 6 or 3.

#### Trade-offs

Under every option the year is held in hidden, locked metadata cells. Operators cannot see or edit
them, so only template authors can get the year wrong, once for each template, before it is
published. The rows on leaving the year out or getting it wrong describe authoring mistakes, which
testing a template before publication catches. Likewise, "Reading the file" matters to template
authors and the development team, not to operators.

|                                   | Option A: year marker                                                            | Option B: year in the version                                                                                                                                     | Option C: a major version for each year                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| New metadata                      | One new marker                                                                   | None                                                                                                                                                              | None                                                                                                    |
| How a 2026 template is recognised | It has no marker                                                                 | Its version is below 2027                                                                                                                                         | Its major version is a 2026 one: 5, or 2 for registered-only                                            |
| What one field means              | The marker is the year, and the version is the revision                          | The version is both the year and the revision                                                                                                                     | The version is both the year and the revision                                                           |
| If the author leaves the year out | The marker can be left off. The file is then read as a 2026 template (see Risks) | The version cannot be left off, since a file without one already fails with `TEMPLATE_VERSION_REQUIRED`                                                           | The version cannot be left off, since a file without one already fails with `TEMPLATE_VERSION_REQUIRED` |
| If the author gets the year wrong | A wrong value in the marker gives the wrong year                                 | A version typed wrongly, or numbered the old way, gives the wrong year                                                                                            | A version typed wrongly, or a major bump made within a year, gives the wrong year                       |
| Revision numbering                | Unchanged                                                                        | The version is read as a number, so `2027.10` and `2027.1` are the same. Revisions need a fixed form, such as two digits (`2027.01`) or a whole number (`202701`) | Unchanged, apart from the rule that a major bump only happens between years                             |
| Reading the file                  | The year is visible in its own field                                             | The year has to be read out of the version                                                                                                                        | The year is not in the file, and is found from the version through the definitions                      |
| Rule that stays for good          | No marker means 2026                                                             | A version below 2027 means 2026                                                                                                                                   | Major versions 5 and 2 mean 2026                                                                        |

### The address decides the year, and the template must match it

The year in the upload's address is the year the summary log is for. Validation compares the
template's year with it, and a mismatch is a fatal error with its own code, such as
`TEMPLATE_YEAR_MISMATCH`, so the frontend can tell it apart from other template failures. A template
year that the service has no definitions for, such as a future year, fails meta syntax validation
with a code of its own, such as `TEMPLATE_YEAR_INVALID`.

An upload can only be started for a year the service has definitions for. This is checked when the
upload is created, alongside the existing checks that the year has started and the registration is
active, so the operator is told before sending a file. It rejects years before 2026, and a new year
whose definitions have not been deployed.

### Definitions are held by year

The definitions for a template's tables (sheets, headers, validation schemas and row transformers)
are looked up by year, then by processing type. Every use of them names the year:

- **Upload**: validation, extraction and transformation use the summary log's year.
- **Submission** reads the stored file again, and uses the stored summary log's year, so the file is
  read with the same definitions it was validated with.
- **Stored rows** are read with the row's own year. Under ADR 0048 every row state carries the year
  of its summary log, and the template's year must equal that, so the row's year is also its
  template's year and no separate template year is stored.

Looking up definitions for a year and processing type that have none is an error, not an empty
result. Today an unknown processing type quietly turns into no schema: the waste balance treats the
row as not applicable, and transformation produces no records. That must not carry over to the year.

Every lookup takes a year, and the lookups without one are removed. A reader cannot skip the year by
mistake, so there is no list of readers to keep up to date.

A stored row without a year is an error, never read as 2026. Row years, and their backfill from ADR
0048, must ship before the first 2027 submission.

### Processing types come from the definitions

A year's processing types are the keys of its definitions. Meta syntax validation accepts only
those, with their minimum versions, and there is no list held anywhere else. Whether a table feeds
the waste balance is already in its definition, as `classifyForWasteBalance`, and whether a
processing type resolves overseas sites joins it there. Neither is kept as a separate list of
processing types.

### Order of validation

1. Meta syntax, including that the template year is one the service has definitions for, and that
   the template version meets that year's minimum. Both use the template's own year, read as the
   chosen option sets out. The year in the address is not used until step 2, so a template from
   another year fails as `TEMPLATE_YEAR_MISMATCH` and not as an unrecognised version.
2. Template year against the year in the address.
3. Meta business rules, such as processing type, registration, material and accreditation.
4. Data syntax, using the definitions for that year.

The year check comes before data syntax because the year chooses the definitions data syntax uses.

### Out of scope

- **Whether the 2027 definitions extend the 2026 ones or are written separately.** The lookup by
  year supports either.
- **What the operator is told** when the template's year does not match, and whether they are
  pointed at the right template.
- **The contents of the 2027 templates.**
- **Loads that start in 2026 and conclude in 2027.** How they are captured is decided separately. If
  that decision changes the 2027 template, the change goes in the 2027 definitions and does not
  affect 2026.
- **How other features read stored rows.** Reports, the waste balance, tonnage monitoring, period
  status, the report completeness check and stored tonnage conversion read named template fields,
  such as `TONNAGE_RECEIVED_FOR_RECYCLING`, from a row's data. A 2027 template may rename or change
  one of those fields. That is not expected, but it is not ruled out, and how these features would
  cope with it is decided separately.

## Alternatives considered

### A template identity marker

Add a marker naming the template, such as `__EPR_META_TEMPLATE_ID` with a value of `exporter-2027`.
Each set of definitions lists the identities it accepts and the year it applies to.

Rejected because the identity repeats `__EPR_META_PROCESSING_TYPE`, leaving two markers that must
agree, and it is more general than anything needed now. It would also cover a template replaced
part-way through a year, which nobody has asked for.

## Consequences

### For template authors

The 2027 templates have not been written yet. Each of them, for every processing type, needs:

- **The year stated as the chosen option sets out.**
  - Option A: a `__EPR_META_TEMPLATE_YEAR` marker next to the existing `__EPR_META_` markers, hidden
    in the same way, with the year in the cell to its right as a whole number, `2027`, not a date or
    text.
  - Option B: a `__EPR_META_TEMPLATE_VERSION` whose whole-number part is the year, with the revision
    written in the agreed fixed form, such as `2027.01`.
  - Option C: the next major version of `__EPR_META_TEMPLATE_VERSION` for its processing type, such
    as 6 for the exporter template, and only minor revisions after that until the next year.
- **The existing metadata markers kept**: `__EPR_META_PROCESSING_TYPE`,
  `__EPR_META_TEMPLATE_VERSION`, `__EPR_META_MATERIAL`, `__EPR_META_REGISTRATION_NUMBER` and,
  for accredited templates, `__EPR_META_ACCREDITATION_NUMBER`.
- **A template version agreed with the development team.** The service rejects versions below the
  2027 minimum, so a template must not be published until its version is supported.
- **Every data section and column shared with the development team before publication.** The 2027
  definitions are written from them, and any `__EPR_DATA_` marker or header that changes after that
  needs a matching change in the service.
- **Changes to the fields other features read flagged early.** If a column that reports, the waste
  balance or tonnage monitoring read changes its header or meaning, the development team needs to
  know before the template is final.

The 2026 templates need no change.

### Every year needs its own templates

A template is legal for one year only, so 2028 needs a new batch of templates, and so does every
year after it. This holds even when nothing else changes: a 2028 template that only differs from the
2027 one by its year still has to be published, and operators still have to download it. The service
needs definitions for 2028 before the first 2028 upload, though they can reuse 2027's if the layout
is unchanged.

### Risks

**A 2027 template that does not state its year correctly is read as another year.** Under option A
this happens if the marker is left off, and the file is read as 2026. Under option B it happens if
the version is typed wrongly or numbered the old way. Under option C it happens if the version is
typed wrongly, or if a major bump is made within a year. In every case the file is rejected on 2027
uploads, so the mistake is visible there. On an upload for the year it is wrongly read as, it is
validated against that year's definitions:

- If its layout differs, it fails data syntax validation with errors about missing sheets or
  headers, which do not tell the operator the real problem.
- If it has the same headers with a different meaning, it is accepted, and its rows are read with
  the other year's meaning.

This is an authoring mistake, not one an operator can make, because the cells are hidden and locked.
It is made once per template, so the safeguard is the template authors' checklist above, and
testing each template with the service before it is published.

### For the service

- The rule that identifies a 2026 template (no marker, a version below 2027, or a 2026 major
  version, depending on the option) is permanent.
- Validation and submission need the summary log's year, which neither reads today.
- The table definitions move behind a lookup by year and processing type, and every reader of
  stored rows passes the row's year to it.
- The parser normalises placeholder values with one map, built from every template's columns before
  the template is known. It changes to read the metadata first, and then parse the tables with the
  map for that year and processing type. A map covering every year would let one year's placeholder
  values blank out real values in another year's cells.
- The waste records export spans a registration's years, and its columns are the union of every
  template's fields. A 2027 column renamed from a 2026 one shows as two columns, so the export
  needs a year column to tell the two apart.
- The frontend needs messages for `TEMPLATE_YEAR_MISMATCH` and `TEMPLATE_YEAR_INVALID`. They must
  ship before or with the backend change, because the frontend shows its technical-error message for
  a code it does not know.
- A summary log for 2026 that is uploaded or resubmitted during 2027 is posted to the 2026 address,
  so it still uses the 2026 template.
