# 55. Summary log templates by year

Date: 2026-11-04

## Status

Proposed

| ADR                                                                            | Title                                                                       | Relationship                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0017](0017-decouple-spreadsheet-data-extraction-from-layout-using-markers.md) | Decouple spreadsheet data extraction from layout using markers              | Builds on: the new year marker follows its `__EPR_META_` convention.                                                                                                       |
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

### The template states its year

Templates from 2027 onwards carry a new metadata marker, `__EPR_META_TEMPLATE_YEAR`, following the
convention in ADR 0017. Its value is the reporting year the template is for.

A file without the marker is a 2026 template only if its `__EPR_META_TEMPLATE_VERSION` is one the
2026 definitions accept for its processing type. This covers every template in use today, so they
need not be reissued, and they become valid for 2026 uploads only. A file with no marker and any
other version fails meta syntax validation with `TEMPLATE_YEAR_INVALID`, so a 2027 template that has
lost its marker is not read as a 2026 one.

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

### The template version is a revision within a year

`__EPR_META_TEMPLATE_VERSION` keeps its meaning as the revision of a template, and each year has its
own minimum versions. It no longer has to tell one year's template from another's. For 2026 the
definitions also hold a maximum version, which bounds the files read as 2026 when they carry no
marker.

### Order of validation

1. Meta syntax, including that the template year is one the service has definitions for, and that
   the template version is one that year accepts. Both use the template's own year: its marker, or
   2026 when it has none. The year in the address is not used until step 2, so a template from
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
  such as `TONNAGE_RECEIVED_FOR_RECYCLING`, from a row's data. Making them independent of a year's
  layout is decided separately. Until it is, a 2027 column they read must keep its header and
  meaning.

## Alternatives considered

### Version bands

Give each year a range of template versions for each processing type, and work out the year from the
version, so the 2026 templates need no change.

Rejected because the version would then mean the year as well as the revision, without saying so. A
fix to a 2026 template could run into the 2027 range, and the registered-only templates already
number their versions differently from the others, so each processing type would need its own bands.
A mismatch error would also have to work out the year from the version before it could report it.

### A template identity marker

Add a marker naming the template, such as `__EPR_META_TEMPLATE_ID` with a value of `exporter-2027`.
Each set of definitions lists the identities it accepts and the year it applies to.

Rejected because the identity repeats `__EPR_META_PROCESSING_TYPE`, leaving two markers that must
agree, and it is more general than anything needed now. It would also cover a template replaced
part-way through a year, which nobody has asked for.

## Consequences

### For template authors

The 2027 templates have not been written yet. Each of them, for every processing type, needs:

- **A `__EPR_META_TEMPLATE_YEAR` marker** next to the existing `__EPR_META_` markers, hidden in the
  same way, with the year in the cell to its right as a whole number, `2027`, not a date or text.
  Without it the file is read as a 2026 template and every 2027 upload of it is rejected.
- **The existing metadata markers kept**: `__EPR_META_PROCESSING_TYPE`,
  `__EPR_META_TEMPLATE_VERSION`, `__EPR_META_MATERIAL`, `__EPR_META_REGISTRATION_NUMBER` and,
  for accredited templates, `__EPR_META_ACCREDITATION_NUMBER`.
- **A template version agreed with the development team.** The version no longer separates years, so
  the 2027 numbering does not have to follow on from 2026. The service rejects versions below the
  2027 minimum, so a template must not be published until its version is supported.
- **Every data section and column shared with the development team before publication.** The 2027
  definitions are written from them, and any `__EPR_DATA_` marker or header that changes after that
  needs a matching change in the service.
- **The fields other features read kept stable, or flagged early.** A column that reports, the waste
  balance or tonnage monitoring read should keep its header and meaning. If it has to change, the
  development team needs to know before the template is final.

The 2026 templates need no change.

### Every year needs its own templates

A template is legal for one year only, so 2028 needs a new batch of templates, and so does every
year after it. This holds even when nothing else changes: a 2028 template that only differs from the
2027 one by its `__EPR_META_TEMPLATE_YEAR` value still has to be published, and operators still have
to download it. The service needs definitions for 2028 before the first 2028 upload, though they can
reuse 2027's if the layout is unchanged.

### For the service

- The rule that a file without a template year is a 2026 template is permanent.
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
