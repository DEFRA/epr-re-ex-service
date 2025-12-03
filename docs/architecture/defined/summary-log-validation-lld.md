# Summary Log Validation: Low Level Design

This document describes the implementation approach for the validation layer in summary log processing, extending the transformation architecture defined in ADR 0019.

For the architectural decision and rationale for the transformation pipeline, see [ADR 19: Layered Transformation Strategy for Summary Log to Waste Records](../decisions/0019-waste-record-transformation-pipeline.md).

<!-- prettier-ignore-start -->
<!-- TOC -->
- [Summary Log Validation: Low Level Design](#summary-log-validation-low-level-design)
  - [Context](#context)
    - [Row classification alignment](#row-classification-alignment)
  - [Technical approach](#technical-approach)
    - [Validation layer in the pipeline](#validation-layer-in-the-pipeline)
    - [Schema registry structure](#schema-registry-structure)
    - [Table schema definition](#table-schema-definition)
    - [Row transformers](#row-transformers)
      - [Row transformer responsibilities](#row-transformer-responsibilities)
  - [Testing strategy](#testing-strategy)
    - [Dependency injection for testability](#dependency-injection-for-testability)
    - [Test categories](#test-categories)
  - [Open questions](#open-questions)
  - [Resolved questions](#resolved-questions)
<!-- TOC -->
<!-- prettier-ignore-end -->

## Context

ADR 0019 defines a four-layer transformation architecture for processing summary logs into waste records. It anticipated the need for a separate validation layer:

> "Possible enhancements: Separate validation layer if field validation becomes complex"

This design implements that validation layer using Joi schemas, with clean separation between:

- **Validation** (summary log schemas) - structural and data validation
- **Transformation** (row transformers) - mapping validated rows to waste records

### Row classification alignment

This design aligns with the [Summary Log Row Validation Classification](./summary-log-row-validation-classification.md) document, which defines three row outcomes:

| Outcome | Caused by | Effect |
|---------|-----------|--------|
| **REJECTED** | Fails VAL010 (validation of filled fields) | Blocks entire submission |
| **EXCLUDED** | Fails VAL011 (mandatory fields) or VAL013 (business rules) | Row submitted but excluded from Waste Balance |
| **INCLUDED** | Passes all validation | Contributes to Waste Balance |

The validation pipeline implements each decision point from the classification flowchart as a distinct schema or check.

## Technical approach

### Validation layer in the pipeline

The validation layer slots into ADR 0019's architecture, with each step mapping to a decision point in the classification flowchart:

| Step | Flowchart Decision | Schema/Config | Failure Outcome |
|------|-------------------|---------------|-----------------|
| 1. Filter to filled fields | Is field filled? | `unfilledValues` | - |
| 2. Validate filled fields | VAL010 | `validationSchema` | REJECTED |
| 3. Check mandatory fields | VAL011 | `mandatoryFields` | EXCLUDED |
| 4. Transform to waste record | - | Row transformer | - |
| 5. Apply business rules | VAL013 | Row transformer | EXCLUDED |
| 6. All pass | - | - | INCLUDED |

The validation pipeline:

```javascript
// Step 1: Filter to filled fields only
const filledFields = filterToFilled(row, tableSchema.unfilledValues)

// Step 2: VAL010 - Validate filled fields
const { error } = tableSchema.validationSchema.validate(filledFields)
if (error) return { outcome: 'REJECTED', issues: error.details }

// Step 3: VAL011 - Check mandatory fields are present
const missingMandatory = tableSchema.mandatoryFields.filter(
  field => !isFilled(row[field], tableSchema.unfilledValues[field])
)
if (missingMandatory.length > 0) return { outcome: 'EXCLUDED', issues: [...] }

// Steps 4-5: Transform and apply business rules (VAL013)
const { wasteRecord, issues } = transformRow(row, context)
if (issues.length > 0) return { outcome: 'EXCLUDED', issues }

// Step 6: All pass
return { outcome: 'INCLUDED', wasteRecord }
```

### Schema registry structure

Hierarchical folder structure organised by processing type:

```
src/domain/summary-log/
├── index.js                          # exports createDataSyntaxValidator, etc.
├── table-schemas/
│   ├── index.js                      # composes PROCESSING_TYPE_TABLES registry
│   ├── shared/
│   │   ├── joi-messages.js           # common validation message constants
│   │   └── row-id.schema.js          # ROW_ID failure schema factory
│   ├── reprocessor-input/
│   │   ├── index.js                  # TABLE_SCHEMAS for this type
│   │   ├── received-loads-for-reprocessing.js
│   │   ├── reprocessed-loads.js
│   │   └── sent-on-loads.js
│   ├── reprocessor-output/
│   │   ├── index.js
│   │   ├── received-loads-for-reprocessing.js  # may differ from input
│   │   ├── reprocessed-loads.js                 # has extra UK % fields
│   │   └── sent-on-loads.js
│   └── exporter/
│       ├── index.js
│       ├── received-loads-for-export.js        # 50+ columns, export-specific
│       └── sent-on-loads.js
└── validation/
    ├── data-syntax.js
    └── ... other validation logic
```

Processing type index files compose tables into a registry:

```javascript
// reprocessor-input/index.js
import { RECEIVED_LOADS_FOR_REPROCESSING } from './received-loads-for-reprocessing.js'
import { REPROCESSED_LOADS } from './reprocessed-loads.js'
import { SENT_ON_LOADS } from './sent-on-loads.js'

export const TABLE_SCHEMAS = {
  RECEIVED_LOADS_FOR_REPROCESSING,
  REPROCESSED_LOADS,
  SENT_ON_LOADS
}
```

Top-level index composes the full registry:

```javascript
// table-schemas/index.js
import { TABLE_SCHEMAS as REPROCESSOR_INPUT } from './reprocessor-input/index.js'
import { TABLE_SCHEMAS as REPROCESSOR_OUTPUT } from './reprocessor-output/index.js'
import { TABLE_SCHEMAS as EXPORTER } from './exporter/index.js'

export const PROCESSING_TYPE_TABLES = {
  REPROCESSOR_INPUT,
  REPROCESSOR_OUTPUT,
  EXPORTER
}
```

### Table schema definition

Each table schema file exports:

```javascript
export const RECEIVED_LOADS_FOR_REPROCESSING = {
  rowIdField: 'ROW_ID',
  requiredHeaders: ['ROW_ID', 'SITE_ADDRESS', ...],

  // Step 1: Define what "unfilled" means per field
  // Fields not listed use default empty check (null, undefined, '')
  unfilledValues: {
    MATERIAL_TYPE: ['Please select...'],      // dropdown with placeholder
    PROCESSING_COUNTRY: ['-- Select --'],     // dropdown with placeholder
  },

  // Step 2: VAL010 - Validation schema (applied to filled fields only)
  // All fields optional - only filled fields are validated
  // Any failure → REJECTED (blocks submission)
  validationSchema: Joi.object({
    ROW_ID: Joi.number().integer().min(10000).optional(),
    SITE_ADDRESS: Joi.string().max(255).optional(),
    MATERIAL_TYPE: Joi.string().valid('Paper', 'Plastic', 'Glass').optional(),
    LOAD_DATE: Joi.date().optional(),
    // ...
  }),

  // Step 3: VAL011 - Mandatory fields
  // Missing → EXCLUDED (from Waste Balance, but still submitted)
  mandatoryFields: ['ROW_ID', 'LOAD_DATE', 'MATERIAL_TYPE']
}
```

**Schema components:**

| Component | Purpose | Failure Outcome |
|-----------|---------|-----------------|
| `unfilledValues` | Defines per-field "unfilled" sentinel values beyond the default empty check | - |
| `validationSchema` | VAL010 - Joi schema applied to filled fields only. All fields marked optional. | REJECTED |
| `mandatoryFields` | VAL011 - List of fields that must be filled for the row to contribute to Waste Balance | EXCLUDED |

**Note:** VAL013 (business rules like accreditation date range) are applied in the row transformer, not the table schema. This keeps the schema focused on field-level validation while business rules that require external context (e.g. accreditation period) live in the transformation layer.

### Row transformers

Per ADR 0019, row transformers live alongside the sync/transformation code:

```
src/domain/summary-log/
├── table-schemas/           # validation (this design)
│   └── ...
├── sync/
│   ├── sync-from-summary-log.js
│   └── row-transformers/    # transformation (ADR 0019)
│       ├── received-loads-for-reprocessing.js
│       ├── reprocessed-loads.js
│       ├── sent-on-loads.js
│       └── received-loads-for-export.js
└── ...
```

ADR 0019 defines a parallel `PROCESSING_TYPES` dispatch map for transformers:

```javascript
const PROCESSING_TYPES = {
  REPROCESSOR_INPUT: {
    RECEIVED_LOADS_FOR_REPROCESSING: transformReceivedLoadsRow,
    REPROCESSED_LOADS: transformReprocessedLoadsRow,
    SENT_ON_LOADS: transformSentOnLoadsRow
  },
  // ... same structure as schema registry
}
```

The same table name can have different transformers for different processing types (e.g. `SENT_ON_LOADS` for EXPORTER vs REPROCESSOR_INPUT).

#### Row transformer responsibilities

With the table schema now handling VAL010 (validation) and VAL011 (mandatory fields), row transformers focus on:

1. **Transformation** - mapping validated row data to waste record structure
2. **VAL013 business rules** - validation requiring external context (e.g. accreditation period)

Row transformers receive context and return issues rather than throwing:

```javascript
/**
 * @param {Record<string, any>} rowData - Validated row data
 * @param {Object} context - External context (accreditation dates, etc.)
 * @returns {{ wasteRecord: Object, issues: Array }}
 */
export const transformReceivedLoadsRow = (rowData, context) => {
  const issues = []

  // VAL013: Check load date within accreditation period
  if (context.accreditation) {
    const loadDate = new Date(rowData.LOAD_DATE)
    if (loadDate < context.accreditation.startDate ||
        loadDate > context.accreditation.endDate) {
      issues.push({
        code: 'LOAD_DATE_OUTSIDE_ACCREDITATION',
        field: 'LOAD_DATE',
        actual: rowData.LOAD_DATE
      })
    }
  }

  return {
    wasteRecord: {
      wasteRecordType: WASTE_RECORD_TYPE.RECEIVED,
      rowId: rowData.ROW_ID,
      data: rowData
    },
    issues  // Non-empty issues → EXCLUDED
  }
}
```

## Testing strategy

### Dependency injection for testability

Unit tests should define minimal test schemas rather than using production schemas. The composition root injects the production registry:

```javascript
// validate.js (composition root)
import { PROCESSING_TYPE_TABLES } from './table-schemas/index.js'

export const createSummaryLogsValidator = ({ ... }) => {
  const validateDataSyntax = createDataSyntaxValidator(PROCESSING_TYPE_TABLES)
  // ...
}
```

Unit tests inject minimal test registries:

```javascript
// validation.test.js
const TEST_SCHEMAS = {
  TEST_PROCESSING_TYPE: {
    TEST_TABLE: {
      rowIdField: 'ROW_ID',
      requiredHeaders: ['ROW_ID', 'TEXT_FIELD', 'DROPDOWN_FIELD'],
      unfilledValues: {
        DROPDOWN_FIELD: ['Please select...']
      },
      validationSchema: Joi.object({
        ROW_ID: Joi.number().min(10000).optional(),
        TEXT_FIELD: Joi.string().max(100).optional(),
        DROPDOWN_FIELD: Joi.string().valid('Option A', 'Option B').optional()
      }),
      mandatoryFields: ['ROW_ID', 'TEXT_FIELD']
    }
  }
}

const validateRow = createRowValidator(TEST_SCHEMAS)
```

**Benefits:**

- **Simpler tests** - 2-3 field schemas vs 12+ column production schemas
- **Focused tests** - each test exercises specific behaviour
- **Schema independence** - production schema changes don't break unit tests
- **Clarity** - test data shows exactly what's being tested

### Test categories

| Category | Registry | Purpose |
|----------|----------|---------|
| Unit tests | Minimal test schemas | Test validation logic in isolation |
| Integration tests | Production schemas | Verify real schemas work correctly end-to-end |

## Open questions

1. **Schema reuse** - REPROCESSOR_INPUT and REPROCESSOR_OUTPUT currently identical for some tables. Share or duplicate?
2. **Required headers** - Should header validation be a separate phase or part of data-syntax validation?
3. **Registry unification** - Should `PROCESSING_TYPE_TABLES` (schemas) and `PROCESSING_TYPES` (transformers) be unified into a single registry per table?
4. **Unfilled value specifics** - What are the actual placeholder values used in Excel dropdowns (e.g. "Please select...", "-- Select --")? These need to be captured in `unfilledValues` for each field.
5. **Row transformer responsibilities** - Row transformers currently handle both transformation (mapping to waste record) and VAL013 validation (business rules). Should these be separated? Options:
   - Keep together if business rules are simple and tightly coupled to transformation
   - Separate into a `businessRulesValidator` and pure transformer if rules become complex
   - Move business rules to a schema in the table definition if they don't need external context

## Resolved questions

1. **Terminology alignment** - Resolved: Use REJECTED/EXCLUDED/INCLUDED terminology from the classification document. The `loads` API response should use `included`/`excluded` rather than `valid`/`invalid`.
2. **Schema structure** - Resolved: Replace `failure`/`concern` schemas with `unfilledValues`, `validationSchema`, and `mandatoryFields` to match the flowchart decision points.
3. **Business rules location** - Resolved: VAL013 business rules (e.g. accreditation date range) live in row transformers, not table schemas, since they require external context.
