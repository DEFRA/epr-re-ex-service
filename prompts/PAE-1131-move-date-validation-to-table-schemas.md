# PAE-1131: Move Date Validation into Waste Balance Table Schemas

The date-based row inclusion check currently lives in two places: the validation layer (`validate.js` lines 233-294) and indirectly in the calculator (`calculator.js` via `isWithinAccreditationDateRange`). This creates a gap — `markExcludedRecords` in `helpers.js` re-runs schema validation but does not re-run the date check, so rows can slip through.

This ticket moves the "should this row be included based on its dates?" logic into each of the 3 waste-balance table schemas (`exporter`, `reprocessor-input`, `reprocessor-output`), and introduces a single shared helper that accepts a list of dates and returns the `ROW_OUTCOME` status to apply.

## Requirements

- Each of the 3 waste-balance table schemas must export a function that determines whether a row should be included based on the dates pertinent to that summary log type
- The date fields used per type must match what the **current** validator code uses (not the legislatively correct fields — that is a separate fix):
  - **Exporter**: `DATE_OF_EXPORT || DATE_RECEIVED_FOR_EXPORT || DATE_LOAD_LEFT_SITE` (first truthy wins)
  - **Reprocessor Input**: `DATE_RECEIVED_FOR_REPROCESSING || DATE_LOAD_LEFT_SITE`
  - **Reprocessor Output**: `DATE_RECEIVED_FOR_REPROCESSING || DATE_LOAD_LEFT_SITE (reprocessed) || DATE_LOAD_LEFT_SITE (sent-on)`
- A single shared helper function (in `common/helpers/dates/`) should accept a list of dates and an accreditation, and return `IGNORED` if any date falls outside the accreditation date range, or `null`/`undefined` otherwise (i.e. "no status override")
- The calculator (`calculator.js`) should no longer perform the `isWithinAccreditationDateRange` check itself — this responsibility moves to the table schemas
- The validation layer (`validate.js`) functions `validateExporterDates`, `validateReprocessorInputDates`, and `validateReprocessorOutputDates` should be replaced by calls to the table schema functions
- Existing behaviour must be preserved: rows with dates outside the accreditation period get `IGNORED` outcome

## Rules

- prompts/rules/coding-style.md
- prompts/rules/testing.md
- prompts/rules/architecture.md

## Domain

**Current date fields per processing type** (from `validate.js`):

```
Exporter:
  DATE_OF_EXPORT || DATE_RECEIVED_FOR_EXPORT || DATE_LOAD_LEFT_SITE

Reprocessor Input:
  DATE_RECEIVED_FOR_REPROCESSING || DATE_LOAD_LEFT_SITE

Reprocessor Output:
  DATE_RECEIVED_FOR_REPROCESSING || DATE_LOAD_LEFT_SITE (reprocessed) || DATE_LOAD_LEFT_SITE (sent-on)
```

**Shared helper pseudo-code:**

```
isWithinAccreditationDateRange(dates, accreditation) -> ROW_OUTCOME.IGNORED | null
  for each date in dates:
    if date is truthy AND not within accreditation date range:
      return IGNORED
  return null
```

**Row outcome model** (from `validation-pipeline.js`):

```
ROW_OUTCOME = { REJECTED, EXCLUDED, INCLUDED, IGNORED }
```

## Extra Considerations

- The date fields used here are known to be incorrect for Exporter (should check `DATE_OF_EXPORT` AND `DATE_RECEIVED_BY_OSR` per Reg 92(2)(b)) — this will be corrected in a follow-up ticket. For now, preserve current behaviour exactly.
- The `||` fallback chain means only the first truthy date is checked — this matches the current `validate.js` behaviour
- Sent-on loads for Reprocessor Output and Received loads for Reprocessor Output don't contribute to waste balance (empty `fieldsRequiredForInclusionInWasteBalance`), but the date check should still apply for consistency with current behaviour
- The delta mechanism in the calculator means previously-credited rows will be debited back if a re-calculation finds them now excluded

## Testing Considerations

- **Unit tests — shared helper**: Test `isWithinAccreditationDateRange` returns `IGNORED` when any date is outside range; returns `null` when all dates are within range; handles null/undefined dates gracefully; handles empty dates array
- **Unit tests — table schema functions**: Test each schema's date extraction returns the correct date field(s) for the row data, matching current `validate.js` behaviour
- **Unit tests — calculator**: Verify `isWithinAccreditationDateRange` is no longer called from the calculator
- **Unit tests — validate.js**: Verify the inline date validation functions are replaced by table schema calls
- **Integration**: End-to-end flow where rows with out-of-range dates get `IGNORED` outcome

### Key test scenarios

1. Row with date inside accreditation range -> not ignored
2. Row with date outside accreditation range -> IGNORED
3. Row with no date field populated -> not ignored (no date to check)
4. Multiple date fields, first truthy one is outside range -> IGNORED
5. Multiple date fields, first truthy one is inside range -> not ignored

