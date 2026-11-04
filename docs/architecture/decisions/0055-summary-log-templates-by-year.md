# 55. Summary log templates by year

Date: 2026-11-04

## Status

Proposed

Builds on [ADR 0017](0017-decouple-spreadsheet-data-extraction-from-layout-using-markers.md),
[ADR 0048](0048-dual-multi-year-summary-logs.md) and
[ADR 0053](0053-address-resources-by-natural-key-and-year.md).

## Context

From 2027 operators upload summary logs on all-new templates, published on GOV.UK. The 2027
templates are structurally different from the 2026 ones: their sheets, columns and validation rules
change. The templates in use today must then be accepted only for 2026 uploads, and the new ones only
for 2027 uploads.

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

A file without the marker is a 2026 template. This covers every template in use today, so they need
not be reissued, and they become valid for 2026 uploads only.

### The address decides the year, and the template must match it

The year in the upload's address is the year the summary log is for. Validation compares the
template's year with it, and a mismatch is a fatal error with its own code, such as
`TEMPLATE_YEAR_MISMATCH`, so the frontend can tell it apart from other template failures. A template
year that the service has no definitions for, such as a future year, fails meta syntax validation
with a code of its own, such as `TEMPLATE_YEAR_INVALID`.

What the operator is told, and whether they are pointed at the right template, is outside this ADR.

### Definitions are held by year

The definitions for a template's tables (sheets, headers, validation schemas and row transformers)
are looked up by year, then by processing type. Validation, extraction and transformation use the
definitions for the summary log's year.

This ADR does not decide whether the 2027 definitions extend the 2026 ones or are written separately.
The lookup supports either.

### The template version is a revision within a year

`__EPR_META_TEMPLATE_VERSION` keeps its meaning as the revision of a template, and each year has its
own minimum versions. It no longer has to tell one year's template from another's.

### Order of validation

1. Meta syntax, including that any template year is one the service knows.
2. Template year against the year in the address.
3. Meta business rules, such as processing type, registration, material and accreditation.
4. Data syntax, using the definitions for that year.

The year check comes before data syntax because the year chooses the definitions data syntax uses.

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

- The rule that a file without a template year is a 2026 template is permanent.
- Template authors must add `__EPR_META_TEMPLATE_YEAR` to every 2027 template and every later one.
- Validation needs the summary log's year, which it does not read today.
- The table definitions move behind a lookup by year and processing type.
- The frontend needs a message for the new error code.
- A summary log for 2026 that is uploaded or resubmitted during 2027 is posted to the 2026 address,
  so it still uses the 2026 template.
- If a change to how cross-year loads are recorded alters the 2027 template, it is made in the 2027
  definitions and does not affect 2026.
