# 48. Dual and multi-year summary logs for registration and accreditation periods

Date: 2026-08-28

## Status

Proposed

## Context

An operator can hold a registered-only period and an accredited period for the same registration at
the same time — status changed mid-quarter — and can go through this again in later years, since
accreditation is renewed annually while the registration itself continues unchanged. Today a summary
log (SL) is keyed only by `{organisationId, registrationId}`, with no concept of which stream or which
year it belongs to. This already causes two problems. First, after a registered-only → accredited transition, historical
rows are excluded from report aggregation because the date field name changes — the data is still in
the database, just unused, not lost. Second, an upload is only accepted for the registration's current
status: if the operator is currently accredited, they can only upload an accredited file, and if
currently registered-only, only a registered-only file. There is no way to hold both open at once, so
an operator who genuinely needs to submit for both streams in the same period simply cannot. The same
gap recurs every year, for every registration, once a second reporting cycle exists to collide with
the first.

This ADR builds on [ADR 0034](0034-multi-year-accreditation-model.md), which decided the underlying
data model: `registrationId` + `year` on `org.accreditations[]`, one accreditation per registration
per year. This ADR decides how summary logs, row state, waste balance and reports attach to that
model, along both axes at once — two streams live within one year, and the same registration carrying
a new SL every year, indefinitely.

## Part 1 — Storage

**Every stream is scoped to `{registrationId, year, accreditationId}`, and a new SL is required every
calendar year, for both streams.** `accreditationId` is `null` for registered-only, and the year's
accreditation id otherwise. A registration spans years unchanged, but nothing about its
data does: each calendar year gets its own registered-only SL and, if accredited, its own accredited
SL, with no carry-over of rows, balance or continuity obligations across a year boundary. Within one
year, both streams can be open concurrently.

This matters because `accreditationId` is the only field distinguishing a registered-only row from an
accredited one, and it is `null` for every registered-only year. Without an explicit `year`, 2026 and
2027 registered-only data are indistinguishable in storage — not just at the SL level, but everywhere
downstream that currently keys off `accreditationId` alone:

- **SL identity and uniqueness**: `{organisationId, registrationId, year, accreditationId}`. The SL
  uniqueness index (currently `{organisationId, registrationId}`, unique while `status: 'submitting'`)
  gains `year` and `accreditationId`, so a new year's upload never collides with the prior year's, and
  both streams can be in-flight within the same year.
- **Row-state identity**: today's unique key
  (`{organisationId, registrationId, accreditationId, rowId, wasteRecordType, contentHash}`) has the
  same gap — it gains `year`. Without it, a 2027 registered-only row can collide with, or be silently
  treated as a re-submission of, a 2026 row sharing the same `rowId`/`wasteRecordType`.
- **Row history**: the `row_history` lookup (`{organisationId, registrationId, rowId, wasteRecordType}`)
  finds a row's history independent of any specific SL, so it gains both `year` and `accreditationId`.
  Each stream mints its own `rowId` space, so a rowId from one stream has no relationship to the same
  `rowId` in the other stream — the lookup should not span streams any more than it should span years.
- **Row continuity**: the "previous submission" a new upload is checked against is loaded via that
  upload's own SL, which is already year- and stream-scoped once SL identity includes `year` and
  `accreditationId`, so no separate change is needed here. The rule that a new upload must include
  every prior `rowId` or be rejected applies only within the same SL — never across a year boundary,
  and never across streams. A new year's first upload starts fresh, with no obligation to restate any
  prior year's rows.
- **Waste-balance ledger**: the ledger is event-sourced, grouped by
  `{organisationId, registrationId, accreditationId}` with entries positioned by an incrementing
  `number`. For accredited streams this is already year-isolated for free, because `accreditationId`
  changes every year. For registered-only it is not — `accreditationId` stays `null` every year, so
  without `year` in the grouping key, 2026 and 2027 registered-only ledger entries would land in the
  same stream, with balances carrying across a year boundary that should never mix. The grouping key
  becomes `{organisationId, registrationId, year, accreditationId}` for both streams.
- **Reports**: cadence belongs to the stream, not the registration. Registered-only is always
  quarterly, accredited is always monthly, and both can apply at once. This replaces
  `isRegistrationAccredited(registration) ? monthly : quarterly` (`src/reports/routes/get.js`), which
  looks at current status rather than the stream being requested.