## Implementation Notes

- **New shared helper**: Create `isWithinAccreditationDateRange(dates, accreditation)` in `common/helpers/dates/accreditation.js` alongside the existing `isWithinAccreditationDateRange`. It takes an array of dates and returns `ROW_OUTCOME.IGNORED` or `null`.
- **Table schema functions**: Each waste-balance table schema (`exporter`, `reprocessor-input`, `reprocessor-output`) should export a function like `getRowStatus(record, accreditation)` that:
  1. Extracts the relevant date(s) from the record data using the same fallback chain as the current `validate.js`
  2. Calls the shared helper with those dates
  3. Returns the result
- **Calculator cleanup**: Remove `isWithinAccreditationDateRange` import and usage from `calculator.js`. The `getTargetAmount` function should call the appropriate table schema function instead.
- **Validate.js cleanup**: Replace `validateExporterDates`, `validateReprocessorInputDates`, `validateReprocessorOutputDates` with calls to the table schema functions.

### Key files

| File                                                                                                               | Change                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `lib/epr-backend/src/common/helpers/dates/accreditation.js`                                                        | Add `isWithinAccreditationDateRange(dates, accreditation)` helper                                        |
| `lib/epr-backend/src/domain/waste-balances/table-schemas/exporter/validators/waste-balance-extractor.js`           | Add `getRowStatus` using `DATE_OF_EXPORT \|\| DATE_RECEIVED_FOR_EXPORT \|\| DATE_LOAD_LEFT_SITE`         |
| `lib/epr-backend/src/domain/waste-balances/table-schemas/reprocessor-input/validators/waste-balance-extractor.js`  | Add `getRowStatus` using `DATE_RECEIVED_FOR_REPROCESSING \|\| DATE_LOAD_LEFT_SITE`                       |
| `lib/epr-backend/src/domain/waste-balances/table-schemas/reprocessor-output/validators/waste-balance-extractor.js` | Add `getRowStatus` using `DATE_RECEIVED_FOR_REPROCESSING \|\| DATE_LOAD_LEFT_SITE (reprocessed/sent-on)` |
| `lib/epr-backend/src/domain/waste-balances/calculator.js`                                                          | Remove `isWithinAccreditationDateRange` usage, delegate to table schema                                  |
| `lib/epr-backend/src/application/summary-logs/validate.js`                                                         | Replace inline date validation functions with table schema calls                                         |

## Specification by Example

**Scenario: Shared helper with dates outside range**

```js
const accreditation = { validFrom: '2025-01-01', validTo: '2025-12-31' }

isWithinAccreditationDateRange(['2025-06-15'], accreditation)
// -> null (within range)

isWithinAccreditationDateRange(['2024-11-01'], accreditation)
// -> 'IGNORED' (before range)

isWithinAccreditationDateRange([null, '2025-06-15'], accreditation)
// -> null (null skipped, second date within range)

isWithinAccreditationDateRange([], accreditation)
// -> null (no dates to check)
```

**Scenario: Exporter row date extraction**

```js
// Row with DATE_OF_EXPORT populated
const data = {
  DATE_OF_EXPORT: '2025-06-15',
  DATE_RECEIVED_FOR_EXPORT: '2025-05-01'
}
// -> checks '2025-06-15' (first truthy in chain)

// Row with only DATE_RECEIVED_FOR_EXPORT
const data = { DATE_RECEIVED_FOR_EXPORT: '2025-05-01' }
// -> checks '2025-05-01' (fallback)

// Row with only DATE_LOAD_LEFT_SITE (sent-on loads)
const data = { DATE_LOAD_LEFT_SITE: '2025-07-01' }
// -> checks '2025-07-01' (final fallback)
```

## Verification

- [ ] Shared helper `isWithinAccreditationDateRange` returns `IGNORED` for dates outside accreditation range
- [ ] Shared helper returns `null` for dates within range
- [ ] Shared helper handles null/undefined/empty dates array
- [ ] Exporter table schema checks `DATE_OF_EXPORT || DATE_RECEIVED_FOR_EXPORT || DATE_LOAD_LEFT_SITE`
- [ ] Reprocessor Input table schema checks `DATE_RECEIVED_FOR_REPROCESSING || DATE_LOAD_LEFT_SITE`
- [ ] Reprocessor Output table schema checks `DATE_RECEIVED_FOR_REPROCESSING || DATE_LOAD_LEFT_SITE`
- [ ] Calculator no longer imports or uses `isWithinAccreditationDateRange` directly
- [ ] `validate.js` no longer contains inline date validation functions
- [ ] Existing behaviour preserved: rows outside accreditation period get `IGNORED`
- [ ] All existing tests pass (or are updated to reflect the new structure)
