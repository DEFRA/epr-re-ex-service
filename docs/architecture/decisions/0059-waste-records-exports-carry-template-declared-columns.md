# 59. Waste-records exports carry template-declared columns

Date: 2026-11-18

## Status

Proposed. Amends [ADR-0037](./0037-summary-log-row-states-with-membership.md): row states still store every column a summary log carries, verbatim, but the waste-records CSV exports no longer include columns no template declares.

| ADR                                                    | Title                                  | Relationship                                                                       |
| ------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------- |
| [0037](0037-summary-log-row-states-with-membership.md) | Summary-log row states with membership | Amends: undeclared columns stay stored but leave the waste-records exports.        |
| [0055](0055-summary-log-templates-by-year.md)          | Summary log templates by year          | Builds on: a template change is a new template version, released with the backend. |

## Context

The registration and admin waste-records CSV exports built their header from the stored data: before sending anything, they scanned every row state of the year for the distinct keys of its `data`, then added those keys to the columns the templates declare. ADR-0037 keeps undeclared columns so templates can grow without a coordinated release and those columns reach regulators, and the scan was how they reached the export.

The scan read every row state ever written for the year, superseded and inert ones included, so its cost grew with all stored data rather than with the export. CDP drops a connection that receives nothing for 60 seconds, and nothing could be sent until the scan finished. By November 2026 the regulator export took 34 to 60 seconds to send its first byte in production and about one run in seven was cut off ([PAE-1817](https://eaflood.atlassian.net/browse/PAE-1817)).

The scan found almost nothing the templates do not already declare. Every template's table schema lists its columns as required headers, a summary log missing any of them is rejected, and since ADR-0055 a template change is a new template version released with the backend. The scan's only extra contribution was a column an operator adds to a sheet and names in its hidden header row.

## Decision

The waste-records exports take their data columns from the template registry: every required header of every table of every year's templates. The header no longer depends on stored data, so it is sent before any query runs.

A `data` key no template declares:

- is still stored in the row state, verbatim, as ADR-0037 requires;
- still appears in the per-submission CSV, which builds its header from that submission's own rows;
- is left out of the registration and admin exports, and each export that meets one logs a warning naming each key and the registrations carrying it.

A template revision that adds a column must declare it in the template's table schema for the column to appear in these exports. A revision that does not is caught by that warning the first time an export meets the column.

## Considered alternatives

**Scope the scan to the rows being exported.** Match the summary log ids of the partitions' latest submissions, so the scan covers only exported rows. This fixes the registration export, but the admin export still reads most of the collection, and the first byte still waits on a query.

**Cache the key set, or maintain it at write time.** A cache leaves the first export after each deploy slow; a key registry adds state, a backfill and a write path to answer a question the templates already answer.

**Generate the export in the background and serve a link.** Escapes the 60-second limit entirely, but changes the user journey and the infrastructure, and with the header fixed the exports stream well inside the limit.

## Consequences

### Positive

- The exports send their first byte before any query, whatever the volume of stored data.
- Every export has the same columns, so exports can be combined.
- Inert and superseded row states cannot affect the header.

### Negative

- A column an operator adds outside the template no longer reaches regulators through these exports; they see it only in the per-submission CSV.
- A template revision that forgets to declare a new column loses that column from these exports until the omission is fixed; the warning makes the loss visible, it does not prevent it.

## Related

- [PAE-1817](https://eaflood.atlassian.net/browse/PAE-1817) - the export timeouts this decision resolves
- [epr-backend#2191](https://github.com/DEFRA/epr-backend/pull/2191) - the implementation