- **Upload validation**: with the route itself identifying the year and stream (Part 2), the target SL
  is no longer inferred from the file — it's created on first upload of the year for that stream, or
  rejected on the accredited branch if no accreditation is open for that year. `meta.PROCESSING_TYPE`
  on the uploaded file still distinguishes registered-only from accredited templates, so it is checked
  against the endpoint's stream and rejected on mismatch, catching a file uploaded to the wrong
  endpoint.

## Part 2 — Endpoints

Every stream nests under `accreditations/`, matching the shape PRN already uses. `{year}` sits
immediately after `{registrationId}`, not before it: the registration is the stable anchor spanning
years, so the year belongs to what comes after it, not to the registration's own address. The two
branches then differ only in the accreditation slot — a real `accreditationId`, or a `registered-only`
sentinel for the non-accredited stream:

```
.../registrations/{registrationId}/{year}/accreditations/{accreditationId}/summary-logs/...
.../registrations/{registrationId}/{year}/accreditations/registered-only/summary-logs/...

.../registrations/{registrationId}/{year}/accreditations/{accreditationId}/reports/{cadence}/...
.../registrations/{registrationId}/{year}/accreditations/registered-only/reports/{cadence}/...

.../registrations/{registrationId}/{year}/accreditations/{accreditationId}/waste-balance-ledger
.../registrations/{registrationId}/{year}/accreditations/registered-only/waste-balance-ledger
```

`year` is stated explicitly even on the accredited branch, where `accreditationId` already implies it,
so every URL states its year without a lookup and both branches stay symmetric. `{cadence}` stays in
the reports path for readability but no longer decides stream on its own — the route branch does. The
reports path's previous `{year}` segment (`.../reports/{year}/{cadence}/...`) is removed; only the one
after `registrationId` remains.

`registered-only` was chosen over a bare `none` because it matches the domain's existing vocabulary
(`REGISTERED_ONLY_PROCESSING_TYPES`, `OPERATOR_CATEGORY.*_REGISTERED_ONLY`) and the kebab-case slug
convention already used throughout the API.

PRN routes are left as they are: PRNs are accredited-only, so there is no registered-only variant to
unify, and adding `year` there is out of scope here.

**Frontend**: the "Select material" list shows one row per registration. A registration with both a
registered-only and an accredited SL open in the current year shows two rows, one per stream — not
just because an accreditation happens to be linked, but because both streams genuinely have data to
upload or view.

## Alternatives considered

- **One continuous SL per stream, year derived from row dates.** Rejected — there is a business
  requirement for one SL per year regardless of stream, not just a preference. It would also leave a
  registered-only SL growing unbounded year over year; these files are already large for big operators
  within a single year.
- **Query param instead of a path segment** (`?stream=&year=`). Rejected — breaks bookmarkable,
  cacheable per-stream URLs and contradicts the path-based convention PRN and waste-balance already
  use.
- **Optional path segment** (`accreditations/{accreditationId?}/...`) instead of a sentinel. Rejected
  — same intent as the sentinel, but awkward to express in Hapi routing without effectively
  registering two routes anyway.

## Consequences

- `accreditationsForRegistration` must correctly reflect a mid-year approve → cancel → reapprove
  cycle.
- `findLatestSubmittedForOrgReg`, `findAllByOrgReg`, and the row-state/row-history/continuity queries
  all gain `year` (and, where missing, `accreditationId`) to their scope.
- `markActiveReportsStaleForSummaryLog` needs stream and year isolation, so a submission in one
  stream/year never staleness-flags a report in another.
- Reports and waste-balance-ledger routes are breaking changes to already-shipped endpoints: the
  `{year}` segment moves position, and the ledger route gains one it didn't have.
- Needs coordination with WS1: `epr-re-ex-admin-frontend`'s in-flight regulator registration-details
  page (PAE-1851) for a mid-year approve → cancel → reapprove cycle. The
  `none`/`registered-only` sentinel choice is also still unresolved between the two workstreams.
- `Registration.validTo` should be removed — registrations don't expire (tracked separately in
  PAE-1904); only accreditations have a meaningful, annually-renewed `validTo`.
- Backfill is needed. All existing SL, row-state and ledger records — registered-only and accredited
  alike — predate `year` and don't have it; default it to 2026 for all of them, since no prior year's
  data exists under this model. Anywhere `accreditationId` is newly added (the `row_history` index,
  the ledger grouping key), existing records need it populated too, from their current `accreditationId`
  value where one already exists elsewhere on the record.
